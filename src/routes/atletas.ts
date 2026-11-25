import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  distanciaClassFit,
  situacaoAltura,
  funcaoNaClasse,
  idadeEm,
  motivoSemPeso,
  INDICADOR_DO_NIVEL,
  NIVEIS_DE_NOTA,
  explicacaoDaNota,
  notaDaColocacao,
  notaPeso,
  nivelDeNota,
  sugerirPlano,
} from "../domain/index.js";
import type { NivelDeNota } from "../domain/index.js";
import { esquemaErro, naoEncontrado, semAcesso } from "../erros.js";
import { historicoDeNotas, historicoDePesagens } from "../repositories/historico.js";
import { ehSugestao } from "../repositories/origens.js";
import { buscarAtletaVisivel, carregarDadosAtletas, cicloAberto } from "../repositories/atletas.js";
import { lerContatoSensivel } from "../repositories/contato-sensivel.js";
import { ultimoLancamento } from "../repositories/investimento.js";
import { carregarParametros } from "../repositories/parametros.js";
import { buscarPlanoAtual } from "../repositories/plano.js";
import { esquemaAptidao } from "./aptidao.js";
import { esquemaResultadoDetalhe } from "./esquemas-resultado.js";
import { esquemaPlanoRegistrado, esquemaTextosPlano } from "./plano.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";
import { caminhoDaFotoDoAtleta, linkDaFoto } from "../servicos/foto-perfil.js";

const NOMES_GATES: Record<number, string> = {
  1: "Class Fit",
  2: "Evidência competitiva",
  3: "Alto rendimento",
  4: "Campanha",
};

const statusGate = z.enum(["apto", "condicional", "alerta"]);
const pessoa = z.object({ id: z.string(), nome: z.string() });

const esquemaIndicador = z.object({
  id: z.string(),
  nome: z.string(),
  tipo: z.enum(["T", "A", "R"]),
  calculado: z.boolean(),
  nota: z.number().nullable(),
  evidencia: z
    .string()
    .nullable()
    .describe(
      "Texto da evidência; nulo se a nota não tem (indicador com evidência opcional) e sempre nulo para o IBVAR",
    ),
  link: z
    .string()
    .nullable()
    .describe("Link https de vídeo ou outro conteúdo externo da nota; nulo para o IBVAR"),
  origem: z
    .enum(["avaliacao", "resposta_confirmada", "autoavaliacao_aprovada", "calculado"])
    .nullable()
    .describe(
      "autoavaliacao_aprovada: o treinador manteve a nota sugerida pelo atleta. Para o IBVAR vem sempre `avaliacao` (nada de autoavaliação)",
    ),
  justificativa: z
    .string()
    .nullable()
    .describe(
      "Justificativa do treinador ao corrigir a sugestão do atleta; sempre nula para o IBVAR",
    ),
  avaliador: pessoa.nullable(),
  lancadoEm: z.string().nullable().describe("Instante ISO"),
  resposta: z.string().nullable(),
  sugestaoPendente: z
    .object({ valor: z.number().int(), lancadoEm: z.string() })
    .nullable()
    .describe(
      "Sugestão do atleta (resposta do questionário ou autoavaliação) ainda sem nota do treinador; nula para o IBVAR. O detalhe da autoavaliação vem em GET /atletas/:id/autoavaliacao",
    ),
  explicacao: z
    .string()
    .nullable()
    .describe(
      "Só nos indicadores de resultado (perf_mundial, perf_continental, perf_nacional): de onde veio a nota calculada, em texto. Sem resultado validado no nível, a nota vale `sem_resultado` (0) e o texto diz isso",
    ),
  resultado: z
    .object({
      nivel: z.enum(["mundial", "continental", "nacional"]),
      posicao: z.number().int().describe("Melhor colocação validada que definiu a nota"),
      edicao: z.number().int().describe("Ano da edição dessa colocação"),
      evento: z.string(),
    })
    .nullable()
    .describe(
      "Os dados de `explicacao`, para a tela montar o texto; nulo fora dos indicadores de resultado",
    ),
  anexo: z.object({ id: z.string(), nomeArquivo: z.string() }).nullable(),
});

const esquemaFicha = z.object({
  atleta: z.object({
    id: z.string(),
    nome: z.string(),
    wsId: z.string().describe("ID World Sailing; o IBVAR só vê atleta que consentiu"),
    velaid: z.string().nullable().describe("Nulo se o atleta não tem VelaID"),
    numeroVela: z.string().nullable(),
    genero: z.enum(["F", "M"]),
    idade: z.number().int(),
    funcao: z.string(),
    clube: z.string().nullable(),
    cidade: z.string().nullable(),
    uf: z.string().nullable(),
    fotoUrl: z
      .string()
      .nullable()
      .describe("Link assinado curto da foto da conta do atleta; sempre nulo para o IBVAR"),
    termoAceito: z.boolean(),
    classe: z.object({
      id: z.string(),
      nome: z.string(),
      evento: z.string(),
      posicao: z.enum(["helm", "crew", "ind"]),
    }),
  }),
  contato: z
    .object({
      email: z.string().nullable(),
      treinador: pessoa.nullable(),
      telefone: z.string().nullable().describe("E.164 (+5511999998888); nulo se não informado"),
      passaporteValidoAte: z
        .string()
        .nullable()
        .describe("AAAA-MM (último dia do mês); sem número nem cópia do passaporte"),
      aptidao: esquemaAptidao
        .nullable()
        .describe(
          "Última aptidão conferida pelo gestor (dado de saúde; cada leitura de gestor ou treinador é auditada); nulo se nunca conferida",
        ),
    })
    .nullable()
    .describe("Nulo para o IBVAR: contato, passaporte e aptidão não são dele (matriz de acesso)"),
  ciclo: z.object({ nome: z.string(), prazo: z.string() }).nullable(),
  dadosAtualizadosEm: z
    .string()
    .nullable()
    .describe(
      "Instante ISO do último lançamento deste atleta que muda score ou gates (avaliações, medidas, resultados, decisões de gate e financeiro); nulo se não houver",
    ),
  score: z.number(),
  faixa: z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string() }),
  completo: z.boolean(),
  preenchidos: z.number().int(),
  total: z.number().int(),
  pontosCbvela: z.number(),
  historicoScore: z.array(z.object({ ciclo: z.string(), score: z.number() })),
  pilares: z.array(
    z.object({
      id: z.string(),
      nome: z.string(),
      nomeCurto: z.string(),
      peso: z.number(),
      nota: z.number().nullable(),
      contribuicao: z.number(),
      preenchidos: z.number().int(),
      total: z.number().int(),
      restrito: z.boolean().describe("Detalhe oculto para este papel (só a nota do pilar)"),
      indicadores: z.array(esquemaIndicador).nullable(),
    }),
  ),
  gates: z.object({
    statusFinal: z.enum(["apto", "condicional", "nao_prioritario"]),
    itens: z.array(
      z.object({
        gate: z.number().int(),
        nome: z.string(),
        status: statusGate,
        motivo: z.string(),
        sugestaoAutomatica: statusGate,
        ajustadoPeloGestor: z.boolean(),
      }),
    ),
  }),
  classFit: z
    .object({
      pesoKg: z.number(),
      alturaCm: z.number().nullable(),
      pesoMinKg: z.number(),
      pesoMedioKg: z.number(),
      pesoMaxKg: z.number(),
      deltaKg: z.number(),
      distanciaRelativa: z.number(),
      altura: z
        .object({
          cm: z.number().nullable().describe("Altura do atleta; nula se não medida"),
          minCm: z
            .number()
            .nullable()
            .describe("Faixa de referência da classe; nula se não definida"),
          mediaCm: z.number().nullable(),
          maxCm: z.number().nullable(),
          situacao: z
            .enum(["dentro", "abaixo", "acima"])
            .nullable()
            .describe(
              "Nula se faltar a altura ou a faixa. Só informativa: não entra no score nem nos gates",
            ),
        })
        .describe("Altura de referência da classe. O IBVAR não recebe (classFit inteiro nulo)"),
    })
    .nullable(),
  resultados: z
    .array(esquemaResultadoDetalhe)
    .describe(
      "Todos os resultados do atleta, com a situação de cada um. O IBVAR recebe só os validados, sem anexo, motivo nem quem validou. Só os validados entram na nota e nos gates",
    ),
  financeiro: z
    .union([
      z.object({
        perfilSuporte: z.enum(["A", "B", "C", "D"]),
        mesesAssegurados: z.number().int().nullable(),
        patrocinioPrivado: z.enum(["sim", "em_negociacao", "nao"]).nullable(),
        componentes: z.array(
          z.object({
            id: z.string(),
            nome: z.string(),
            autonomia: z.string(),
            apoioCbvela: z.string(),
          }),
        ),
      }),
      z.object({ perfilSuporte: z.enum(["A", "B", "C", "D"]) }),
    ])
    .nullable(),
  plano: esquemaPlanoRegistrado
    .nullable()
    .describe("Plano registrado por uma pessoa. Nulo para o IBVAR ou sem plano."),
  sugestaoPlano: esquemaTextosPlano
    .nullable()
    .describe("Sugestão calculada pelo sistema. Nula para o IBVAR."),
});

export async function rotasAtletas(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/atletas/:id",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["atletas"],
        summary: "Ficha do atleta, conforme a matriz de acesso do papel",
        description:
          "`dadosAtualizadosEm` é o último lançamento do próprio atleta; o IBVAR só chega à ficha de quem consentiu. Atleta fora do acesso do usuário e atleta inexistente dão o mesmo 404; atleta com cadastro incompleto também dá 404 (o próprio atleta lê a sugestão em GET /me). IBVAR: só vê quem consentiu E está dentro do piloto (mesma regra do ranking: aceite do termo, que segue TERMO_EXIGE_REACEITE); fora do piloto dá 404, também no histórico do indicador. Gestor, treinador e o próprio atleta mantêm o acesso. IBVAR: sem indicadores sensíveis, Class Fit, contato, financeiro detalhado nem texto de evidência; o motivo do gate G1 vem genérico, sem a diferença em kg.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        response: {
          200: esquemaFicha,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      const [parametros, ciclo] = await Promise.all([
        carregarParametros(app.db),
        cicloAberto(app.db),
      ]);
      const [avaliado] = await carregarEAvaliarAtletas(app.db, parametros, [base], referencia, {
        componentesFinanceiro: usuario.papel === "gestor" || usuario.papel === "atleta",
        historico: true,
        resultadosParaIbvar: usuario.papel === "ibvar",
      });
      if (!avaliado) throw naoEncontrado("Atleta não encontrado.");
      const { atleta, dados, calculo } = avaliado;

      const ibvar = usuario.papel === "ibvar";
      const sensivel = await lerContatoSensivel(app.db, usuario, atleta.id, referencia);
      const fotoUrl = ibvar
        ? null
        : await linkDaFoto(
            app.armazenamento,
            await caminhoDaFotoDoAtleta(app.db, atleta.id),
            req.log,
          );
      const notaPorIndicador = new Map(dados.notas.map((n) => [n.indicadorId, n]));
      const pilaresCalc = new Map(calculo.pilares.map((p) => [p.pilarId, p]));
      const nivelDoIndicador = new Map<string, NivelDeNota>(
        NIVEIS_DE_NOTA.map((n) => [INDICADOR_DO_NIVEL[n], n]),
      );

      const pilares = parametros.pilares.map((p) => {
        const c = pilaresCalc.get(p.id)!;
        const restrito = ibvar && p.sensivel;
        const indicadores = restrito
          ? null
          : p.indicadores.map((i) => {
              const nota = calculo.notas[i.id] ?? null;
              const lancada = notaPorIndicador.get(i.id);
              const sug = dados.sugestoesPendentes[i.id] ?? null;
              const base = { id: i.id, nome: i.nome, tipo: i.tipo, calculado: i.calculado };
              const nivelResultado = nivelDoIndicador.get(i.id);
              if (i.calculado && nivelResultado) {
                // Nota derivada dos resultados validados: a explicação diz qual resultado a definiu.
                const origem = calculo.notasResultados[nivelResultado];
                return {
                  ...base,
                  nota,
                  evidencia: null,
                  link: null,
                  origem: nota == null ? null : ("calculado" as const),
                  justificativa: null,
                  avaliador: null,
                  lancadoEm: null,
                  resposta: null,
                  sugestaoPendente: null,
                  explicacao: explicacaoDaNota(origem, parametros.regras.perfResultados.edicoesMax),
                  resultado:
                    origem.posicao !== null && origem.edicao !== null && origem.evento !== null
                      ? {
                          nivel: origem.nivel,
                          posicao: origem.posicao,
                          edicao: origem.edicao,
                          evento: origem.evento,
                        }
                      : null,
                  anexo: null,
                };
              }
              if (i.calculado) {
                // Nota derivada do peso: a evidência vem da pesagem.
                const m = dados.medida;
                return {
                  ...base,
                  nota,
                  // IBVAR não recebe texto de evidência (pode citar a pesagem).
                  evidencia: ibvar || nota == null ? null : m.pesoEvidencia,
                  link: null,
                  origem: nota == null ? null : ("calculado" as const),
                  justificativa: null,
                  avaliador: nota == null ? null : m.pesoRegistradoPor,
                  lancadoEm: nota == null ? null : m.pesoMedidoEm,
                  resposta: dados.respostas[i.id] ?? null,
                  sugestaoPendente: null,
                  explicacao: null,
                  resultado: null,
                  anexo: null,
                };
              }
              return {
                ...base,
                nota,
                evidencia: ibvar ? null : (lancada?.evidencia ?? null),
                link: ibvar ? null : (lancada?.link ?? null),
                // IBVAR não sabe que houve autoavaliação: a aprovação aparece como nota comum.
                origem:
                  ibvar && lancada?.origem === "autoavaliacao_aprovada"
                    ? ("avaliacao" as const)
                    : (lancada?.origem ?? null),
                justificativa: ibvar ? null : (lancada?.justificativa ?? null),
                // IBVAR não recebe quem avaliou (seria o treinador) nem a resposta do atleta.
                avaliador: ibvar ? null : (lancada?.avaliador ?? null),
                lancadoEm: lancada?.lancadoEm ?? null,
                resposta: ibvar ? null : (dados.respostas[i.id] ?? null),
                sugestaoPendente: ibvar ? null : sug,
                explicacao: null,
                resultado: null,
                // O IBVAR não vê evidências anexadas.
                anexo: ibvar ? null : (lancada?.anexo ?? null),
              };
            });
        return {
          id: p.id,
          nome: p.nome,
          nomeCurto: p.nomeCurto,
          peso: p.peso,
          nota: c.nota,
          contribuicao: c.contribuicao,
          preenchidos: c.preenchidos,
          total: c.total,
          restrito,
          indicadores,
        };
      });

      const classFit =
        ibvar || !calculo.classFit || dados.medida.pesoKg == null
          ? null
          : {
              pesoKg: dados.medida.pesoKg,
              alturaCm: dados.medida.alturaCm,
              pesoMinKg: atleta.classe.pesoMinKg,
              pesoMedioKg: atleta.classe.pesoMedioKg,
              pesoMaxKg: atleta.classe.pesoMaxKg,
              deltaKg: calculo.classFit.deltaKg,
              distanciaRelativa: calculo.classFit.distanciaRelativa,
              altura: {
                cm: dados.medida.alturaCm,
                minCm: atleta.classe.alturaMinCm,
                mediaCm: atleta.classe.alturaMediaCm,
                maxCm: atleta.classe.alturaMaxCm,
                situacao: situacaoAltura(
                  dados.medida.alturaCm,
                  atleta.classe.alturaMinCm === null || atleta.classe.alturaMaxCm === null
                    ? null
                    : { minCm: atleta.classe.alturaMinCm, maxCm: atleta.classe.alturaMaxCm },
                ),
              },
            };

      const fin = dados.financeiro;
      const financeiro = !fin
        ? null
        : usuario.papel === "gestor" || usuario.papel === "atleta"
          ? {
              perfilSuporte: fin.perfilSuporte,
              mesesAssegurados: fin.mesesAssegurados,
              patrocinioPrivado: fin.patrocinioPrivado,
              componentes: fin.componentes,
            }
          : ibvar
            ? { perfilSuporte: fin.perfilSuporte }
            : null;

      // O IBVAR não vê plano individual (nem a sugestão).
      const plano = ibvar ? null : await buscarPlanoAtual(app.db, atleta.id);
      const sugestaoPlano = ibvar
        ? null
        : sugerirPlano({
            pilares: parametros.pilares.map((p) => ({
              nome: p.nome,
              nota: pilaresCalc.get(p.id)?.nota ?? null,
            })),
            temResultadoMundial: dados.resultados.some(
              (r) => r.status === "validado" && r.nivel === "mundial",
            ),
            statusFinal: calculo.statusFinal,
            gatesNaoAptos: calculo.gates
              .filter((g) => g.status !== "apto")
              .map((g) => NOMES_GATES[g.gate] ?? `G${g.gate}`),
            perfilSuporte: dados.financeiro?.perfilSuporte ?? null,
            faixaNome: calculo.faixa.nome,
          });

      return {
        atleta: {
          id: atleta.id,
          nome: atleta.nome,
          wsId: atleta.wsId,
          velaid: atleta.velaid,
          numeroVela: atleta.numeroVela,
          genero: atleta.genero,
          idade: idadeEm(atleta.dataNascimento, referencia),
          funcao: funcaoNaClasse(atleta.classe.posicao, atleta.genero),
          clube: atleta.clube,
          cidade: atleta.cidade,
          uf: atleta.uf,
          fotoUrl,
          termoAceito: atleta.termoAceito,
          classe: {
            id: atleta.classe.id,
            nome: atleta.classe.nome,
            evento: atleta.classe.evento,
            posicao: atleta.classe.posicao,
          },
        },
        contato: sensivel
          ? { email: atleta.emailContato, treinador: atleta.treinador, ...sensivel }
          : null,
        ciclo,
        dadosAtualizadosEm: await ultimoLancamento(app.db, [atleta.id]),
        score: calculo.score,
        faixa: {
          id: calculo.faixa.id,
          nome: calculo.faixa.nome,
          nomeCurto: calculo.faixa.nomeCurto,
        },
        completo: calculo.completo,
        preenchidos: calculo.preenchidos,
        total: calculo.total,
        pontosCbvela: calculo.pontosCbvela,
        historicoScore: dados.historicoScore,
        pilares,
        gates: {
          statusFinal: calculo.statusFinal,
          itens: calculo.gates.map((g) => ({
            gate: g.gate,
            nome: NOMES_GATES[g.gate] ?? `G${g.gate}`,
            status: g.status,
            // IBVAR não recebe a diferença em kg do G1 (daria para deduzir o peso).
            motivo: ibvar ? motivoSemPeso(g) : g.motivo,
            sugestaoAutomatica: g.sugestaoAutomatica,
            ajustadoPeloGestor: g.ajustadoPeloGestor,
          })),
        },
        classFit,
        resultados: dados.resultados,
        financeiro,
        plano,
        sugestaoPlano,
      };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/atletas/:id/indicadores/:indicadorId/historico",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["atletas"],
        summary: "Histórico de lançamentos de um indicador, do mais novo para o mais antigo",
        description:
          "Mesma matriz de acesso da ficha: gestor vê todos, treinador só os próprios atletas, atleta só a si. Inclui a sugestão do atleta ainda pendente (pendente: true, origem resposta_sugerida ou autoavaliacao) e a justificativa da nota do treinador. cf_peso_kg (calculado) traz as pesagens, com a nota pela regra P3 atual; perf_mundial, perf_continental e perf_nacional (calculados) trazem um item por resultado validado do nível, com a nota que a colocação daria pela regra PERF_RESULTADOS atual (só as últimas `edicoes_max` edições entram na nota do indicador). IBVAR: pilar sensível dá 403; nos demais, sem evidência, avaliador, anexo, justificativa nem sugestão pendente (a aprovação aparece como `avaliacao`). Atleta fora do acesso ou indicador inexistente: 404.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid(), indicadorId: z.string().min(1).max(64) }),
        response: {
          200: z.array(
            z.object({
              valor: z.number().describe("Nota de 0 a 5"),
              pesoKg: z.number().nullable().describe("Só em cf_peso_kg: o peso da pesagem"),
              evidencia: z.string().nullable(),
              link: z.string().nullable().describe("Link https da nota; nulo para o IBVAR"),
              origem: z.enum([
                "avaliacao",
                "resposta_confirmada",
                "resposta_sugerida",
                "autoavaliacao",
                "autoavaliacao_aprovada",
                "calculado",
              ]),
              justificativa: z
                .string()
                .nullable()
                .describe("Justificativa do treinador ao corrigir a sugestão; nula para o IBVAR"),
              pendente: z.boolean().describe("Sugestão do atleta aguardando o avaliador"),
              avaliador: pessoa.nullable(),
              cicloNome: z.string().nullable(),
              lancadoEm: z.string().describe("Instante ISO"),
              anexo: z.object({ id: z.string(), nomeArquivo: z.string() }).nullable(),
            }),
          ),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      const pilar = parametros.pilares.find((p) =>
        p.indicadores.some((i) => i.id === req.params.indicadorId),
      );
      const indicador = pilar?.indicadores.find((i) => i.id === req.params.indicadorId);
      if (!pilar || !indicador) throw naoEncontrado("Indicador não encontrado.");

      const ibvar = usuario.papel === "ibvar";
      if (ibvar && pilar.sensivel) throw semAcesso("O IBVAR não vê o detalhe deste pilar.");

      if (indicador.calculado) {
        const nivel = NIVEIS_DE_NOTA.find((n) => INDICADOR_DO_NIVEL[n] === indicador.id);
        if (nivel) {
          // Indicador de resultado: um item por resultado validado do nível, com a nota que ele daria.
          const dados = (
            await carregarDadosAtletas(app.db, [base.id], { resultadosParaIbvar: ibvar })
          ).get(base.id);
          return (dados?.resultados ?? [])
            .filter((r) => r.status === "validado" && nivelDeNota(r.nivel) === nivel)
            .map((r) => ({
              valor: notaDaColocacao(r.posicao, parametros.regras.perfResultados.niveis[nivel]),
              pesoKg: null,
              evidencia: ibvar ? null : `${r.posicao}º em ${r.evento} (${r.edicao})`,
              link: ibvar ? null : r.linkOficial,
              origem: "calculado" as const,
              justificativa: null,
              pendente: false,
              avaliador: ibvar ? null : r.validadoPor,
              cicloNome: null,
              lancadoEm: r.validadoEm ?? r.registradoEm,
              anexo: ibvar ? null : r.anexo,
            }))
            .sort((a, b) => b.lancadoEm.localeCompare(a.lancadoEm));
        }
        if (indicador.id !== "cf_peso_kg") return [];
        const pesagens = await historicoDePesagens(app.db, base.id);
        return pesagens.map((m) => ({
          valor: notaPeso(
            distanciaClassFit(m.pesoKg, base.classe).distanciaRelativa,
            parametros.regras.p3.limites,
          ),
          pesoKg: m.pesoKg,
          evidencia: m.evidencia,
          link: null,
          origem: "calculado" as const,
          justificativa: null,
          pendente: false,
          avaliador: m.registradoPor,
          cicloNome: null,
          lancadoEm: m.medidoEm,
          anexo: null,
        }));
      }

      const notas = await historicoDeNotas(app.db, base.id, indicador.id);
      return notas
        .filter((n) => !(ibvar && ehSugestao(n.origem)))
        .map((n) => ({
          valor: n.valor,
          pesoKg: null,
          // IBVAR: sem evidência, sem quem avaliou e sem anexo (como na ficha).
          evidencia: ibvar ? null : n.evidencia,
          link: ibvar ? null : n.link,
          origem:
            ibvar && n.origem === "autoavaliacao_aprovada" ? ("avaliacao" as const) : n.origem,
          justificativa: ibvar ? null : n.justificativa,
          pendente: ehSugestao(n.origem),
          avaliador: ibvar ? null : n.avaliador,
          cicloNome: n.cicloNome,
          lancadoEm: n.lancadoEm,
          anexo: ibvar ? null : n.anexo,
        }));
    },
  );
}

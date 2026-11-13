import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  INDICADOR_PONTOS_RANKING,
  distanciaClassFit,
  funcaoNaClasse,
  idadeEm,
  notaPeso,
  notaSugeridaPorPontos,
  sugerirPlano,
} from "../domain/index.js";
import { esquemaErro, naoEncontrado, semAcesso } from "../erros.js";
import { historicoDeNotas, historicoDePesagens } from "../repositories/historico.js";
import { buscarAtletaVisivel, cicloAberto } from "../repositories/atletas.js";
import { carregarParametros } from "../repositories/parametros.js";
import { buscarPlanoAtual } from "../repositories/plano.js";
import { esquemaPlanoRegistrado, esquemaTextosPlano } from "./plano.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const NOMES_GATES: Record<number, string> = {
  1: "Class Fit",
  2: "Evidência competitiva",
  3: "Alto rendimento",
  4: "Campanha",
};

const statusGate = z.enum(["apto", "condicional", "alerta"]);
const pessoa = z.object({ id: z.string(), nome: z.string() });

export const esquemaSugestaoPontos = z.object({
  nota: z.number().int(),
  pontos: z.number().describe("Pontos do Ranking CBVela na janela"),
});

const esquemaIndicador = z.object({
  id: z.string(),
  nome: z.string(),
  tipo: z.enum(["T", "A", "R"]),
  calculado: z.boolean(),
  nota: z.number().nullable(),
  evidencia: z.string().nullable(),
  origem: z.enum(["avaliacao", "resposta_confirmada", "calculado"]).nullable(),
  avaliador: pessoa.nullable(),
  lancadoEm: z.string().nullable().describe("Instante ISO"),
  resposta: z.string().nullable(),
  sugestaoPendente: z.object({ valor: z.number().int(), lancadoEm: z.string() }).nullable(),
  sugestaoPontos: esquemaSugestaoPontos
    .nullable()
    .describe(
      "Nota sugerida pelos pontos do Ranking CBVela (regra PERF_PONTOS). Só em perf_nacional e com a regra ativa; não entra no score até o avaliador lançar a nota.",
    ),
  anexo: z.object({ id: z.string(), nomeArquivo: z.string() }).nullable(),
});

const esquemaFicha = z.object({
  atleta: z.object({
    id: z.string(),
    nome: z.string(),
    velaid: z.string(),
    numeroVela: z.string().nullable(),
    genero: z.enum(["F", "M"]),
    idade: z.number().int(),
    funcao: z.string(),
    clube: z.string().nullable(),
    cidade: z.string().nullable(),
    uf: z.string().nullable(),
    termoAceito: z.boolean(),
    classe: z.object({
      id: z.string(),
      nome: z.string(),
      evento: z.string(),
      posicao: z.enum(["helm", "crew", "ind"]),
    }),
  }),
  contato: z.object({ email: z.string().nullable(), treinador: pessoa.nullable() }).nullable(),
  ciclo: z.object({ nome: z.string(), prazo: z.string() }).nullable(),
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
    })
    .nullable(),
  resultados: z.array(
    z.object({
      data: z.string(),
      nivel: z.string(),
      evento: z.string(),
      posicao: z.number().int(),
      tamanhoFrota: z.number().int(),
      internacional: z.boolean(),
      pontosCbvela: z.number().nullable(),
      fonte: z.enum(["ranking_cbvela", "manual"]),
      linkOficial: z.string().nullable(),
    }),
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
          "Atleta fora do acesso do usuário e atleta inexistente dão o mesmo 404. IBVAR: sem indicadores sensíveis, Class Fit, contato e financeiro detalhado.",
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
      });
      if (!avaliado) throw naoEncontrado("Atleta não encontrado.");
      const { atleta, dados, calculo } = avaliado;

      const ibvar = usuario.papel === "ibvar";
      const notaPorIndicador = new Map(dados.notas.map((n) => [n.indicadorId, n]));
      const pilaresCalc = new Map(calculo.pilares.map((p) => [p.pilarId, p]));
      // Só sugestão: não entra no score até o avaliador lançar a nota.
      const sugestaoPontos = notaSugeridaPorPontos(
        calculo.pontosCbvela,
        parametros.regras.perfPontos,
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
              if (i.calculado) {
                // Nota derivada do peso: a evidência vem da pesagem.
                const m = dados.medida;
                return {
                  ...base,
                  nota,
                  evidencia: nota == null ? null : m.pesoEvidencia,
                  origem: nota == null ? null : ("calculado" as const),
                  avaliador: nota == null ? null : m.pesoRegistradoPor,
                  lancadoEm: nota == null ? null : m.pesoMedidoEm,
                  resposta: dados.respostas[i.id] ?? null,
                  sugestaoPendente: null,
                  sugestaoPontos: null,
                  anexo: null,
                };
              }
              return {
                ...base,
                nota,
                evidencia: lancada?.evidencia ?? null,
                origem: lancada?.origem ?? null,
                // IBVAR não recebe quem avaliou (seria o treinador) nem a resposta do atleta.
                avaliador: ibvar ? null : (lancada?.avaliador ?? null),
                lancadoEm: lancada?.lancadoEm ?? null,
                resposta: ibvar ? null : (dados.respostas[i.id] ?? null),
                sugestaoPendente: ibvar ? null : sug,
                sugestaoPontos: i.id === INDICADOR_PONTOS_RANKING ? sugestaoPontos : null,
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
            temResultadoMundial: dados.resultados.some((r) => r.nivel === "mundial"),
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
          velaid: atleta.velaid,
          numeroVela: atleta.numeroVela,
          genero: atleta.genero,
          idade: idadeEm(atleta.dataNascimento, referencia),
          funcao: funcaoNaClasse(atleta.classe.posicao, atleta.genero),
          clube: atleta.clube,
          cidade: atleta.cidade,
          uf: atleta.uf,
          termoAceito: atleta.termoAceito,
          classe: {
            id: atleta.classe.id,
            nome: atleta.classe.nome,
            evento: atleta.classe.evento,
            posicao: atleta.classe.posicao,
          },
        },
        contato: ibvar ? null : { email: atleta.emailContato, treinador: atleta.treinador },
        ciclo,
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
            motivo: g.motivo,
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
          "Mesma matriz de acesso da ficha: gestor vê todos, treinador só os próprios atletas, atleta só a si. Inclui a sugestão do atleta ainda pendente (pendente: true, origem resposta_sugerida). cf_peso_kg (calculado) traz as pesagens, com a nota pela regra P3 atual. IBVAR: pilar sensível dá 403; nos demais, sem evidência, avaliador, anexo nem sugestão pendente. Atleta fora do acesso ou indicador inexistente: 404.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid(), indicadorId: z.string().min(1).max(64) }),
        response: {
          200: z.array(
            z.object({
              valor: z.number().describe("Nota de 0 a 5"),
              pesoKg: z.number().nullable().describe("Só em cf_peso_kg: o peso da pesagem"),
              evidencia: z.string().nullable(),
              origem: z.enum([
                "avaliacao",
                "resposta_confirmada",
                "resposta_sugerida",
                "calculado",
              ]),
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
        if (indicador.id !== "cf_peso_kg") return [];
        const pesagens = await historicoDePesagens(app.db, base.id);
        return pesagens.map((m) => ({
          valor: notaPeso(
            distanciaClassFit(m.pesoKg, base.classe).distanciaRelativa,
            parametros.regras.p3.limites,
          ),
          pesoKg: m.pesoKg,
          evidencia: m.evidencia,
          origem: "calculado" as const,
          pendente: false,
          avaliador: m.registradoPor,
          cicloNome: null,
          lancadoEm: m.medidoEm,
          anexo: null,
        }));
      }

      const notas = await historicoDeNotas(app.db, base.id, indicador.id);
      return notas
        .filter((n) => !(ibvar && n.origem === "resposta_sugerida"))
        .map((n) => ({
          valor: n.valor,
          pesoKg: null,
          // IBVAR: sem evidência, sem quem avaliou e sem anexo (como na ficha).
          evidencia: ibvar ? null : n.evidencia,
          origem: n.origem,
          pendente: n.origem === "resposta_sugerida",
          avaliador: ibvar ? null : n.avaliador,
          cicloNome: n.cicloNome,
          lancadoEm: n.lancadoEm,
          anexo: ibvar ? null : n.anexo,
        }));
    },
  );
}

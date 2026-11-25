import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro, naoEncontrado } from "../erros.js";
import { listarAtletasVisiveis } from "../repositories/atletas.js";
import {
  carregarCongelado,
  idsComConsentimentoIbvar,
  listarCiclosDoPainel,
  ultimoLancamento,
} from "../repositories/investimento.js";
import type { CicloDoPainel, CongeladoDoAtleta } from "../repositories/investimento.js";
import { carregarParametros } from "../repositories/parametros.js";
import { carregarCiclosCongelados, classeExiste, lerRegra } from "../repositories/evolucao.js";
import { evolucaoDaTurma, metaDeEvolucao } from "../domain/index.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const NOMES_GATES: Record<number, string> = {
  1: "Class Fit",
  2: "Evidência competitiva",
  3: "Alto rendimento",
  4: "Campanha",
};

const esquemaCicloExibido = z.object({
  id: z.uuid(),
  nome: z.string(),
  inicio: z.string().describe("AAAA-MM-DD"),
  prazo: z.string().describe("AAAA-MM-DD"),
  status: z.enum(["aberto", "fechado"]),
  fechadoEm: z.string().nullable().describe("Instante ISO do fechamento; nulo se aberto"),
});

const esquemaInvestimento = z.object({
  ciclo: z
    .object({ nome: z.string(), prazo: z.string().describe("AAAA-MM-DD") })
    .nullable()
    .describe("Compatibilidade: nome e prazo do ciclo exibido (o mesmo de cicloExibido)"),
  cicloExibido: esquemaCicloExibido
    .nullable()
    .describe("Ciclo de onde saem os números; nulo se ainda não existe nenhum ciclo"),
  parcial: z
    .boolean()
    .describe("true: números calculados na hora (ciclo aberto ou sem ciclo), ainda podem mudar"),
  congelamentoCompleto: z
    .boolean()
    .describe(
      "false: ciclo fechado antes do congelamento completo; só score e faixa existem e o resto vem nulo",
    ),
  ciclosDisponiveis: z
    .array(
      z.object({
        id: z.uuid(),
        nome: z.string(),
        status: z.enum(["aberto", "fechado"]),
        fechadoEm: z.string().nullable(),
      }),
    )
    .describe("Para o seletor, do mais recente ao mais antigo"),
  dadosAtualizadosEm: z
    .string()
    .nullable()
    .describe(
      "Instante ISO. Ciclo fechado: o fechamento. Ciclo aberto: o último lançamento que muda score ou gates no piloto. Sempre agregado, nunca de um atleta",
    ),
  kpis: z.object({
    atletas: z.number().int(),
    scoreMedio: z.number(),
    aptos: z
      .number()
      .int()
      .nullable()
      .describe("Aptos nos 4 gates; nulo sem congelamento completo"),
    dependentesApoio: z
      .number()
      .int()
      .nullable()
      .describe("Perfil de suporte C ou D; nulo sem congelamento completo"),
  }),
  funil: z.array(
    z.object({ faixa: z.object({ id: z.string(), nome: z.string() }), n: z.number().int() }),
  ),
  gates: z.array(
    z.object({
      gate: z.number().int(),
      nome: z.string(),
      apto: z.number().int().nullable(),
      condicional: z.number().int().nullable(),
      alerta: z.number().int().nullable(),
    }),
  ),
  mediaPilares: z.array(
    z.object({ pilarId: z.string(), nomeCurto: z.string(), media: z.number().nullable() }),
  ),
  ondeInvestir: z.array(
    z.object({
      atleta: z.object({
        id: z.string(),
        nome: z.string(),
        classe: z.object({ nome: z.string() }),
      }),
      score: z.number(),
      statusGates: z.enum(["apto", "condicional", "nao_prioritario"]),
      perfilSuporte: z.enum(["C", "D"]),
      mesesAssegurados: z
        .number()
        .int()
        .nullable()
        .describe("Nulo para o IBVAR (vê só o perfil A–D)"),
    }),
  ),
  ocultosSemConsentimento: z
    .number()
    .int()
    .nullable()
    .describe(
      "Só para o IBVAR: atletas do recorte 'Onde investir' que ficaram fora da lista; nulo para o gestor (e sem congelamento completo)",
    ),
});

const esquemaEvolucao = z.object({
  ciclos: z
    .array(
      z.object({
        ciclo: z.object({
          id: z.uuid(),
          nome: z.string(),
          fechadoEm: z.string().nullable().describe("Instante ISO do fechamento"),
        }),
        atletas: z.number().int().describe("Atletas do recorte com score congelado neste ciclo"),
        scoreMedio: z
          .number()
          .nullable()
          .describe("Média do score; nula se suprimido ou sem atletas"),
        mediaPorPilar: z
          .array(
            z.object({ pilarId: z.string(), nomeCurto: z.string(), media: z.number().nullable() }),
          )
          .nullable()
          .describe("Nulo em ciclo fechado antes do congelamento completo, ou se suprimido"),
        funil: z
          .array(z.object({ faixaId: z.string(), nome: z.string(), n: z.number().int() }))
          .nullable()
          .describe("Atletas por faixa de score; nulo se suprimido"),
        aptosNosGates: z
          .number()
          .int()
          .nullable()
          .describe("Aptos nos 4 gates; nulo sem congelamento completo ou se suprimido"),
        congelamentoCompleto: z.boolean(),
        suprimido: z
          .boolean()
          .describe("true: grupo menor que MIN_GRUPO_AGREGADO para o IBVAR; os números vêm nulos"),
      }),
    )
    .describe("Ciclos fechados, do mais antigo ao mais recente"),
  meta: z.object({
    percentual: z.number().describe("META_EVOLUCAO: alta esperada da média, em %"),
    cicloBase: z.object({ id: z.uuid(), nome: z.string() }).nullable(),
    cicloAtual: z.object({ id: z.uuid(), nome: z.string() }).nullable(),
    mediaBase: z.number().nullable(),
    mediaAtual: z.number().nullable(),
    variacaoPercentual: z.number().nullable(),
    atingida: z
      .boolean()
      .nullable()
      .describe("Nula sem dois ciclos fechados, com média oculta ou com média base zero"),
  }),
});

/** Um atleta no cálculo do painel, venha do cálculo na hora ou do congelamento do fechamento. */
interface LinhaPainel extends CongeladoDoAtleta {
  /** Identidade atual, só de quem pode aparecer em "Onde investir" (ativo, no piloto). */
  identidade: { nome: string; classe: string } | null;
}

export async function rotasInvestimento(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/investimento",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "ibvar")],
      schema: {
        tags: ["investimento"],
        summary: "Painel de investimento: agregados do piloto e lista 'Onde investir'",
        description:
          "Sem `ciclo`, abre no último ciclo fechado, com os números congelados no fechamento (score, faixa, pilares, gates, status final e perfil de suporte); sem ciclo fechado, no ciclo aberto, calculado na hora (`parcial: true`); sem nenhum ciclo, calculado na hora com `cicloExibido: null`. `?ciclo=<id>` escolhe outro ciclo (inexistente: 404). Ciclo fechado antes do congelamento completo só tem score e faixa: o resto vem nulo, `congelamentoCompleto` é false e `ondeInvestir` vem vazia. Os números agregados incluem todos os atletas do piloto. A lista 'Onde investir' do IBVAR traz só quem consentiu (vale o consentimento atual), sem meses assegurados. `dadosAtualizadosEm` é sempre agregado, nunca de um atleta. O campo `ciclo` fica por compatibilidade e repete nome e prazo de `cicloExibido`.",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ ciclo: z.uuid().optional() }),
        response: {
          200: esquemaInvestimento,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const ibvar = req.usuario.papel === "ibvar";
      const referencia = app.agora();
      const [parametros, ciclos] = await Promise.all([
        carregarParametros(app.db),
        listarCiclosDoPainel(app.db),
      ]);

      let exibido: CicloDoPainel | null;
      if (req.query.ciclo) {
        exibido = ciclos.find((c) => c.id === req.query.ciclo) ?? null;
        if (!exibido) throw naoEncontrado("Ciclo não encontrado.");
      } else {
        exibido = ciclos.find((c) => c.status === "fechado") ?? ciclos[0] ?? null;
      }

      // Base dos agregados: todo o piloto (o IBVAR só recebe números, nunca a linha de quem não consentiu).
      const gestor = { id: req.usuario.id, papel: "gestor" as const, atletaId: null };
      const todos = await listarAtletasVisiveis(app.db, gestor, {
        somenteTermoAceito: true,
        agora: referencia,
      });

      let linhas: LinhaPainel[];
      let dadosAtualizadosEm: string | null;
      let congelamentoCompleto = true;
      if (exibido?.status === "fechado") {
        congelamentoCompleto = exibido.congelamentoCompleto;
        const porId = new Map(todos.map((a) => [a.id, a]));
        const dados = await carregarCongelado(app.db, exibido.id, congelamentoCompleto);
        linhas = dados.map((d) => {
          const a = porId.get(d.atletaId);
          return { ...d, identidade: a ? { nome: a.nome, classe: a.classe.nome } : null };
        });
        dadosAtualizadosEm = exibido.fechadoEm;
      } else {
        const avaliados = await carregarEAvaliarAtletas(app.db, parametros, todos, referencia);
        linhas = avaliados.map((x) => ({
          atletaId: x.atleta.id,
          score: x.calculo.score,
          faixaId: x.calculo.faixa.id,
          statusFinal: x.calculo.statusFinal,
          perfilSuporte: x.dados.financeiro?.perfilSuporte ?? null,
          mesesAssegurados: x.dados.financeiro?.mesesAssegurados ?? null,
          pilares: new Map(x.calculo.pilares.map((p) => [p.pilarId, p.nota])),
          gates: new Map(x.calculo.gates.map((g) => [g.gate, g.status])),
          identidade: { nome: x.atleta.nome, classe: x.atleta.classe.nome },
        }));
        dadosAtualizadosEm = await ultimoLancamento(
          app.db,
          todos.map((a) => a.id),
        );
      }
      const n = linhas.length;

      const scoreMedio = n === 0 ? 0 : linhas.reduce((t, x) => t + x.score, 0) / n;
      const dependeDeApoio = (x: LinhaPainel) => x.perfilSuporte === "C" || x.perfilSuporte === "D";

      const funil = parametros.faixas.map((f) => ({
        faixa: { id: f.id, nome: f.nome },
        n: linhas.filter((x) => x.faixaId === f.id).length,
      }));

      const gates = [1, 2, 3, 4].map((g) => {
        const nome = NOMES_GATES[g] ?? `G${g}`;
        if (!congelamentoCompleto) {
          return { gate: g, nome, apto: null, condicional: null, alerta: null };
        }
        const c = { apto: 0, condicional: 0, alerta: 0 };
        for (const x of linhas) {
          const status = x.gates?.get(g);
          if (status) c[status]++;
        }
        return { gate: g, nome, ...c };
      });

      const mediaPilares = parametros.pilares.map((p) => {
        const notas = linhas
          .map((x) => x.pilares?.get(p.id) ?? null)
          .filter((v): v is number => v !== null);
        return {
          pilarId: p.id,
          nomeCurto: p.nomeCurto,
          media: notas.length === 0 ? null : notas.reduce((t, v) => t + v, 0) / notas.length,
        };
      });

      // "Onde investir": faixa f2 (alto potencial) para cima, gates não bloqueados, perfil C ou D.
      // Pela posição da faixa (vêm da melhor para a pior), o que vale também para a faixa congelada.
      const posicaoF2 = parametros.faixas.findIndex((f) => f.id === "f2");
      const naFaixaAlvo = (x: LinhaPainel) => {
        const pos = parametros.faixas.findIndex((f) => f.id === x.faixaId);
        return posicaoF2 >= 0 && pos >= 0 && pos <= posicaoF2;
      };
      const alvo = congelamentoCompleto
        ? linhas
            .flatMap((x) =>
              x.identidade &&
              x.statusFinal &&
              x.statusFinal !== "nao_prioritario" &&
              naFaixaAlvo(x) &&
              dependeDeApoio(x)
                ? [{ ...x, identidade: x.identidade, statusFinal: x.statusFinal }]
                : [],
            )
            .sort(
              (a, b) =>
                b.score - a.score || a.identidade.nome.localeCompare(b.identidade.nome, "pt-BR"),
            )
        : [];

      const consentiram = ibvar
        ? await idsComConsentimentoIbvar(
            app.db,
            alvo.map((x) => x.atletaId),
          )
        : null;
      const visiveis = consentiram ? alvo.filter((x) => consentiram.has(x.atletaId)) : alvo;

      return {
        ciclo: exibido ? { nome: exibido.nome, prazo: exibido.prazo } : null,
        cicloExibido: exibido
          ? {
              id: exibido.id,
              nome: exibido.nome,
              inicio: exibido.inicio,
              prazo: exibido.prazo,
              status: exibido.status,
              fechadoEm: exibido.fechadoEm,
            }
          : null,
        parcial: exibido?.status !== "fechado",
        congelamentoCompleto,
        ciclosDisponiveis: ciclos.map((c) => ({
          id: c.id,
          nome: c.nome,
          status: c.status,
          fechadoEm: c.fechadoEm,
        })),
        dadosAtualizadosEm,
        kpis: {
          atletas: n,
          scoreMedio,
          aptos: congelamentoCompleto
            ? linhas.filter((x) => x.statusFinal === "apto").length
            : null,
          dependentesApoio: congelamentoCompleto ? linhas.filter(dependeDeApoio).length : null,
        },
        funil,
        gates,
        mediaPilares,
        ondeInvestir: visiveis.map((x) => ({
          atleta: {
            id: x.atletaId,
            nome: x.identidade.nome,
            classe: { nome: x.identidade.classe },
          },
          score: x.score,
          statusGates: x.statusFinal,
          perfilSuporte: x.perfilSuporte as "C" | "D",
          mesesAssegurados: ibvar ? null : x.mesesAssegurados,
        })),
        ocultosSemConsentimento:
          ibvar && congelamentoCompleto ? alvo.length - visiveis.length : null,
      };
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    "/investimento/evolucao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "ibvar")],
      schema: {
        tags: ["investimento"],
        summary: "Evolução da turma entre ciclos fechados e meta de alta da média",
        description:
          "Para cada ciclo fechado (mais antigo primeiro): atletas, média do score, média por pilar, funil por faixa e aptos nos gates, a partir do que o fechamento congelou. Ciclo fechado antes do congelamento completo só tem score e faixa: pilares e gates vêm nulos. `meta` compara os dois últimos ciclos fechados com META_EVOLUCAO (nula sem dois ciclos). `?classeId=` recorta pela classe atual dos atletas (inexistente: 404). Sigilo (D12): para o IBVAR, ciclo com menos de MIN_GRUPO_AGREGADO atletas no recorte vem com `suprimido: true` e os números nulos (a meta fica nula se um dos dois ciclos foi suprimido); o gestor vê tudo. Só agregados: nenhum dado individual. GET /investimento não tem recorte (soma todo o piloto), por isso não aplica o mínimo.",
        security: [{ bearerAuth: [] }],
        querystring: z.object({ classeId: z.string().min(1).max(40).optional() }),
        response: {
          200: esquemaEvolucao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const classeId = req.query.classeId ?? null;
      if (classeId && !(await classeExiste(app.db, classeId))) {
        throw naoEncontrado("Classe não encontrada.");
      }
      const [parametros, ciclos, meta, minimo] = await Promise.all([
        carregarParametros(app.db),
        carregarCiclosCongelados(app.db, classeId),
        lerRegra(app.db, "META_EVOLUCAO"),
        lerRegra(app.db, "MIN_GRUPO_AGREGADO"),
      ]);
      const evolucao = evolucaoDaTurma(
        ciclos,
        parametros.faixas,
        parametros.pilares,
        req.usuario.papel === "ibvar" ? minimo.minimo : null,
      );
      return { ciclos: evolucao, meta: metaDeEvolucao(evolucao, meta.percentual) };
    },
  );
}

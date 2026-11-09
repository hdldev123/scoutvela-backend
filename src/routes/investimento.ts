import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro } from "../erros.js";
import { cicloAberto, listarAtletasVisiveis } from "../repositories/atletas.js";
import { idsComConsentimentoIbvar } from "../repositories/investimento.js";
import { carregarParametros } from "../repositories/parametros.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const NOMES_GATES: Record<number, string> = {
  1: "Class Fit",
  2: "Evidência competitiva",
  3: "Alto rendimento",
  4: "Campanha",
};

const esquemaInvestimento = z.object({
  ciclo: z.object({ nome: z.string(), prazo: z.string().describe("AAAA-MM-DD") }).nullable(),
  kpis: z.object({
    atletas: z.number().int(),
    scoreMedio: z.number(),
    aptos: z.number().int().describe("Aptos nos 4 gates"),
    dependentesApoio: z.number().int().describe("Perfil de suporte C ou D"),
  }),
  funil: z.array(z.object({ faixa: z.object({ id: z.string(), nome: z.string() }), n: z.number().int() })),
  gates: z.array(
    z.object({
      gate: z.number().int(),
      nome: z.string(),
      apto: z.number().int(),
      condicional: z.number().int(),
      alerta: z.number().int(),
    }),
  ),
  mediaPilares: z.array(
    z.object({ pilarId: z.string(), nomeCurto: z.string(), media: z.number().nullable() }),
  ),
  ondeInvestir: z.array(
    z.object({
      atleta: z.object({ id: z.string(), nome: z.string(), classe: z.object({ nome: z.string() }) }),
      score: z.number(),
      statusGates: z.enum(["apto", "condicional", "nao_prioritario"]),
      perfilSuporte: z.enum(["C", "D"]),
      mesesAssegurados: z.number().int().nullable().describe("Nulo para o IBVAR (vê só o perfil A–D)"),
    }),
  ),
  ocultosSemConsentimento: z
    .number()
    .int()
    .nullable()
    .describe("Só para o IBVAR: atletas do recorte 'Onde investir' que ficaram fora da lista; nulo para o gestor"),
});

export async function rotasInvestimento(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/investimento",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "ibvar")],
      schema: {
        tags: ["investimento"],
        summary: "Painel de investimento: agregados do piloto e lista 'Onde investir'",
        description:
          "Os números agregados incluem todos os atletas do piloto. A lista 'Onde investir' do IBVAR traz só quem consentiu, sem meses assegurados.",
        security: [{ bearerAuth: [] }],
        response: { 200: esquemaInvestimento, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const ibvar = req.usuario.papel === "ibvar";
      const referencia = app.agora();
      const [parametros, ciclo] = await Promise.all([carregarParametros(app.db), cicloAberto(app.db)]);

      // Base dos agregados: todo o piloto (o IBVAR só recebe números, nunca a linha de quem não consentiu).
      const todos = await listarAtletasVisiveis(
        app.db,
        { id: req.usuario.id, papel: "gestor", atletaId: null },
        { somenteTermoAceito: true },
      );
      const avaliados = await carregarEAvaliarAtletas(app.db, parametros, todos, referencia);
      const n = avaliados.length;

      const scoreMedio = n === 0 ? 0 : avaliados.reduce((t, x) => t + x.calculo.score, 0) / n;
      const perfilDe = (x: (typeof avaliados)[number]) => x.dados.financeiro?.perfilSuporte ?? null;
      const dependeDeApoio = (x: (typeof avaliados)[number]) => {
        const p = perfilDe(x);
        return p === "C" || p === "D";
      };

      const funil = parametros.faixas.map((f) => ({
        faixa: { id: f.id, nome: f.nome },
        n: avaliados.filter((x) => x.calculo.faixa.id === f.id).length,
      }));

      const gates = [1, 2, 3, 4].map((g) => {
        const c = { apto: 0, condicional: 0, alerta: 0 };
        for (const x of avaliados) {
          const gate = x.calculo.gates.find((i) => i.gate === g);
          if (gate) c[gate.status]++;
        }
        return { gate: g, nome: NOMES_GATES[g] ?? `G${g}`, ...c };
      });

      const mediaPilares = parametros.pilares.map((p) => {
        const notas = avaliados
          .map((x) => x.calculo.pilares.find((i) => i.pilarId === p.id)?.nota ?? null)
          .filter((v): v is number => v !== null);
        return {
          pilarId: p.id,
          nomeCurto: p.nomeCurto,
          media: notas.length === 0 ? null : notas.reduce((t, v) => t + v, 0) / notas.length,
        };
      });

      // "Onde investir": faixa f2 (alto potencial) para cima, gates não bloqueados, perfil C ou D.
      const f2 = parametros.faixas.find((f) => f.id === "f2");
      const corte = f2 ? f2.scoreMin : Number.POSITIVE_INFINITY;
      const alvo = avaliados
        .filter((x) => x.calculo.score >= corte && x.calculo.statusFinal !== "nao_prioritario" && dependeDeApoio(x))
        .sort((a, b) => b.calculo.score - a.calculo.score || a.atleta.nome.localeCompare(b.atleta.nome, "pt-BR"));

      const consentiram = ibvar ? await idsComConsentimentoIbvar(app.db, alvo.map((x) => x.atleta.id)) : null;
      const visiveis = consentiram ? alvo.filter((x) => consentiram.has(x.atleta.id)) : alvo;

      return {
        ciclo,
        kpis: {
          atletas: n,
          scoreMedio,
          aptos: avaliados.filter((x) => x.calculo.statusFinal === "apto").length,
          dependentesApoio: avaliados.filter(dependeDeApoio).length,
        },
        funil,
        gates,
        mediaPilares,
        ondeInvestir: visiveis.map((x) => ({
          atleta: { id: x.atleta.id, nome: x.atleta.nome, classe: { nome: x.atleta.classe.nome } },
          score: x.calculo.score,
          statusGates: x.calculo.statusFinal,
          perfilSuporte: perfilDe(x) as "C" | "D",
          mesesAssegurados: ibvar ? null : (x.dados.financeiro?.mesesAssegurados ?? null),
        })),
        ocultosSemConsentimento: ibvar ? alvo.length - visiveis.length : null,
      };
    },
  );
}

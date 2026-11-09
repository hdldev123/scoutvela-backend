import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { idadeEm } from "../domain/index.js";
import { esquemaErro } from "../erros.js";
import {
  cicloAberto,
  contarSemConsentimentoIbvar,
  listarAtletasVisiveis,
} from "../repositories/atletas.js";
import { carregarParametros } from "../repositories/parametros.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const esquemaCiclo = z.object({ nome: z.string(), prazo: z.string().describe("AAAA-MM-DD") }).nullable();

const esquemaItem = z.object({
  posicao: z.number().int(),
  atleta: z.object({
    id: z.string(),
    nome: z.string(),
    velaid: z.string(),
    numeroVela: z.string().nullable(),
    uf: z.string().nullable(),
    idade: z.number().int(),
    genero: z.enum(["F", "M"]),
    classe: z.object({ id: z.string(), nome: z.string(), evento: z.string() }),
  }),
  score: z.number(),
  faixa: z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string() }),
  completo: z.boolean(),
  pilares: z.array(z.object({ id: z.string(), nomeCurto: z.string(), nota: z.number().nullable() })),
  statusGates: z.enum(["apto", "condicional", "nao_prioritario"]).describe("Status final pelos 4 gates (P7)"),
  pontosCbvela: z.number(),
});

const esquemaRanking = z.object({
  ciclo: esquemaCiclo,
  itens: z.array(esquemaItem),
  ocultosSemConsentimento: z.number().int().nullable().describe("Só para o IBVAR; nulo para os demais"),
});

const esquemaQuery = z.object({
  classe: z.string().min(1).max(60).optional().describe("Evento da classe, ex.: ILCA 7"),
  categoria: z.enum(["F", "M"]).optional(),
  faixa: z.enum(["f1", "f2", "f3", "f4"]).optional(),
  ordem: z.enum(["score", "pontos_cbvela"]).default("score"),
});

export async function rotasRanking(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/ranking",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "ibvar")],
      schema: {
        tags: ["ranking"],
        summary: "Ranking de atletas do piloto, conforme a matriz de acesso do papel",
        description:
          "Gestor vê todos; treinador, os próprios; IBVAR, só atletas com consentimento (os demais entram apenas na contagem).",
        security: [{ bearerAuth: [] }],
        querystring: esquemaQuery,
        response: { 200: esquemaRanking, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const { classe, categoria, faixa, ordem } = req.query;
      const referencia = app.agora();
      const [parametros, ciclo] = await Promise.all([carregarParametros(app.db), cicloAberto(app.db)]);

      const atletas = await listarAtletasVisiveis(app.db, req.usuario, {
        somenteTermoAceito: true,
        ...(classe ? { classeEvento: classe } : {}),
        ...(categoria ? { genero: categoria } : {}),
      });
      const avaliados = await carregarEAvaliarAtletas(app.db, parametros, atletas, referencia);

      const filtrados = faixa ? avaliados.filter((x) => x.calculo.faixa.id === faixa) : avaliados;
      // Estável: já vem por nome; o empate cai no nome.
      filtrados.sort((a, b) => {
        const d =
          ordem === "pontos_cbvela"
            ? b.calculo.pontosCbvela - a.calculo.pontosCbvela
            : b.calculo.score - a.calculo.score;
        return d !== 0 ? d : a.atleta.nome.localeCompare(b.atleta.nome, "pt-BR");
      });

      const nomeCurto = new Map(parametros.pilares.map((p) => [p.id, p.nomeCurto]));
      const itens = filtrados.map(({ atleta, calculo }, i) => ({
        posicao: i + 1,
        atleta: {
          id: atleta.id,
          nome: atleta.nome,
          velaid: atleta.velaid,
          numeroVela: atleta.numeroVela,
          uf: atleta.uf,
          idade: idadeEm(atleta.dataNascimento, referencia),
          genero: atleta.genero,
          classe: { id: atleta.classe.id, nome: atleta.classe.nome, evento: atleta.classe.evento },
        },
        score: calculo.score,
        faixa: { id: calculo.faixa.id, nome: calculo.faixa.nome, nomeCurto: calculo.faixa.nomeCurto },
        completo: calculo.completo,
        pilares: calculo.pilares.map((p) => ({ id: p.pilarId, nomeCurto: nomeCurto.get(p.pilarId) ?? p.pilarId, nota: p.nota })),
        statusGates: calculo.statusFinal,
        pontosCbvela: calculo.pontosCbvela,
      }));

      const ocultos = req.usuario.papel === "ibvar" ? await contarSemConsentimentoIbvar(app.db) : null;
      return { ciclo, itens, ocultosSemConsentimento: ocultos };
    },
  );
}

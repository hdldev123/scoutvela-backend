import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { ErroApi, esquemaErro } from "../erros.js";
import { ErroParametros, atualizarParametros, carregarParametrosCompletos } from "../repositories/parametros.js";

const esquemaParametros = z.object({
  pilares: z.array(
    z.object({
      id: z.string(),
      nome: z.string(),
      nomeCurto: z.string(),
      peso: z.number(),
      sensivel: z.boolean(),
      evidenciaPadrao: z.string(),
      indicadores: z.array(
        z.object({ id: z.string(), nome: z.string(), tipo: z.enum(["T", "A", "R"]), calculado: z.boolean() }),
      ),
    }),
  ),
  faixas: z.array(z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string(), scoreMin: z.number() })),
  classes: z.array(
    z.object({
      id: z.string(),
      nome: z.string(),
      evento: z.string(),
      posicao: z.enum(["helm", "crew", "ind"]),
      pesoMinKg: z.number(),
      pesoMedioKg: z.number(),
      pesoMaxKg: z.number(),
    }),
  ),
  rubricas: z.array(
    z.object({
      pilarId: z.string().nullable().describe("Nulo = escala geral de 0 a 5"),
      nota: z.number().int(),
      descricao: z.string(),
    }),
  ),
  regras: z.array(z.object({ codigo: z.string(), descricao: z.string(), valor: z.unknown() })),
  componentesCusto: z.array(z.object({ id: z.string(), nome: z.string() })),
});

const pesoKg = z.number().min(0).max(400);
const esquemaAtualizacao = z
  .object({
    pesos: z
      .record(z.string().min(1).max(40), z.number().int().min(0).max(100))
      .optional()
      .describe("Peso de cada um dos 9 pilares; a soma precisa ser 100"),
    classes: z
      .array(z.object({ id: z.string().min(1).max(40), pesoMinKg: pesoKg, pesoMedioKg: pesoKg, pesoMaxKg: pesoKg }))
      .max(50)
      .optional(),
  })
  .refine((d) => d.pesos !== undefined || (d.classes !== undefined && d.classes.length > 0), {
    message: "Informe pesos ou classes.",
  });

export async function rotasParametros(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/parametros",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["parametros"],
        summary: "Parâmetros da metodologia (pesos, faixas, classes, rubricas, regras)",
        description: "Leitura para gestor e treinador (o treinador precisa da escala e das rubricas na avaliação).",
        security: [{ bearerAuth: [] }],
        response: { 200: esquemaParametros, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async () => carregarParametrosCompletos(app.db),
  );

  r.put(
    "/parametros",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["parametros"],
        summary: "Atualiza pesos dos pilares e faixas de peso das classes",
        description: "O ranking recalcula sozinho (o cálculo é feito na leitura). Grava auditoria com antes e depois.",
        security: [{ bearerAuth: [] }],
        body: esquemaAtualizacao,
        response: { 200: esquemaParametros, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      try {
        await atualizarParametros(app.db, req.usuario.id, req.body);
      } catch (e) {
        if (e instanceof ErroParametros) throw new ErroApi(400, "requisicao_invalida", e.message);
        throw e;
      }
      return carregarParametrosCompletos(app.db);
    },
  );
}

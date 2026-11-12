import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { ErroApi, esquemaErro } from "../erros.js";
import {
  ErroParametros,
  atualizarParametros,
  carregarParametrosCompletos,
} from "../repositories/parametros.js";

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
        z.object({
          id: z.string(),
          nome: z.string(),
          tipo: z.enum(["T", "A", "R"]),
          calculado: z.boolean(),
        }),
      ),
    }),
  ),
  faixas: z.array(
    z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string(), scoreMin: z.number() }),
  ),
  classes: z.array(
    z.object({
      id: z.string(),
      ativa: z.boolean(),
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
  regras: z.array(
    z.object({
      codigo: z.string(),
      descricao: z.string(),
      valor: z.unknown(),
      atualizadoEm: z.string().describe("Instante ISO"),
    }),
  ),
  componentesCusto: z.array(z.object({ id: z.string(), nome: z.string() })),
});

const pesoKg = z.number().min(0).max(400);
const esquemaAtualizacao = z
  .object({
    pesos: z
      .record(z.string().min(1).max(40), z.number().int().min(0).max(100))
      .optional()
      .describe("Peso de cada um dos 9 pilares; a soma precisa ser 100"),
    faixas: z
      .array(z.object({ id: z.string().min(1).max(40), scoreMin: z.number().min(0).max(100) }))
      .max(10)
      .optional()
      .describe(
        "As 4 faixas; scoreMin estritamente decrescente na ordem das faixas e a última com 0",
      ),
    rubricas: z
      .array(
        z.object({
          pilarId: z.string().min(1).max(40).nullable().describe("Nulo = escala geral de 0 a 5"),
          nota: z.number().int().min(0).max(5),
          descricao: z.string().trim().min(3).max(300),
        }),
      )
      .max(100)
      .optional()
      .describe("Upsert por (pilarId, nota)"),
    regras: z
      .record(z.string().min(1).max(40), z.unknown())
      .optional()
      .describe(
        "{codigo: valor}; códigos aceitos: P3, G1, G2, G3, G4, RANKING_CBVELA. O valor segue o formato lido em GET /parametros",
      ),
    classes: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          pesoMinKg: pesoKg.optional(),
          pesoMedioKg: pesoKg.optional(),
          pesoMaxKg: pesoKg.optional(),
          ativa: z.boolean().optional().describe("Não dá para desativar classe com atleta ativo"),
        }),
      )
      .max(50)
      .optional(),
  })
  .refine(
    (d) =>
      d.pesos !== undefined ||
      (d.faixas?.length ?? 0) > 0 ||
      (d.rubricas?.length ?? 0) > 0 ||
      (d.regras !== undefined && Object.keys(d.regras).length > 0) ||
      (d.classes?.length ?? 0) > 0,
    { message: "Informe ao menos um de: pesos, faixas, rubricas, regras ou classes." },
  );

export async function rotasParametros(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/parametros",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["parametros"],
        summary: "Parâmetros da metodologia (pesos, faixas, classes, rubricas, regras)",
        description:
          "Leitura para gestor e treinador (o treinador precisa da escala e das rubricas na avaliação).",
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
        summary: "Atualiza pesos, faixas de score, rubricas, regras e classes",
        description:
          "O ranking recalcula sozinho (o cálculo é feito na leitura). Grava auditoria com antes e depois.",
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

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
          evidencia: z
            .enum(["obrigatoria", "opcional"])
            .describe(
              "Se a nota do indicador exige texto de evidência (treinador e sugestão do atleta). O gestor muda em PUT /parametros (indicadores)",
            ),
          exigeAnexo: z
            .boolean()
            .describe("A nota depende de arquivo anexado (ex.: foto da balança no peso)"),
          autoavaliacao: z
            .boolean()
            .describe(
              "O atleta pode sugerir a nota deste indicador (POST /autoavaliacoes). O gestor muda em PUT /parametros (indicadores)",
            ),
          orientacao: z
            .string()
            .nullable()
            .describe(
              "Texto de ajuda do indicador, mostrado embaixo do campo; nulo = sem orientação. O gestor muda em PUT /parametros (indicadores)",
            ),
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
      alturaMinCm: z
        .number()
        .nullable()
        .describe("Altura de referência (informativa); nula se não definida"),
      alturaMediaCm: z.number().nullable(),
      alturaMaxCm: z.number().nullable(),
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

export const pesoKg = z
  .number("Informe o peso em kg.")
  .min(0, "O peso da classe deve ficar entre 0 e 400 kg.")
  .max(400, "O peso da classe deve ficar entre 0 e 400 kg.");
const alturaCm = z
  .number("Informe a altura em cm.")
  .min(120, "A altura deve ficar entre 120 e 230 cm.")
  .max(230, "A altura deve ficar entre 120 e 230 cm.")
  .nullable();
const esquemaAtualizacao = z
  .object({
    pesos: z
      .record(
        z.string().min(1).max(40),
        z
          .number("O peso do pilar deve ser um número.")
          .int("O peso do pilar deve ser um número inteiro.")
          .min(0, "O peso do pilar deve ficar entre 0 e 100.")
          .max(100, "O peso do pilar deve ficar entre 0 e 100."),
      )
      .optional()
      .describe("Peso de cada um dos 9 pilares; a soma precisa ser 100"),
    faixas: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          scoreMin: z
            .number("Informe o score mínimo da faixa.")
            .min(0, "O score mínimo deve ficar entre 0 e 100.")
            .max(100, "O score mínimo deve ficar entre 0 e 100."),
        }),
      )
      .max(10)
      .optional()
      .describe(
        "As 4 faixas; scoreMin estritamente decrescente na ordem das faixas e a última com 0",
      ),
    rubricas: z
      .array(
        z.object({
          pilarId: z.string().min(1).max(40).nullable().describe("Nulo = escala geral de 0 a 5"),
          nota: z
            .number("Informe a nota da rubrica.")
            .int("A nota da rubrica deve ser inteira.")
            .min(0, "A nota da rubrica deve ficar entre 0 e 5.")
            .max(5, "A nota da rubrica deve ficar entre 0 e 5."),
          descricao: z
            .string()
            .trim()
            .min(3, "A descrição da rubrica precisa ter ao menos 3 caracteres.")
            .max(300, "A descrição da rubrica pode ter no máximo 300 caracteres."),
        }),
      )
      .max(100)
      .optional()
      .describe("Upsert por (pilarId, nota)"),
    rubricasRemover: z
      .array(z.string().max(40).nullable())
      .min(1)
      .max(20)
      .refine((l) => new Set(l).size === l.length, "Pilar repetido em rubricasRemover.")
      .optional()
      .describe(
        "Ids de pilar cujas rubricas próprias saem (volta a valer a escala geral). A escala geral não pode ser removida: nulo ou vazio dão 400 com mensagem explícita",
      ),
    regras: z
      .record(z.string().min(1).max(40), z.unknown())
      .optional()
      .describe(
        "{codigo: valor}; códigos aceitos: P3, G1, G2, G3, G4, RANKING_CBVELA, TERMO_EXIGE_REACEITE, PERF_PONTOS. O valor segue o formato lido em GET /parametros. PERF_PONTOS: { ativa, indicador (opcional, padrão perf_nacional; precisa ser um indicador T não calculado), faixas: [{ ate, nota }] }, ate crescente e nota de 0 a 5 que não diminui",
      ),
    indicadores: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            evidencia: z
              .enum(["obrigatoria", "opcional"], {
                error: "A evidência deve ser obrigatoria ou opcional.",
              })
              .optional(),
            autoavaliacao: z
              .boolean("Informe verdadeiro ou falso.")
              .optional()
              .describe(
                "Liga ou desliga a autoavaliação do indicador (só tipo T não calculado pode ligar)",
              ),
            orientacao: z
              .string("A orientação deve ser um texto.")
              .trim()
              .min(1, "A orientação não pode ficar vazia: envie null para remover.")
              .max(1000, "A orientação pode ter no máximo 1.000 caracteres.")
              .nullable()
              .optional()
              .describe("Texto de ajuda do indicador (até 1.000 caracteres); null remove"),
          })
          .strict()
          .refine(
            (i) =>
              i.evidencia !== undefined ||
              i.autoavaliacao !== undefined ||
              i.orientacao !== undefined,
            "Informe a evidência, a autoavaliação ou a orientação do indicador.",
          ),
      )
      .min(1)
      .max(100)
      .refine((l) => new Set(l.map((i) => i.id)).size === l.length, "Indicador repetido.")
      .optional()
      .describe(
        "Regra por indicador: `evidencia` (obrigatoria ou opcional), `autoavaliacao` (boolean) e/ou `orientacao` (texto de ajuda, até 1.000 caracteres; null remove). A auditoria guarda antes e depois (da orientação, só se havia texto)",
      ),
    classes: z
      .array(
        z.object({
          id: z.string().min(1).max(40),
          pesoMinKg: pesoKg.optional(),
          pesoMedioKg: pesoKg.optional(),
          pesoMaxKg: pesoKg.optional(),
          alturaMinCm: alturaCm
            .optional()
            .describe(
              "Altura de referência da classe, só informativa (não entra no score nem nos gates). Informe as três (min, média, max; 120 a 230 cm, min <= média <= max) ou as três nulas para limpar",
            ),
          alturaMediaCm: alturaCm.optional(),
          alturaMaxCm: alturaCm.optional(),
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
      (d.rubricasRemover?.length ?? 0) > 0 ||
      (d.regras !== undefined && Object.keys(d.regras).length > 0) ||
      (d.indicadores?.length ?? 0) > 0 ||
      (d.classes?.length ?? 0) > 0,
    {
      message:
        "Informe ao menos um de: pesos, faixas, rubricas, rubricasRemover, regras, indicadores ou classes.",
    },
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
        summary:
          "Atualiza pesos, faixas de score, rubricas, regras, evidência por indicador e classes",
        description:
          "O ranking recalcula sozinho (o cálculo é feito na leitura). Grava auditoria com antes e depois.",
        security: [{ bearerAuth: [] }],
        body: esquemaAtualizacao,
        response: { 200: esquemaParametros, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      try {
        await atualizarParametros(app.db, req.usuario.id, req.body, app.agora());
      } catch (e) {
        if (e instanceof ErroParametros) throw new ErroApi(400, "requisicao_invalida", e.message);
        throw e;
      }
      return carregarParametrosCompletos(app.db);
    },
  );
}

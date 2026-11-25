import { z } from "zod";

/** Resultado de regata como a API devolve: ficha, lista do atleta e lançamentos. */
export const esquemaResultadoDetalhe = z.object({
  id: z.string().describe("Identificador do resultado (PUT /resultados/:id/validacao)"),
  data: z.string().describe("AAAA-MM-DD"),
  nivel: z.string(),
  evento: z.string(),
  edicao: z
    .number()
    .int()
    .describe("Ano da edição (nos resultados lançados antes da D10, o ano da data)"),
  posicao: z.number().int(),
  tamanhoFrota: z
    .number()
    .int()
    .nullable()
    .describe("Nulo quando o atleta informou o resultado sem a frota; a nota não depende dela"),
  internacional: z.boolean(),
  pontosCbvela: z.number().nullable().describe("Só informação: não entra na nota"),
  fonte: z
    .enum(["ranking_cbvela", "manual", "atleta", "world_sailing"])
    .describe(
      "ranking_cbvela: importado; manual: lançado por gestor ou treinador; atleta: informado pelo atleta; world_sailing: importado do perfil da World Sailing (fonte oficial: vale direto, e o treinador do atleta ou o gestor pode invalidar com motivo)",
    ),
  linkOficial: z.string().nullable(),
  status: z
    .enum(["validado", "pendente", "recusado"])
    .describe(
      "`atleta`: pendente até a validação do treinador. `world_sailing`: `validado` (vigente) até o treinador ou o gestor invalidar (`recusado`, com `motivo`); revalidar volta a `validado`. Manual e Ranking CBVela vêm sempre `validado`. Só o validado conta na nota e nos gates",
    ),
  motivo: z.string().nullable().describe("Motivo da recusa; nulo para o IBVAR"),
  anexo: z
    .object({ id: z.string(), nomeArquivo: z.string() })
    .nullable()
    .describe("Súmula anexada pelo atleta (GET /evidencias/:id/link); nula para o IBVAR"),
  validadoPor: z
    .object({ id: z.string(), nome: z.string() })
    .nullable()
    .describe("Quem validou ou recusou por último; nulo para o IBVAR"),
  validadoEm: z.string().nullable().describe("Instante ISO; nulo para o IBVAR"),
});

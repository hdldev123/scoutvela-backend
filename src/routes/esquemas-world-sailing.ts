import { z } from "zod";

/** Resumo da busca na World Sailing (cadastro do atleta e POST /atletas/:id/world-sailing). */
export const esquemaResumoWorldSailing = z.object({
  status: z
    .enum(["ok", "nao_encontrado", "falhou", "desligado"])
    .describe(
      "ok: buscou (veja as contagens). nao_encontrado: o ID não existe na World Sailing. falhou: a World Sailing não respondeu direito (nada foi importado; tente de novo depois). desligado: a integração está desligada neste ambiente",
    ),
  resultadosNovos: z.number().int().describe("Resultados de regata novos nesta busca"),
  rankingNovos: z.number().int().describe("Posições de ranking novas nesta busca"),
});

/**
 * Origens de `avaliacoes` que são só sugestão do atleta: a resposta do questionário que ainda espera
 * o treinador (`resposta_sugerida`) e a autoavaliação (`autoavaliacao`). Sugestão nunca entra no score,
 * nos gates, no congelamento do ciclo, no ranking, no investimento nem nas pendências do treinador.
 * Toda consulta que lê `avaliacoes` direto e quer só a nota do avaliador usa `sqlNotaDoAvaliador`
 * (a view `avaliacao_atual` já faz o mesmo filtro).
 */
export const ORIGENS_SUGESTAO = ["resposta_sugerida", "autoavaliacao"] as const;

/** Origens de nota do avaliador (treinador ou gestor). */
export const ORIGENS_NOTA = ["avaliacao", "resposta_confirmada", "autoavaliacao_aprovada"] as const;

const lista = ORIGENS_SUGESTAO.map((o) => `'${o}'`).join(", ");

/** Condição SQL: a linha de `avaliacoes` (alias `alias`, ou sem prefixo) é nota do avaliador. */
export const sqlNotaDoAvaliador = (alias?: string): string =>
  `${alias ? `${alias}.` : ""}origem not in (${lista})`;

/** Condição SQL: a linha é sugestão do atleta. */
export const sqlSugestaoDoAtleta = (alias?: string): string =>
  `${alias ? `${alias}.` : ""}origem in (${lista})`;

export const ehSugestao = (origem: string): boolean =>
  (ORIGENS_SUGESTAO as readonly string[]).includes(origem);

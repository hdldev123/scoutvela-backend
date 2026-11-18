import type { Regras } from "./tipos.js";

/** Indicador de Performance que recebe a nota sugerida pelos pontos do Ranking CBVela. */
export const INDICADOR_PONTOS_RANKING = "perf_nacional";

export interface SugestaoPontos {
  nota: number;
  /** Pontos do Ranking CBVela usados na conversão (soma na janela). */
  pontos: number;
}

/**
 * Nota sugerida pela regra PERF_PONTOS. Nula com a regra desligada ou sem faixas.
 * Primeira faixa com pontos ≤ `ate`; acima da última, vale a nota da última.
 * É só sugestão: não entra no score até o avaliador lançar a nota.
 */
export function notaSugeridaPorPontos(
  pontos: number,
  regra: Regras["perfPontos"],
): SugestaoPontos | null {
  if (!regra.ativa || regra.faixas.length === 0) return null;
  const faixas = [...regra.faixas].sort((a, b) => a.ate - b.ate);
  const faixa = faixas.find((f) => pontos <= f.ate) ?? faixas[faixas.length - 1]!;
  return { nota: faixa.nota, pontos };
}

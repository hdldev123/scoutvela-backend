import type { Regras } from "./tipos.js";

/** Indicador que recebe a nota sugerida quando a regra PERF_PONTOS não traz o campo `indicador`. */
export const INDICADOR_PONTOS_PADRAO = "perf_nacional";

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
  regra: Omit<Regras["perfPontos"], "indicador">,
): SugestaoPontos | null {
  if (!regra.ativa || regra.faixas.length === 0) return null;
  const faixas = [...regra.faixas].sort((a, b) => a.ate - b.ate);
  // Mesma precisão dos pontos (2 casas): a comparação com `ate` não depende de erro de float.
  const p = Math.round(pontos * 100) / 100;
  const faixa = faixas.find((f) => p <= f.ate) ?? faixas[faixas.length - 1]!;
  return { nota: faixa.nota, pontos: p };
}

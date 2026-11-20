export type SituacaoAltura = "dentro" | "abaixo" | "acima";

export interface FaixaAltura {
  minCm: number;
  maxCm: number;
}

/**
 * Onde a altura do atleta cai na faixa de referência da classe. INFORMATIVA: não entra no score,
 * na nota de pilar nem nos gates. Nula se faltar a altura ou a faixa. Os limites contam como "dentro".
 */
export function situacaoAltura(
  alturaCm: number | null,
  faixa: FaixaAltura | null,
): SituacaoAltura | null {
  if (alturaCm === null || faixa === null) return null;
  if (alturaCm < faixa.minCm) return "abaixo";
  if (alturaCm > faixa.maxCm) return "acima";
  return "dentro";
}

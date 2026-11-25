/**
 * ID World Sailing: chave do atleta no Scout Vela (D1).
 * Formato inferido de exemplos públicos (ver docs/world-sailing.md): sigla do país com 3 letras
 * seguida de 2 a 12 letras ou números (ex.: BRARB51, GBRHM15). Tolerante de propósito.
 */
export const WS_ID_FORMATO = /^[A-Z]{3}[A-Z0-9]{2,12}$/;

/** Maiúsculas e sem espaços. Não valida. */
export function normalizarWsId(texto: string): string {
  return texto.replace(/\s+/g, "").toUpperCase();
}

/** O ID já normalizado tem o formato aceito. */
export function wsIdValido(normalizado: string): boolean {
  return WS_ID_FORMATO.test(normalizado);
}

/** Telefone e validade do passaporte do atleta (D15). Funções puras. */

const E164 = /^\+[1-9][0-9]{7,14}$/;

/**
 * Normaliza o telefone para E.164: remove espaços, parênteses, traços e pontos. Já com `+`, mantém
 * o código do país. Sem `+`, só com DDD brasileiro (10 ou 11 dígitos), prefixa `+55`. Qualquer
 * outra forma sem `+` é recusada (não adivinhamos o país). Devolve `null` se não for válido.
 */
export function normalizarTelefone(entrada: string): string | null {
  const limpo = entrada.replace(/[\s().-]/g, "");
  if (limpo.startsWith("+")) return E164.test(limpo) ? limpo : null;
  if (/^[0-9]{10,11}$/.test(limpo)) {
    const e164 = `+55${limpo}`;
    return E164.test(e164) ? e164 : null;
  }
  return null;
}

/** `AAAA-MM` válido (ano 2000 a 2099, mês 01 a 12)? */
export function mesPassaporteValido(aaaaMm: string): boolean {
  return /^20[0-9]{2}-(0[1-9]|1[0-2])$/.test(aaaaMm);
}

/** Último dia do mês de um `AAAA-MM`, como data ISO `AAAA-MM-DD`. */
export function ultimoDiaDoMes(aaaaMm: string): string {
  const [a, m] = aaaaMm.split("-").map(Number) as [number, number];
  const dia = new Date(Date.UTC(a, m, 0)).getUTCDate();
  return `${aaaaMm}-${String(dia).padStart(2, "0")}`;
}

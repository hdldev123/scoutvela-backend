/** Utilitários de data do domínio (datas ISO AAAA-MM-DD, fuso de Brasília). */

/** Data (AAAA-MM-DD) de um instante no fuso America/Sao_Paulo. */
export function dataIso(instante: Date): string {
  return instante.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
}

/** Subtrai meses de uma data ISO, ajustando o dia ao fim do mês quando preciso. */
export function menosMeses(iso: string, meses: number): string {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  const total = a * 12 + (m - 1) - meses;
  const ano = Math.floor(total / 12);
  const mes = ((total % 12) + 12) % 12;
  const ultimoDia = new Date(Date.UTC(ano, mes + 1, 0)).getUTCDate();
  return `${ano}-${String(mes + 1).padStart(2, "0")}-${String(Math.min(d, ultimoDia)).padStart(2, "0")}`;
}

export function menosDias(iso: string, dias: number): string {
  const [a, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(a, m - 1, d - dias)).toISOString().slice(0, 10);
}

/** Data em (inicio, fim]: início exclusivo, fim inclusivo. */
export function naJanela(data: string, inicioExclusivo: string, fimInclusivo: string): boolean {
  return data > inicioExclusivo && data <= fimInclusivo;
}

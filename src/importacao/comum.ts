export interface ErroLinha {
  /** Posição do registro no arquivo; o cabeçalho é a linha 1. */
  linha: number;
  /** Sem dado pessoal: só o que está errado e em qual campo. */
  mensagem: string;
}

export interface ResultadoLinhas {
  linhasOk: number;
  erros: ErroLinha[];
}

/** Aceita AAAA-MM-DD ou DD/MM/AAAA; devolve AAAA-MM-DD ou null se inválida. */
export function lerData(texto: string): string | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(texto);
  const [a, m, d] = iso ? [iso[1], iso[2], iso[3]] : br ? [br[3], br[2], br[1]] : [];
  if (!a || !m || !d) return null;
  const data = new Date(Date.UTC(Number(a), Number(m) - 1, Number(d)));
  const confere =
    data.getUTCFullYear() === Number(a) && data.getUTCMonth() === Number(m) - 1 && data.getUTCDate() === Number(d);
  return confere ? `${a}-${m}-${d}` : null;
}

export function faltandoColunas(cabecalho: string[], obrigatorias: readonly string[]): string[] {
  return obrigatorias.filter((c) => !cabecalho.includes(c));
}

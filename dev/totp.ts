import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP (RFC 6238) sobre HOTP (RFC 4226) com HMAC-SHA1, só com node:crypto.
 * Usado apenas pelo emulador de Auth local (dev/). Não loga segredo nem código.
 */

const ALFABETO = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32 (RFC 4648) sem padding. */
export function base32Codificar(buf: Buffer): string {
  let bits = 0;
  let acumulado = 0;
  let saida = "";
  for (const byte of buf) {
    acumulado = (acumulado << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      saida += ALFABETO[(acumulado >>> (bits - 5)) & 31];
      bits -= 5;
    }
    acumulado &= (1 << bits) - 1;
  }
  if (bits > 0) saida += ALFABETO[(acumulado << (5 - bits)) & 31];
  return saida;
}

/** Decodifica base32 sem diferenciar maiúsculas de minúsculas; caractere fora do alfabeto lança erro. */
export function base32Decodificar(texto: string): Buffer {
  let bits = 0;
  let acumulado = 0;
  const bytes: number[] = [];
  for (const c of texto.toUpperCase()) {
    const valor = ALFABETO.indexOf(c);
    if (valor < 0) throw new Error("Caractere inválido em base32.");
    acumulado = (acumulado << 5) | valor;
    bits += 5;
    if (bits >= 8) {
      bytes.push((acumulado >>> (bits - 8)) & 255);
      bits -= 8;
      acumulado &= (1 << bits) - 1;
    }
  }
  return Buffer.from(bytes);
}

/** HOTP (RFC 4226): contador de 8 bytes big-endian e truncamento dinâmico. */
export function hotp(segredo: Buffer, contador: number | bigint, digitos = 6): string {
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(BigInt(contador));
  const h = createHmac("sha1", segredo).update(c).digest();
  const deslocamento = h[h.length - 1]! & 0x0f;
  const bin = h.readUInt32BE(deslocamento) & 0x7fffffff;
  return String(bin % 10 ** digitos).padStart(digitos, "0");
}

export interface OpcoesTotp {
  passo?: number;
  digitos?: number;
}

const numeroDoPasso = (instanteMs: number, passo: number): number => Math.floor(instanteMs / 1000 / passo);

/** TOTP (RFC 6238) no instante dado, em milissegundos Unix. */
export function totp(segredo: Buffer, instanteMs: number, { passo = 30, digitos = 6 }: OpcoesTotp = {}): string {
  return hotp(segredo, numeroDoPasso(instanteMs, passo), digitos);
}

/** Devolve o número do passo que bateu (dentro da janela ±N passos) ou null. */
export function verificarTotp(
  segredo: Buffer,
  codigo: string,
  instanteMs: number,
  { janela = 1, passo = 30, digitos = 6 }: OpcoesTotp & { janela?: number } = {},
): number | null {
  if (!new RegExp(`^[0-9]{${digitos}}$`).test(codigo)) return null;
  const atual = numeroDoPasso(instanteMs, passo);
  const recebido = Buffer.from(codigo);
  let achado: number | null = null;
  // Percorre toda a janela sem interromper, para não variar o tempo conforme o passo que bateu.
  for (let d = -janela; d <= janela; d++) {
    const n = atual + d;
    if (n < 0) continue;
    const bate = timingSafeEqual(Buffer.from(hotp(segredo, n, digitos)), recebido);
    if (bate && achado === null) achado = n;
  }
  return achado;
}

/** Segredo novo de 20 bytes (160 bits, tamanho recomendado para SHA-1). */
export function novoSegredoTotp(): Buffer {
  return randomBytes(20);
}

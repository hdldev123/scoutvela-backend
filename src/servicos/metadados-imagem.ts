/**
 * Remoção de metadados de imagem (EXIF, GPS, XMP, comentários e textos embutidos), sem dependência.
 * Funções puras: recebem os bytes e devolvem os bytes sem os blocos de metadados. A imagem em si
 * (pixels, perfil de cor ICC, tabelas) segue idêntica.
 *
 * - JPEG: remove os segmentos APP1 (Exif e XMP), APP13 (Photoshop/IPTC) e COM; o que vem depois do
 *   EOI (miniaturas e dados escondidos) também sai.
 * - PNG: remove os chunks eXIf, tEXt, iTXt e zTXt; os demais seguem com o CRC original. O que vem
 *   depois do IEND sai.
 */

/** Arquivo que não segue a estrutura de JPEG ou PNG. A rota traduz para 400. */
export class ImagemInvalida extends Error {}

const SEGMENTOS_JPEG_REMOVIDOS = new Set([0xe1, 0xed, 0xfe]);
const CHUNKS_PNG_REMOVIDOS = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);
const ASSINATURA_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

export function removerMetadadosJpeg(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new ImagemInvalida("JPEG inválido.");
  const partes: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i < n) {
    if (bytes[i] !== 0xff) throw new ImagemInvalida("JPEG inválido.");
    // Bytes 0xFF de preenchimento antes do marcador.
    let j = i;
    while (j + 1 < n && bytes[j + 1] === 0xff) j++;
    if (j + 1 >= n) throw new ImagemInvalida("JPEG inválido.");
    const marcador = bytes[j + 1]!;
    if (marcador === 0xd9) {
      partes.push(bytes.subarray(j, j + 2)); // EOI: o que vier depois não é imagem
      return juntar(partes);
    }
    // Marcadores sem tamanho: TEM e RST0..RST7.
    if (marcador === 0x01 || (marcador >= 0xd0 && marcador <= 0xd7)) {
      partes.push(bytes.subarray(i, j + 2));
      i = j + 2;
      continue;
    }
    if (marcador === 0x00 || j + 3 >= n) throw new ImagemInvalida("JPEG inválido.");
    const tamanho = (bytes[j + 2]! << 8) | bytes[j + 3]!;
    const fim = j + 2 + tamanho;
    if (tamanho < 2 || fim > n) throw new ImagemInvalida("JPEG inválido.");
    if (!SEGMENTOS_JPEG_REMOVIDOS.has(marcador)) partes.push(bytes.subarray(i, fim));
    i = fim;
    if (marcador === 0xda) {
      // Dados da varredura: copiados até o próximo marcador de verdade (FF 00, FF RSTn e FF FF são dados).
      let k = i;
      while (k < n) {
        if (bytes[k] === 0xff && k + 1 < n) {
          const prox = bytes[k + 1]!;
          if (prox === 0xff) {
            k++;
            continue;
          }
          if (prox !== 0x00 && !(prox >= 0xd0 && prox <= 0xd7)) break;
          k += 2;
          continue;
        }
        k++;
      }
      partes.push(bytes.subarray(i, k));
      i = k;
    }
  }
  return juntar(partes);
}

export function removerMetadadosPng(bytes: Uint8Array): Uint8Array {
  const n = bytes.length;
  if (n < 8 || !ASSINATURA_PNG.every((b, i) => bytes[i] === b)) {
    throw new ImagemInvalida("PNG inválido.");
  }
  const partes: Uint8Array[] = [bytes.subarray(0, 8)];
  let i = 8;
  while (i < n) {
    if (i + 12 > n) throw new ImagemInvalida("PNG inválido.");
    const tamanho =
      bytes[i]! * 0x1000000 + ((bytes[i + 1]! << 16) | (bytes[i + 2]! << 8) | bytes[i + 3]!);
    const tipo = String.fromCharCode(bytes[i + 4]!, bytes[i + 5]!, bytes[i + 6]!, bytes[i + 7]!);
    const fim = i + 12 + tamanho;
    if (fim > n) throw new ImagemInvalida("PNG inválido.");
    if (!CHUNKS_PNG_REMOVIDOS.has(tipo)) partes.push(bytes.subarray(i, fim));
    i = fim;
    if (tipo === "IEND") return juntar(partes);
  }
  return juntar(partes);
}

/** JPEG ou PNG sem metadados; outros tipos (PDF) voltam como estão. */
export function removerMetadadosImagem(bytes: Uint8Array, tipoMime: string): Uint8Array {
  if (tipoMime === "image/jpeg") return removerMetadadosJpeg(bytes);
  if (tipoMime === "image/png") return removerMetadadosPng(bytes);
  return bytes;
}

function juntar(partes: Uint8Array[]): Uint8Array {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let pos = 0;
  for (const p of partes) {
    saida.set(p, pos);
    pos += p.length;
  }
  return saida;
}

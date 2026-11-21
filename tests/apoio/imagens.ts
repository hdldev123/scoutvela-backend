/** Imagens mínimas, estruturalmente válidas, para os testes de upload (JPEG e PNG). */

const TABELA_CRC = (() => {
  const t: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t.push(c >>> 0);
  }
  return t;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = TABELA_CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Segmento JPEG com marcador e tamanho: FF mm LLLL dados. */
export function segmentoJpeg(marcador: number, dados: Uint8Array): Buffer {
  return Buffer.concat([Buffer.from([0xff, marcador]), u16(dados.length + 2), dados]);
}

export interface OpcoesJpeg {
  /** Tamanho total desejado (preenche os dados da imagem). */
  tamanho?: number;
  /** Segmentos extras logo depois do APP0 (ex.: APP1 com EXIF). */
  extras?: Buffer[];
  /** Bytes depois do EOI (ex.: miniatura escondida). */
  depoisDoEoi?: Buffer;
}

export function jpegValido(o: OpcoesJpeg = {}): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const app0 = segmentoJpeg(0xe0, Buffer.from("JFIF\0\x01\x01\0\0\x01\0\x01\0\0", "latin1"));
  const extras = Buffer.concat(o.extras ?? []);
  const sos = segmentoJpeg(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0]));
  const eoi = Buffer.from([0xff, 0xd9]);
  const fixo = soi.length + app0.length + extras.length + sos.length + eoi.length;
  // Dados da varredura sem 0xFF (nenhum marcador falso); um FF 00 no meio testa o byte stuffing.
  const n = Math.max(4, (o.tamanho ?? fixo + 8) - fixo);
  const dados = Buffer.alloc(n, 0x11);
  dados[1] = 0xff;
  dados[2] = 0x00;
  return Buffer.concat([soi, app0, extras, sos, dados, eoi, o.depoisDoEoi ?? Buffer.alloc(0)]);
}

export function chunkPng(tipo: string, dados: Uint8Array): Buffer {
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
  return Buffer.concat([u32(dados.length), corpo, u32(crc32(corpo))]);
}

export interface OpcoesPng {
  tamanho?: number;
  /** Chunks extras entre o IHDR e o IDAT (ex.: eXIf, tEXt). */
  extras?: Buffer[];
  depoisDoIend?: Buffer;
}

export function pngValido(o: OpcoesPng = {}): Buffer {
  const assinatura = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = chunkPng("IHDR", Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]));
  const extras = Buffer.concat(o.extras ?? []);
  const iend = chunkPng("IEND", Buffer.alloc(0));
  const fixo = assinatura.length + ihdr.length + extras.length + 12 + iend.length;
  const idat = chunkPng("IDAT", Buffer.alloc(Math.max(1, (o.tamanho ?? fixo + 4) - fixo), 0x22));
  return Buffer.concat([assinatura, ihdr, extras, idat, iend, o.depoisDoIend ?? Buffer.alloc(0)]);
}

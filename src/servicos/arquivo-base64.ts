import { requisicaoInvalida } from "../erros.js";
import { ImagemInvalida, removerMetadadosImagem } from "./metadados-imagem.js";

export const TIPOS_ARQUIVO = {
  "application/pdf": { ext: "pdf", assinatura: [0x25, 0x50, 0x44, 0x46] },
  "image/png": { ext: "png", assinatura: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", assinatura: [0xff, 0xd8, 0xff] },
} as const;

export type TipoArquivo = keyof typeof TIPOS_ARQUIVO;

/** Decodifica e confere tamanho e assinatura; erro vira 400. */
export function decodificarArquivo(
  conteudoBase64: string,
  tipoMime: TipoArquivo,
  limite: { bytes: number; mensagem: string },
): Buffer {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(conteudoBase64) || conteudoBase64.length % 4 !== 0) {
    throw requisicaoInvalida("Conteúdo do arquivo inválido.");
  }
  const bytes = Buffer.from(conteudoBase64, "base64");
  if (bytes.length === 0) throw requisicaoInvalida("Arquivo vazio.");
  if (bytes.length > limite.bytes) throw requisicaoInvalida(limite.mensagem);
  if (!TIPOS_ARQUIVO[tipoMime].assinatura.every((b, i) => bytes[i] === b)) {
    throw requisicaoInvalida("O conteúdo do arquivo não corresponde ao tipo informado.");
  }
  return bytes;
}

/**
 * JPEG e PNG saem sem EXIF, GPS, XMP nem comentários (a localização e o aparelho do atleta são
 * dado pessoal). PDF segue como veio. Imagem que não segue a estrutura do formato vira 400.
 */
export function limparMetadados(bytes: Buffer, tipoMime: TipoArquivo): Buffer {
  try {
    return Buffer.from(removerMetadadosImagem(bytes, tipoMime));
  } catch (e) {
    if (e instanceof ImagemInvalida) throw requisicaoInvalida("Imagem inválida ou corrompida.");
    throw e;
  }
}

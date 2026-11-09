import type { ArmazenamentoEvidencias } from "../../src/storage/index.js";

export interface ArmazenamentoFake extends ArmazenamentoEvidencias {
  arquivos: Map<string, { bytes: Uint8Array; tipoMime: string }>;
  falhar: boolean;
}

/** Armazenamento em memória para os testes. */
export function criarArmazenamentoFake(): ArmazenamentoFake {
  const arquivos = new Map<string, { bytes: Uint8Array; tipoMime: string }>();
  const fake: ArmazenamentoFake = {
    arquivos,
    falhar: false,
    async salvar(caminho, bytes, tipoMime) {
      if (fake.falhar) throw new Error("storage fora do ar");
      arquivos.set(caminho, { bytes, tipoMime });
    },
    async linkTemporario(caminho) {
      if (fake.falhar) throw new Error("storage fora do ar");
      return { url: `https://storage.teste/assinado/${caminho}?token=abc`, expiraEm: "2026-11-06T15:05:00.000Z" };
    },
  };
  return fake;
}

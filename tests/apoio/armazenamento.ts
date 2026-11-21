import type { ArmazenamentoEvidencias } from "../../src/storage/index.js";

export interface ArmazenamentoFake extends ArmazenamentoEvidencias {
  arquivos: Map<string, { bytes: Uint8Array; tipoMime: string }>;
  falhar: boolean;
  /** Quando true, remover lança erro. */
  falharRemocao: boolean;
  /** Caminhos cuja remoção falha (os demais seguem normais). */
  falharCaminhos: Set<string>;
  /** Quando true, listar lança erro. */
  falharListagem: boolean;
  /** Registro das chamadas em lote de linksTemporarios. */
  chamadasEmLote: { caminho: string; tipoMime: string }[][];
}

/** Armazenamento em memória para os testes. */
export function criarArmazenamentoFake(): ArmazenamentoFake {
  const arquivos = new Map<string, { bytes: Uint8Array; tipoMime: string }>();
  const fake: ArmazenamentoFake = {
    arquivos,
    falhar: false,
    falharRemocao: false,
    falharCaminhos: new Set(),
    falharListagem: false,
    chamadasEmLote: [],
    async salvar(caminho, bytes, tipoMime) {
      if (fake.falhar) throw new Error("storage fora do ar");
      arquivos.set(caminho, { bytes, tipoMime });
    },
    async linkTemporario(caminho) {
      if (fake.falhar) throw new Error("storage fora do ar");
      return {
        url: `https://storage.teste/assinado/${caminho}?token=abc`,
        expiraEm: "2026-11-06T15:05:00.000Z",
      };
    },
    async linksTemporarios(itens) {
      fake.chamadasEmLote.push(itens);
      if (fake.falhar) throw new Error("storage fora do ar");
      return new Map(
        itens.map((i) => [
          i.caminho,
          {
            url: `https://storage.teste/assinado/${i.caminho}?token=abc`,
            expiraEm: "2026-11-06T15:05:00.000Z",
          },
        ]),
      );
    },
    async listar(prefixo) {
      if (fake.falharListagem) throw new Error("storage fora do ar");
      return [...arquivos.keys()].filter((c) => c.startsWith(prefixo));
    },
    async remover(caminho) {
      if (fake.falharRemocao || fake.falharCaminhos.has(caminho))
        throw new Error("storage fora do ar");
      arquivos.delete(caminho);
    },
  };
  return fake;
}

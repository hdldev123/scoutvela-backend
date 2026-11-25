import { describe, expect, it } from "vitest";
import { normalizarWsId, wsIdValido } from "../../src/domain/index.js";

describe("ID World Sailing", () => {
  it("normaliza: maiúsculas e sem espaços", () => {
    expect(normalizarWsId(" gbr hm15 ")).toBe("GBRHM15");
    expect(normalizarWsId("bra\trb51\n")).toBe("BRARB51");
  });

  it("aceita os exemplos públicos e o formato tolerante", () => {
    for (const id of ["ESPFE", "GBRHM15", "NZLPB2", "BRARB51", "BRAAB", "BRAABCDEFGHIJKL"]) {
      expect(wsIdValido(id), id).toBe(true);
    }
  });

  it("recusa país incompleto, símbolos, tamanho fora da faixa e minúsculas sem normalizar", () => {
    for (const id of [
      "",
      "BR",
      "BRA",
      "BRA1",
      "1BRAAB",
      "BRA-123",
      "BRA_123",
      "BRAABCDEFGHIJKLM",
      "braab1",
      "BRAÃO1",
    ]) {
      expect(wsIdValido(id), id).toBe(false);
    }
  });
});

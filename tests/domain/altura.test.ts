import { describe, expect, it } from "vitest";
import { situacaoAltura } from "../../src/domain/index.js";

const FAIXA = { minCm: 180, maxCm: 190 };

describe("situacaoAltura (informativa, fora do score e dos gates)", () => {
  it("dentro da faixa, limites inclusive", () => {
    expect(situacaoAltura(185, FAIXA)).toBe("dentro");
    expect(situacaoAltura(180, FAIXA)).toBe("dentro");
    expect(situacaoAltura(190, FAIXA)).toBe("dentro");
  });

  it("abaixo e acima", () => {
    expect(situacaoAltura(179.9, FAIXA)).toBe("abaixo");
    expect(situacaoAltura(190.1, FAIXA)).toBe("acima");
  });

  it("nula se faltar a altura ou a faixa", () => {
    expect(situacaoAltura(null, FAIXA)).toBeNull();
    expect(situacaoAltura(185, null)).toBeNull();
    expect(situacaoAltura(null, null)).toBeNull();
  });
});

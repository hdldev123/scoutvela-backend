import { describe, expect, it } from "vitest";
import { notaSugeridaPorPontos } from "../../src/domain/index.js";

const FAIXAS = [
  { ate: 100, nota: 1 },
  { ate: 200, nota: 2 },
  { ate: 300, nota: 4 },
];

describe("notaSugeridaPorPontos (regra PERF_PONTOS)", () => {
  it("desligada ou sem faixas: sem sugestão", () => {
    expect(notaSugeridaPorPontos(250, { ativa: false, faixas: FAIXAS })).toBeNull();
    expect(notaSugeridaPorPontos(250, { ativa: true, faixas: [] })).toBeNull();
  });

  it("primeira faixa com pontos até o limite, inclusive", () => {
    const regra = { ativa: true, faixas: FAIXAS };
    expect(notaSugeridaPorPontos(0, regra)).toEqual({ nota: 1, pontos: 0 });
    expect(notaSugeridaPorPontos(100, regra)).toEqual({ nota: 1, pontos: 100 });
    expect(notaSugeridaPorPontos(100.01, regra)).toEqual({ nota: 2, pontos: 100.01 });
    expect(notaSugeridaPorPontos(300, regra)).toEqual({ nota: 4, pontos: 300 });
  });

  it("acima da última faixa vale a nota dela", () => {
    expect(notaSugeridaPorPontos(999, { ativa: true, faixas: FAIXAS })).toEqual({
      nota: 4,
      pontos: 999,
    });
  });

  it("não depende da ordem em que as faixas chegam", () => {
    const regra = { ativa: true, faixas: [...FAIXAS].reverse() };
    expect(notaSugeridaPorPontos(150, regra)).toEqual({ nota: 2, pontos: 150 });
  });
});

import { describe, expect, it } from "vitest";
import {
  posicaoNaTurma,
  resumoDaTurma,
  tendenciaDoAtleta,
  type CicloDaTurma,
} from "../../src/domain/index.js";

const c = (n: number, media: number, scoreDoAtleta: number | null, atletas = 14): CicloDaTurma => ({
  cicloId: `id-${n}`,
  ciclo: `Ciclo ${n}`,
  media,
  atletas,
  scoreDoAtleta,
});

describe("posicaoNaTurma (limiar 2)", () => {
  it.each([
    [5, "acima"],
    [2, "acima"],
    [1.99, "na_media"],
    [0, "na_media"],
    [-1.99, "na_media"],
    [-2, "abaixo"],
    [-8, "abaixo"],
  ])("diferença %s -> %s", (dif, esperado) => {
    expect(posicaoNaTurma(dif, 2)).toBe(esperado);
  });
});

describe("tendenciaDoAtleta (limiar 2)", () => {
  it.each([
    [[70, 73], "subindo"],
    [[70, 72], "subindo"],
    [[70, 71.9], "estavel"],
    [[70, 70], "estavel"],
    [[70, 68.1], "estavel"],
    [[70, 68], "caindo"],
    [[50, 70, 65], "caindo"],
    [[90, 60, 62.5], "subindo"],
    [[70], null],
    [[], null],
  ] as [number[], string | null][])("%j -> %s", (scores, esperado) => {
    expect(tendenciaDoAtleta(scores, 2)).toBe(esperado);
  });

  it("o limiar muda o resultado", () => {
    expect(tendenciaDoAtleta([70, 73], 5)).toBe("estavel");
    expect(tendenciaDoAtleta([70, 73], 1)).toBe("subindo");
  });
});

describe("resumoDaTurma", () => {
  it("média por ciclo alinhada, comparação e tendência", () => {
    const r = resumoDaTurma([c(1, 70.123, 60), c(2, 72, 75.5), c(3, 71.004, 80)], 2, null);
    expect(r.mediaTurmaPorCiclo).toEqual([
      { cicloId: "id-1", ciclo: "Ciclo 1", media: 70.12, atletas: 14 },
      { cicloId: "id-2", ciclo: "Ciclo 2", media: 72, atletas: 14 },
      { cicloId: "id-3", ciclo: "Ciclo 3", media: 71, atletas: 14 },
    ]);
    expect(r.comparacaoTurma).toEqual({
      scoreAtual: 80,
      mediaTurma: 71,
      diferenca: 9,
      posicao: "acima",
    });
    expect(r.tendencia).toBe("subindo");
  });

  it("posição: acima, na média e abaixo no último ciclo", () => {
    expect(resumoDaTurma([c(1, 70, 70), c(2, 70, 74)], 2, null).comparacaoTurma?.posicao).toBe(
      "acima",
    );
    expect(resumoDaTurma([c(1, 70, 70), c(2, 70, 71)], 2, null).comparacaoTurma?.posicao).toBe(
      "na_media",
    );
    expect(resumoDaTurma([c(1, 70, 70), c(2, 70, 60)], 2, null).comparacaoTurma?.posicao).toBe(
      "abaixo",
    );
  });

  it("usa o último ciclo em que o atleta tem score, e a tendência só os ciclos dele", () => {
    const r = resumoDaTurma([c(1, 70, 60), c(2, 71, 66), c(3, 72, null)], 2, null);
    expect(r.mediaTurmaPorCiclo).toHaveLength(3);
    expect(r.comparacaoTurma).toMatchObject({ scoreAtual: 66, mediaTurma: 71, posicao: "abaixo" });
    expect(r.tendencia).toBe("subindo");
  });

  it("um ciclo só: comparação existe, tendência nula", () => {
    const r = resumoDaTurma([c(1, 70, 75)], 2, null);
    expect(r.comparacaoTurma).toMatchObject({ diferenca: 5, posicao: "acima" });
    expect(r.tendencia).toBeNull();
  });

  it("sem ciclo fechado ou sem score do atleta: tudo nulo ou vazio", () => {
    expect(resumoDaTurma([], 2, null)).toEqual({
      mediaTurmaPorCiclo: [],
      comparacaoTurma: null,
      tendencia: null,
    });
    const r = resumoDaTurma([c(1, 70, null)], 2, null);
    expect(r.mediaTurmaPorCiclo).toHaveLength(1);
    expect(r.comparacaoTurma).toBeNull();
    expect(r.tendencia).toBeNull();
  });

  it("grupo pequeno para o IBVAR: média e comparação nulas, tendência (do próprio atleta) mantida", () => {
    const ciclos = [c(1, 70, 60, 2), c(2, 71, 70, 2), c(3, 72, 80, 5)];
    const ibvar = resumoDaTurma(ciclos, 2, 3);
    expect(ibvar.mediaTurmaPorCiclo.map((m) => m.media)).toEqual([null, null, 72]);
    expect(ibvar.mediaTurmaPorCiclo.map((m) => m.atletas)).toEqual([2, 2, 5]);
    expect(ibvar.comparacaoTurma).toMatchObject({ mediaTurma: 72 });
    expect(ibvar.tendencia).toBe("subindo");

    const suprimido = resumoDaTurma([c(1, 70, 60, 5), c(2, 71, 70, 2)], 2, 3);
    expect(suprimido.comparacaoTurma).toBeNull();
    expect(resumoDaTurma([c(2, 71, 70, 2)], 2, null).comparacaoTurma).not.toBeNull();
  });
});

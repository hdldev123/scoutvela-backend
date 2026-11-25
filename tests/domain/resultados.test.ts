import { describe, expect, it } from "vitest";
import {
  explicacaoDaNota,
  nivelDeNota,
  notaDaColocacao,
  notaDeResultados,
} from "../../src/domain/index.js";
import type {
  NivelCompeticao,
  RegraResultados,
  ResultadoParaNota,
} from "../../src/domain/index.js";
import { REGRAS_TESTE } from "../apoio/parametros-teste.js";

const regra: RegraResultados = REGRAS_TESTE.perfResultados;

const r = (
  nivel: NivelCompeticao,
  edicao: number,
  posicao: number,
  evento = `Evento ${nivel} ${edicao}`,
): ResultadoParaNota => ({ nivel, evento, edicao, posicao, data: `${edicao}-07-01` });

describe("nivelDeNota (nível do resultado → nível da nota)", () => {
  it("mundial, continental (inclui Sul-Americano) e nacional (Brasileiro); o resto não gera nota", () => {
    const mapa: [NivelCompeticao, string | null][] = [
      ["mundial", "mundial"],
      ["sul_americano", "continental"],
      ["continental", "continental"],
      ["brasileiro", "nacional"],
      ["internacional_aberto", null],
      ["estadual", null],
      ["regional", null],
    ];
    for (const [nivel, esperado] of mapa) expect(nivelDeNota(nivel)).toBe(esperado);
  });
});

describe("notaDaColocacao (tabela de casos, sem depender da frota)", () => {
  const casos: [string, number, number][] = [
    ["mundial", 1, 5],
    ["mundial", 3, 5],
    ["mundial", 4, 4],
    ["mundial", 10, 4],
    ["mundial", 11, 3],
    ["mundial", 25, 3],
    ["mundial", 26, 2],
    ["mundial", 400, 2],
    ["continental", 3, 5],
    ["continental", 26, 2],
    ["nacional", 1, 5],
    ["nacional", 2, 4],
    ["nacional", 3, 3],
    ["nacional", 4, 0],
    ["nacional", 30, 0],
  ];
  for (const [nivel, posicao, nota] of casos) {
    it(`${nivel}: ${posicao}º vale ${nota}`, () => {
      expect(notaDaColocacao(posicao, regra.niveis[nivel as "mundial"])).toBe(nota);
    });
  }
  it("sem faixa que sirva, vale 0", () => {
    expect(notaDaColocacao(9, [{ ate: 3, nota: 5 }])).toBe(0);
  });
});

describe("notaDeResultados", () => {
  it("sem resultado validado no nível: nota nula", () => {
    expect(notaDeResultados([], regra)).toEqual({
      mundial: null,
      continental: null,
      nacional: null,
    });
    const so = notaDeResultados([r("mundial", 2026, 2)], regra);
    expect(so.mundial?.nota).toBe(5);
    expect(so.continental).toBeNull();
    expect(so.nacional).toBeNull();
  });

  it("vale a MELHOR colocação (exemplo da reunião: cinco mundiais sem pódio não dão 5)", () => {
    const cinco = [2022, 2023, 2024, 2025, 2026].map((ano, i) => r("mundial", ano, 12 + i));
    const n = notaDeResultados(cinco, { ...regra, edicoesMax: 5 }).mundial!;
    expect(n.nota).toBe(3);
    expect(n.posicao).toBe(12);
    expect(n.edicao).toBe(2022);
  });

  it("só as edicoesMax edições mais recentes entram: o pódio antigo fica de fora", () => {
    const lista = [r("mundial", 2021, 1), r("mundial", 2023, 15), r("mundial", 2024, 20)];
    expect(notaDeResultados(lista, { ...regra, edicoesMax: 2 }).mundial).toMatchObject({
      nota: 3,
      posicao: 15,
      edicao: 2023,
    });
    expect(notaDeResultados(lista, { ...regra, edicoesMax: 3 }).mundial).toMatchObject({
      nota: 5,
      posicao: 1,
      edicao: 2021,
    });
  });

  it("a ordem de entrada não importa e o empate fica com a edição mais recente", () => {
    const a = [r("mundial", 2023, 8), r("mundial", 2025, 8), r("mundial", 2024, 30)];
    const b = [...a].reverse();
    expect(notaDeResultados(a, regra).mundial?.edicao).toBe(2025);
    expect(notaDeResultados(b, regra).mundial).toEqual(notaDeResultados(a, regra).mundial);
  });

  it("agrupa por nível: Sul-Americano e continental valem no continental, Brasileiro no nacional", () => {
    const n = notaDeResultados(
      [
        r("sul_americano", 2026, 2),
        r("continental", 2025, 9),
        r("brasileiro", 2026, 1),
        r("estadual", 2026, 1),
        r("regional", 2026, 1),
        r("internacional_aberto", 2026, 1),
      ],
      regra,
    );
    expect(n.mundial).toBeNull();
    expect(n.continental).toMatchObject({ nota: 5, posicao: 2 });
    expect(n.nacional).toMatchObject({ nota: 5, posicao: 1 });
  });

  it("nacional: só o pódio conta, fora dele vale 0 (e é nota, não ausência)", () => {
    expect(notaDeResultados([r("brasileiro", 2026, 4)], regra).nacional?.nota).toBe(0);
    expect(
      notaDeResultados([r("brasileiro", 2026, 4), r("brasileiro", 2025, 3)], regra).nacional,
    ).toMatchObject({ nota: 3, posicao: 3 });
  });

  it("usa a regra recebida (faixas e limite de edições são parâmetro)", () => {
    const outra: RegraResultados = {
      edicoesMax: 1,
      niveis: {
        ...regra.niveis,
        mundial: [
          { ate: 1, nota: 5 },
          { ate: null, nota: 1 },
        ],
      },
    };
    const lista = [r("mundial", 2024, 1), r("mundial", 2026, 2)];
    expect(notaDeResultados(lista, outra).mundial).toMatchObject({ nota: 1, edicao: 2026 });
  });

  it("explicação traz nível, colocação e edição", () => {
    const n = notaDeResultados([r("mundial", 2026, 12, "Mundial de ILCA 6")], regra).mundial!;
    expect(explicacaoDaNota(n)).toBe(
      "Melhor colocação validada no Mundial: 12º em 2026 (Mundial de ILCA 6)",
    );
  });
});

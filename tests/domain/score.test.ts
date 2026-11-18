import { describe, expect, it } from "vitest";
import {
  calcularAtleta,
  calcularScore,
  distanciaClassFit,
  faixaDoScore,
  funcaoNaClasse,
  idadeEm,
  notaPeso,
  notaPilar,
  notasEfetivas,
  pontosRankingCbvela,
} from "../../src/domain/index.js";
import type { Classe } from "../../src/domain/index.js";
import {
  entradaDeTeste,
  notasUniformes,
  parametrosDeTeste,
  REFERENCIA_TESTE,
  resultadoDeTeste,
} from "../apoio/parametros-teste.js";

// Classe sintética: média 85, meia faixa 5 (distâncias exatas em ponto flutuante).
const CLASSE_SINTETICA: Classe = {
  id: "x",
  nome: "X",
  evento: "X",
  posicao: "ind",
  pesoMinKg: 80,
  pesoMedioKg: 85,
  pesoMaxKg: 90,
};

describe("distanciaClassFit", () => {
  it("calcula delta e distância relativa à meia faixa", () => {
    const r = distanciaClassFit(87.5, CLASSE_SINTETICA);
    expect(r.deltaKg).toBe(2.5);
    expect(r.distanciaRelativa).toBe(0.5);
  });
  it("delta negativo abaixo da média; distância sempre positiva", () => {
    const r = distanciaClassFit(80, CLASSE_SINTETICA);
    expect(r.deltaKg).toBe(-5);
    expect(r.distanciaRelativa).toBe(1);
  });
});

describe("notaPeso", () => {
  const limites = [0.5, 1, 1.5, 2, 3];
  it("respeita os limites (inclusive) e passa de nota ao exceder", () => {
    expect([0.5, 1, 1.5, 2, 3, 3.1].map((d) => notaPeso(d, limites))).toEqual([5, 4, 3, 2, 1, 0]);
  });
  it("é genérico: limites[i] é o teto da nota 5 − i", () => {
    expect([0.1, 0.2, 0.3, 0.31].map((d) => notaPeso(d, [0.1, 0.2, 0.3]))).toEqual([5, 4, 3, 0]);
  });
});

describe("notasEfetivas", () => {
  const parametros = parametrosDeTeste();
  it("calcula cf_peso_kg pela P3 e ignora lançamento", () => {
    const n = notasEfetivas(parametros, {
      classe: CLASSE_SINTETICA,
      pesoKg: 90,
      notas: { cf_peso_kg: 5, perf_mundial: 3 },
    });
    expect(n.cf_peso_kg).toBe(4); // rel 1 → 4
    expect(n.perf_mundial).toBe(3);
  });
  it("sem peso, cf_peso_kg fica sem nota", () => {
    const n = notasEfetivas(parametros, {
      classe: CLASSE_SINTETICA,
      pesoKg: null,
      notas: { cf_peso_kg: 5 },
    });
    expect(n.cf_peso_kg).toBeNull();
  });
  it("usa os limites dos parâmetros", () => {
    const p = parametrosDeTeste();
    p.regras.p3.limites = [0.1, 0.2, 0.3, 0.4, 0.5];
    const n = notasEfetivas(p, { classe: CLASSE_SINTETICA, pesoKg: 90, notas: {} });
    expect(n.cf_peso_kg).toBe(0);
  });
});

describe("notaPilar", () => {
  const amb = parametrosDeTeste().pilares.find((p) => p.id === "amb")!;
  it("ignora indicador tipo R e notas nulas ou ausentes", () => {
    const n = notaPilar(amb, {
      amb_apoio_familiar: 4,
      amb_disponibilidade: 2,
      amb_estabilidade: null,
      amb_historico_familiar: 5, // R: não pontua
    });
    expect(n).toBe(3);
  });
  it("nulo quando nenhum indicador tem nota", () => {
    expect(notaPilar(amb, { amb_historico_familiar: 5 })).toBeNull();
  });
});

describe("calcularScore", () => {
  const { pilares } = parametrosDeTeste();
  it("todas as notas 5 dão 100; todas 0 dão 0", () => {
    expect(calcularScore(pilares, { ...notasUniformes(5), cf_peso_kg: 5 })).toBeCloseTo(100, 9);
    expect(calcularScore(pilares, { ...notasUniformes(0), cf_peso_kg: 0 })).toBe(0);
  });
  it("pilar sem nota contribui 0", () => {
    const notas: Record<string, number | null> = { ...notasUniformes(5), cf_peso_kg: 5 };
    for (const i of pilares.find((p) => p.id === "perf")!.indicadores) notas[i.id] = null;
    expect(calcularScore(pilares, notas)).toBeCloseTo(80, 9);
  });
  it("pesos alterados mudam o score (parâmetro, não constante)", () => {
    const p2 = parametrosDeTeste().pilares;
    const notas: Record<string, number | null> = { ...notasUniformes(5), cf_peso_kg: 5 };
    for (const i of p2.find((p) => p.id === "perf")!.indicadores) notas[i.id] = 0;
    expect(calcularScore(p2, notas)).toBeCloseTo(80, 9);
    p2.find((p) => p.id === "perf")!.peso = 10;
    p2.find((p) => p.id === "car")!.peso = 15;
    expect(calcularScore(p2, notas)).toBeCloseTo(90, 9);
  });
});

describe("faixaDoScore", () => {
  const { faixas } = parametrosDeTeste();
  it("respeita os cortes", () => {
    expect([85, 84.9, 75, 74.9, 65, 64.9, 0].map((s) => faixaDoScore(s, faixas).id)).toEqual([
      "f1",
      "f2",
      "f2",
      "f3",
      "f3",
      "f4",
      "f4",
    ]);
  });
  it("não depende da ordem recebida", () => {
    expect(faixaDoScore(80, [...faixas].reverse()).id).toBe("f2");
  });
});

describe("pontosRankingCbvela", () => {
  const nac = (data: string, pts: number) => resultadoDeTeste({ data, pontosCbvela: pts });
  it("soma só nacionais e ignora internacionais", () => {
    const r = [
      nac("2026-08-22", 10),
      nac("2026-05-30", 5),
      resultadoDeTeste({
        internacional: true,
        nivel: "mundial",
        pontosCbvela: null,
        data: "2026-07-18",
      }),
    ];
    expect(pontosRankingCbvela(r, REFERENCIA_TESTE, 52)).toBe(15);
  });
  it("janela de 52 semanas: início exclusivo, fim inclusivo", () => {
    // referência 2026-11-06; 52 semanas = 364 dias → início 2025-11-07 (exclusivo)
    const r = [
      nac("2025-11-07", 1),
      nac("2025-11-08", 2),
      nac("2026-11-06", 4),
      nac("2026-11-07", 8),
    ];
    expect(pontosRankingCbvela(r, REFERENCIA_TESTE, 52)).toBe(6);
  });
  it("usa a janela do parâmetro", () => {
    const r = [nac("2026-10-01", 3), nac("2026-01-01", 7)];
    expect(pontosRankingCbvela(r, REFERENCIA_TESTE, 8)).toBe(3);
  });
});

describe("idadeEm", () => {
  it("conta anos completos", () => {
    expect(idadeEm("2008-02-17", REFERENCIA_TESTE)).toBe(18);
    expect(idadeEm("2008-11-06", REFERENCIA_TESTE)).toBe(18);
    expect(idadeEm("2008-11-07", REFERENCIA_TESTE)).toBe(17);
  });
});

describe("funcaoNaClasse", () => {
  it("resolve por posição e gênero", () => {
    expect(funcaoNaClasse("ind", "F")).toBe("Individual");
    expect(funcaoNaClasse("helm", "F")).toBe("Timoneira");
    expect(funcaoNaClasse("helm", "M")).toBe("Timoneiro");
    expect(funcaoNaClasse("crew", "F")).toBe("Proeira");
    expect(funcaoNaClasse("crew", "M")).toBe("Proeiro");
  });
});

describe("calcularAtleta", () => {
  it("monta o resultado e conta preenchimento sem R nem nulos", () => {
    const parametros = parametrosDeTeste();
    const r = calcularAtleta(
      parametros,
      entradaDeTeste({ notas: { ...notasUniformes(4), tec_trim: null } }),
    );
    expect(r.total).toBe(41); // 42 indicadores menos 1 do tipo R
    expect(r.preenchidos).toBe(40);
    expect(r.completo).toBe(false);
    expect(r.pilares).toHaveLength(9);
    expect(r.classFit?.deltaKg).toBeCloseTo(0, 9);
    expect(r.notas.cf_peso_kg).toBe(5);
  });
  it("completo quando todos pontuam; sem peso fica incompleto e sem classFit", () => {
    const parametros = parametrosDeTeste();
    expect(calcularAtleta(parametros, entradaDeTeste()).completo).toBe(true);
    const r = calcularAtleta(parametros, entradaDeTeste({ pesoKg: null }));
    expect(r.completo).toBe(false);
    expect(r.classFit).toBeNull();
  });
});

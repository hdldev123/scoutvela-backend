import { describe, expect, it } from "vitest";
import {
  evolucaoDaTurma,
  grupoPequeno,
  metaDeEvolucao,
  type CicloCongeladoEntrada,
} from "../../src/domain/index.js";

const FAIXAS = [
  { id: "f1", nome: "Prioridade" },
  { id: "f2", nome: "Alto potencial" },
  { id: "f4", nome: "No radar" },
];
const PILARES = [
  { id: "p1", nomeCurto: "Performance" },
  { id: "p2", nomeCurto: "Técnica" },
];

const linha = (
  score: number,
  faixaId: string,
  statusFinal: "apto" | "condicional" | "nao_prioritario" | null,
  p1: number | null,
  p2: number | null,
) => ({
  score,
  faixaId,
  statusFinal,
  pilares: new Map<string, number | null>([
    ["p1", p1],
    ["p2", p2],
  ]),
});

const ciclo = (
  id: string,
  completo: boolean,
  linhas: CicloCongeladoEntrada["linhas"],
): CicloCongeladoEntrada => ({
  id,
  nome: `Ciclo ${id}`,
  fechadoEm: "2026-10-01T00:00:00.000Z",
  congelamentoCompleto: completo,
  linhas,
});

const semPilares = (score: number, faixaId: string) => ({
  score,
  faixaId,
  statusFinal: null,
  pilares: null,
});

describe("grupoPequeno", () => {
  it.each([
    [2, 3, true],
    [3, 3, false],
    [0, 3, true],
    [1, null, false],
    [0, null, false],
  ])("%i atletas, mínimo %s -> %s", (n, minimo, esperado) => {
    expect(grupoPequeno(n, minimo)).toBe(esperado);
  });
});

describe("evolucaoDaTurma", () => {
  const completo = ciclo("a", true, [
    linha(90, "f1", "apto", 5, 4),
    linha(70, "f2", "condicional", 3, null),
    linha(50, "f4", "nao_prioritario", 1, 2),
  ]);
  const antigo = ciclo("b", false, [
    semPilares(80, "f2"),
    semPilares(60, "f4"),
    semPilares(40, "f4"),
  ]);

  it("média, pilares, funil e aptos de um ciclo com congelamento completo", () => {
    const [e] = evolucaoDaTurma([completo], FAIXAS, PILARES, null);
    expect(e).toMatchObject({
      atletas: 3,
      scoreMedio: 70,
      aptosNosGates: 1,
      congelamentoCompleto: true,
      suprimido: false,
    });
    expect(e!.mediaPorPilar).toEqual([
      { pilarId: "p1", nomeCurto: "Performance", media: 3 },
      { pilarId: "p2", nomeCurto: "Técnica", media: 3 },
    ]);
    expect(e!.funil).toEqual([
      { faixaId: "f1", nome: "Prioridade", n: 1 },
      { faixaId: "f2", nome: "Alto potencial", n: 1 },
      { faixaId: "f4", nome: "No radar", n: 1 },
    ]);
  });

  it("ciclo antigo: só score e funil; pilares e gates nulos", () => {
    const [e] = evolucaoDaTurma([antigo], FAIXAS, PILARES, 3);
    expect(e).toMatchObject({ scoreMedio: 60, mediaPorPilar: null, aptosNosGates: null });
    expect(e!.funil?.map((f) => f.n)).toEqual([0, 1, 2]);
  });

  it("grupo pequeno: suprimido para quem tem mínimo, aberto para quem não tem", () => {
    const pequeno = ciclo("c", true, [
      linha(88, "f1", "apto", 5, 5),
      linha(70, "f2", "apto", 4, 4),
    ]);
    const [ibvar] = evolucaoDaTurma([pequeno], FAIXAS, PILARES, 3);
    expect(ibvar).toEqual({
      ciclo: { id: "c", nome: "Ciclo c", fechadoEm: "2026-10-01T00:00:00.000Z" },
      atletas: 2,
      congelamentoCompleto: true,
      scoreMedio: null,
      mediaPorPilar: null,
      funil: null,
      aptosNosGates: null,
      suprimido: true,
    });
    const [gestor] = evolucaoDaTurma([pequeno], FAIXAS, PILARES, null);
    expect(gestor).toMatchObject({ scoreMedio: 79, suprimido: false, aptosNosGates: 2 });
  });

  it("ciclo sem atletas: média nula e funil zerado para o gestor", () => {
    const [e] = evolucaoDaTurma([ciclo("d", true, [])], FAIXAS, PILARES, null);
    expect(e).toMatchObject({ atletas: 0, scoreMedio: null, aptosNosGates: 0 });
    expect(e!.funil?.every((f) => f.n === 0)).toBe(true);
  });

  it("arredonda a média em duas casas", () => {
    const c = ciclo("e", false, [semPilares(70, "f2"), semPilares(70, "f2"), semPilares(71, "f2")]);
    expect(evolucaoDaTurma([c], FAIXAS, PILARES, null)[0]!.scoreMedio).toBe(70.33);
  });
});

describe("metaDeEvolucao", () => {
  const e = (id: string, scoreMedio: number | null) => ({
    ciclo: { id, nome: `Ciclo ${id}`, fechadoEm: null },
    scoreMedio,
  });

  it.each([
    ["atingida (+10%)", 60, 66, 10, 10, true],
    ["atingida (acima)", 60, 70, 10, 16.67, true],
    ["não atingida", 60, 63, 10, 5, false],
    ["queda", 60, 54, 10, -10, false],
    ["meta zero, sem variação", 60, 60, 0, 0, true],
  ])("%s", (_nome, base, atual, pct, variacao, atingida) => {
    const m = metaDeEvolucao([e("a", base), e("b", atual)], pct);
    expect(m).toMatchObject({
      percentual: pct,
      cicloBase: { id: "a", nome: "Ciclo a" },
      cicloAtual: { id: "b", nome: "Ciclo b" },
      mediaBase: base,
      mediaAtual: atual,
      variacaoPercentual: variacao,
      atingida,
    });
  });

  it("usa os dois últimos ciclos", () => {
    const m = metaDeEvolucao([e("a", 10), e("b", 60), e("c", 70)], 10);
    expect(m.cicloBase?.id).toBe("b");
    expect(m.cicloAtual?.id).toBe("c");
  });

  it("sem dois ciclos, tudo nulo", () => {
    for (const lista of [[], [e("a", 60)]]) {
      expect(metaDeEvolucao(lista, 10)).toEqual({
        percentual: 10,
        cicloBase: null,
        cicloAtual: null,
        mediaBase: null,
        mediaAtual: null,
        variacaoPercentual: null,
        atingida: null,
      });
    }
  });

  it("média oculta ou base zero: variação e meta nulas, ciclos mantidos", () => {
    expect(metaDeEvolucao([e("a", null), e("b", 60)], 10)).toMatchObject({
      cicloBase: { id: "a" },
      variacaoPercentual: null,
      atingida: null,
    });
    expect(metaDeEvolucao([e("a", 0), e("b", 60)], 10).atingida).toBeNull();
  });
});

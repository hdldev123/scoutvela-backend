import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import type { Parametros } from "../../src/domain/tipos.js";
import { carregarParametros } from "../../src/repositories/parametros.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

let db: Db;
let p: Parametros;
beforeAll(async () => {
  db = await criarBancoDeTeste();
  p = await carregarParametros(db);
});
afterAll(async () => {
  await db.fechar();
});

describe("Parâmetros iniciais (migration 0004)", () => {
  it("9 pilares na ordem, somando 100 pontos", () => {
    expect(p.pilares.map((x) => x.id)).toEqual([
      "perf",
      "cf",
      "tec",
      "tat",
      "pot",
      "exp",
      "men",
      "amb",
      "car",
    ]);
    expect(p.pilares.map((x) => x.peso)).toEqual([20, 20, 15, 10, 5, 5, 10, 10, 5]);
    expect(p.pilares.reduce((s, x) => s + x.peso, 0)).toBe(100);
    expect(p.pilares.filter((x) => x.sensivel).map((x) => x.id)).toEqual(["cf", "men", "amb"]);
  });

  it("indicadores por ordem; só cf_peso_kg é calculado", () => {
    const todos = p.pilares.flatMap((x) => x.indicadores);
    expect(todos).toHaveLength(42);
    expect(todos.filter((i) => i.calculado).map((i) => i.id)).toEqual(["cf_peso_kg"]);
    expect(todos.filter((i) => i.tipo === "R").map((i) => i.id)).toEqual([
      "amb_historico_familiar",
    ]);
    expect(todos.filter((i) => i.tipo === "A")).toHaveLength(7);
    expect(p.pilares[1]!.indicadores[0]!.id).toBe("cf_peso_kg");
  });

  it("4 faixas do maior para o menor", () => {
    expect(p.faixas.map((f) => [f.id, f.scoreMin])).toEqual([
      ["f1", 85],
      ["f2", 75],
      ["f3", 65],
      ["f4", 0],
    ]);
    expect(p.faixas[0]!.nome).toBe("Prioridade de programa");
    expect(p.faixas[0]!.nomeCurto).toBe("Prioridade");
  });

  it("14 classes, ILCA 7 e 470 Crew com valores do protótipo", () => {
    expect(p.classes).toHaveLength(14);
    expect(p.classes[0]!.id).toBe("470-helm");
    expect(p.classes.find((c) => c.id === "ilca7")).toMatchObject({
      pesoMinKg: 82.8,
      pesoMedioKg: 84.5,
      pesoMaxKg: 87.2,
      posicao: "ind",
    });
    expect(p.classes.find((c) => c.id === "470-crew")).toMatchObject({
      pesoMinKg: 70.4,
      pesoMedioKg: 73.6,
      pesoMaxKg: 76.8,
      posicao: "crew",
    });
  });

  it("regras padrão exatas", () => {
    expect(p.regras).toEqual({
      p3: { limites: [0.5, 1, 1.5, 2, 3] },
      g1: { aptoAte: 1, condicionalAte: 2 },
      g2: {
        mundialAptoAteFracao: 0.3,
        sulAmericanoCondicionalAtePosicao: 6,
        mundialCondicionalAteFracao: 0.5,
        brasileiroCondicionalAtePosicao: 3,
      },
      g3: { aptoMinEventos: 3, condicionalMinEventos: 1, janelaMeses: 24 },
      g4: {
        A: { status: "apto", motivo: "Plano e recursos para 36 meses" },
        B: { status: "apto", motivo: "Plano e recursos para 24 meses" },
        C: { status: "condicional", motivo: "Depende de apoio da CBVela" },
        D: { status: "alerta", motivo: "Sem estrutura para campanha internacional" },
      },
      rankingCbvela: { janelaSemanas: 52 },
      perfPontos: { ativa: false, faixas: [] },
    });
  });

  it("perguntas, opções, rubricas e componentes de custo", async () => {
    const q = async (sql: string) => Number((await db.query<{ n: string }>(sql)).rows[0]!.n);
    expect(await q("select count(*)::text n from perguntas_atleta")).toBe(8);
    expect(
      await q("select count(*)::text n from opcoes_resposta where nota_sugerida is null"),
    ).toBe(2);
    expect(await q("select count(*)::text n from rubricas where pilar_id is null")).toBe(6);
    expect(await q("select count(*)::text n from rubricas where pilar_id = 'exp'")).toBe(6);
    expect(await q("select count(*)::text n from componentes_custo")).toBe(8);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { motivoSemPeso } from "../../src/domain/index.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

describe("IBVAR não deduz o peso pela ficha", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
  });
  afterAll(() => p.encerrar());

  const ficha = async (email: string, velaid: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${await p.idDe(velaid)}`,
      headers: await p.como(email),
    });
    return r.json();
  };

  it("o motivo do G1 para o IBVAR não tem número nem kg; o gestor continua vendo a diferença", async () => {
    const gestor = await ficha(EMAILS_DEMO.gestor, "SC-T01");
    const g1Gestor = gestor.gates.itens.find((g: { gate: number }) => g.gate === 1);
    expect(g1Gestor.motivo).toMatch(/kg/);

    const ibvar = await ficha(EMAILS_DEMO.ibvar, "SC-T01");
    const g1 = ibvar.gates.itens.find((g: { gate: number }) => g.gate === 1);
    expect(g1.motivo).not.toMatch(/\d|kg/i);
    expect(g1.status).toBe(g1Gestor.status);
    // Os outros gates não trazem peso e seguem iguais.
    expect(ibvar.gates.itens.slice(1)).toEqual(gestor.gates.itens.slice(1));
  });

  it("a evidência em texto sai da ficha do IBVAR (pesagem e lançamentos), mas fica para o gestor", async () => {
    const gestor = await ficha(EMAILS_DEMO.gestor, "SC-T01");
    const ibvar = await ficha(EMAILS_DEMO.ibvar, "SC-T01");
    type Ind = { evidencia: string | null };
    const evidencias = (f: { pilares: { indicadores: Ind[] | null }[] }) =>
      f.pilares.flatMap((pl) => pl.indicadores ?? []).filter((i) => i.evidencia);
    expect(evidencias(gestor).length).toBeGreaterThan(0);
    expect(evidencias(ibvar)).toEqual([]);
  });

  it("motivoSemPeso: textos genéricos por situação", () => {
    const g = (sugestaoAutomatica: "apto" | "condicional" | "alerta", motivo = "x +0,4 kg") => ({
      gate: 1,
      sugestaoAutomatica,
      motivo,
    });
    expect(motivoSemPeso(g("apto"))).toBe("Dentro da faixa da classe");
    expect(motivoSemPeso(g("condicional"))).toBe("Leve desvio da faixa da classe");
    expect(motivoSemPeso(g("alerta"))).toBe("Fora da faixa da classe");
    expect(motivoSemPeso(g("alerta", "Sem pesagem registrada"))).toBe("Sem pesagem registrada");
    expect(motivoSemPeso({ gate: 2, sugestaoAutomatica: "apto", motivo: "3º no Mundial" })).toBe(
      "3º no Mundial",
    );
  });
});

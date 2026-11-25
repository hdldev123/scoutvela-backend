import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface ItemEscala {
  indicadorId: string;
  evidencia: string;
  orientacao: string | null;
}
interface Escala {
  pilarId: string | null;
  notas: { nota: number; descricao: string }[];
}

describe("D9: a autoavaliação traz evidência, orientação e rubricas (o atleta não lê /parametros)", () => {
  let p: Piloto;
  let helena: string;
  let outra: string;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
    helena = await p.idDe("SP-T07");
    outra = await p.idDe("SC-T01");
    await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { indicadores: [{ id: "tec_largada", orientacao: "Olhe a linha de largada." }] },
    });
  });
  afterAll(() => p.encerrar());

  const ler = async (email: string | null, id: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${id}/autoavaliacao`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };

  it("o atleta lê evidência e orientação de cada indicador", async () => {
    const r = await ler(EMAILS_DEMO.atleta, helena);
    expect(r.status).toBe(200);
    const itens = r.corpo.indicadores as ItemEscala[];
    expect(itens.find((i) => i.indicadorId === "tec_largada")).toMatchObject({
      evidencia: "opcional",
      orientacao: "Olhe a linha de largada.",
    });
    expect(itens.find((i) => i.indicadorId === "tec_trim")).toMatchObject({
      evidencia: "opcional",
      orientacao: null,
    });
    expect(itens.find((i) => i.indicadorId === "men_disciplina")?.evidencia).toBe("obrigatoria");
  });

  it("traz a escala geral (pilarId nulo) e as rubricas próprias, com as notas de 0 a 5", async () => {
    const r = await ler(EMAILS_DEMO.atleta, helena);
    const rubricas = r.corpo.rubricas as Escala[];
    const geral = rubricas.find((e) => e.pilarId === null)!;
    expect(geral.notas.map((n) => n.nota)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(geral.notas.every((n) => n.descricao.length > 0)).toBe(true);
    const banco = await p.db.query<{ pilar_id: string }>(
      "select distinct pilar_id from rubricas where pilar_id is not null",
    );
    expect(rubricas.filter((e) => e.pilarId !== null).map((e) => e.pilarId)).toEqual(
      banco.rows.map((x) => x.pilar_id),
    );
    expect(rubricas.findIndex((e) => e.pilarId === null)).toBe(0);
  });

  it("gestor e treinador do atleta recebem o mesmo; mesma regra de acesso da rota", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora]) {
      const r = await ler(email, helena);
      expect(r.status).toBe(200);
      expect(r.corpo.rubricas.length).toBeGreaterThan(0);
      expect(r.corpo.indicadores[0]).toHaveProperty("evidencia");
    }
    expect((await ler(EMAILS_DEMO.atleta, outra)).status).toBe(404);
    expect((await ler(EMAILS_DEMO.ibvar, helena)).status).toBe(403);
    expect((await ler(null, helena)).status).toBe(401);
  });
});

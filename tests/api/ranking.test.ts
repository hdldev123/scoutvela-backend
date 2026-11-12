import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const DA_ANA = ["SC-T01", "RJ-T03", "RJ-T04", "SP-T07", "CE-T09", "DF-T11", "DF-T12"];

interface Item {
  posicao: number;
  atleta: { velaid: string; genero: string; classe: { evento: string } };
  score: number;
  faixa: { id: string };
  pontosCbvela: number;
}

describe("GET /ranking", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const buscar = async (email: string, query = "") => {
    const r = await p.app.inject({
      method: "GET",
      url: `/ranking${query}`,
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("sem token -> 401", async () => {
    const r = await p.app.inject({ method: "GET", url: "/ranking" });
    expect(r.statusCode).toBe(401);
  });

  it("atleta -> 403", async () => {
    expect((await buscar(EMAILS_DEMO.atleta)).status).toBe(403);
  });

  it("gestor vê os 14, com ciclo aberto e sem contagem de ocultos", async () => {
    const { status, corpo } = await buscar(EMAILS_DEMO.gestor);
    expect(status).toBe(200);
    expect(corpo.itens).toHaveLength(14);
    expect(corpo.ocultosSemConsentimento).toBeNull();
    expect(corpo.ciclo).toEqual({ nome: "Novembro de 2026", prazo: "2026-11-30" });
    expect(corpo.itens.map((i: Item) => i.posicao)).toEqual(
      Array.from({ length: 14 }, (_, i) => i + 1),
    );
    const scores = corpo.itens.map((i: Item) => i.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(corpo.itens[0].pilares).toHaveLength(9);
  });

  it("treinadora vê só os 7 dela", async () => {
    const { corpo } = await buscar(EMAILS_DEMO.treinadora);
    expect(corpo.itens.map((i: Item) => i.atleta.velaid).sort()).toEqual([...DA_ANA].sort());
    expect(corpo.ocultosSemConsentimento).toBeNull();
  });

  it("IBVAR vê 13, sem Helena, com a contagem de ocultos", async () => {
    const { corpo } = await buscar(EMAILS_DEMO.ibvar);
    expect(corpo.itens).toHaveLength(13);
    expect(corpo.itens.map((i: Item) => i.atleta.velaid)).not.toContain("SP-T07");
    expect(corpo.ocultosSemConsentimento).toBe(1);
    expect(JSON.stringify(corpo)).not.toContain("Helena");
  });

  it("filtros de classe, categoria e faixa", async () => {
    const todos = (await buscar(EMAILS_DEMO.gestor)).corpo.itens as Item[];

    const classe = (await buscar(EMAILS_DEMO.gestor, "?classe=ILCA%207")).corpo.itens as Item[];
    expect(classe.length).toBeGreaterThan(0);
    expect(classe.every((i) => i.atleta.classe.evento === "ILCA 7")).toBe(true);
    expect(classe).toHaveLength(todos.filter((i) => i.atleta.classe.evento === "ILCA 7").length);
    expect(classe.map((i) => i.posicao)).toEqual(classe.map((_, i) => i + 1));

    const fem = (await buscar(EMAILS_DEMO.gestor, "?categoria=F")).corpo.itens as Item[];
    expect(fem.length).toBeGreaterThan(0);
    expect(fem.every((i) => i.atleta.genero === "F")).toBe(true);

    const f1 = (await buscar(EMAILS_DEMO.gestor, "?faixa=f1")).corpo.itens as Item[];
    expect(f1.length).toBe(todos.filter((i) => i.faixa.id === "f1").length);
    expect(f1.every((i) => i.faixa.id === "f1")).toBe(true);

    expect((await buscar(EMAILS_DEMO.gestor, "?faixa=f9")).status).toBe(400);
    expect((await buscar(EMAILS_DEMO.gestor, "?ordem=xis")).status).toBe(400);
  });

  it("ordem por pontos CBVela", async () => {
    const itens = (await buscar(EMAILS_DEMO.gestor, "?ordem=pontos_cbvela")).corpo.itens as Item[];
    const pontos = itens.map((i) => i.pontosCbvela);
    expect(pontos).toEqual([...pontos].sort((a, b) => b - a));
    expect(pontos[0]).toBeGreaterThan(pontos[pontos.length - 1]!);
  });

  // Por último: mexe nos dados.
  it("atleta sem o termo do piloto aceito não entra no ranking, mas segue na ficha do gestor", async () => {
    const id = await p.idDe("RS-T02");
    await p.db.query(
      "insert into consentimentos (atleta_id, tipo, concedido) values ($1, 'termo_piloto', false)",
      [id],
    );
    const { corpo } = await buscar(EMAILS_DEMO.gestor);
    expect(corpo.itens).toHaveLength(13);
    expect(corpo.itens.map((i: Item) => i.atleta.velaid)).not.toContain("RS-T02");
    const ficha = await p.app.inject({
      method: "GET",
      url: `/atletas/${id}`,
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    expect(ficha.statusCode).toBe(200);
    expect(ficha.json().atleta.termoAceito).toBe(false);
  });
});

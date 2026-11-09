import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface ItemRanking {
  score: number;
  statusGates: string;
  faixa: { id: string };
  pilares: { id: string; nota: number | null }[];
}
interface Alvo {
  atleta: { id: string; nome: string };
  score: number;
  statusGates: string;
  perfilSuporte: string;
  mesesAssegurados: number | null;
}

describe("GET /investimento", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const buscar = async (email: string) => {
    const r = await p.app.inject({ method: "GET", url: "/investimento", headers: await p.como(email) });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };
  const ranking = async () => {
    const r = await p.app.inject({ method: "GET", url: "/ranking", headers: await p.como(EMAILS_DEMO.gestor) });
    return r.json().itens as ItemRanking[];
  };

  it("sem token -> 401; treinador e atleta -> 403", async () => {
    expect((await p.app.inject({ method: "GET", url: "/investimento" })).statusCode).toBe(401);
    expect((await buscar(EMAILS_DEMO.treinadora)).status).toBe(403);
    expect((await buscar(EMAILS_DEMO.atleta)).status).toBe(403);
  });

  it("gestor: agregados dos 14 batem com o ranking", async () => {
    const { status, corpo } = await buscar(EMAILS_DEMO.gestor);
    const itens = await ranking();
    expect(status).toBe(200);
    expect(corpo.ciclo).toEqual({ nome: "Novembro de 2026", prazo: "2026-11-30" });
    expect(corpo.kpis.atletas).toBe(14);
    const media = itens.reduce((t, i) => t + i.score, 0) / itens.length;
    expect(corpo.kpis.scoreMedio).toBeCloseTo(media, 9);
    expect(corpo.kpis.aptos).toBe(itens.filter((i) => i.statusGates === "apto").length);
    expect(corpo.ocultosSemConsentimento).toBeNull();

    expect(corpo.funil.map((f: { faixa: { id: string } }) => f.faixa.id)).toEqual(["f1", "f2", "f3", "f4"]);
    for (const f of corpo.funil) expect(f.n).toBe(itens.filter((i) => i.faixa.id === f.faixa.id).length);
    expect(corpo.funil.reduce((t: number, f: { n: number }) => t + f.n, 0)).toBe(14);

    expect(corpo.gates.map((g: { nome: string }) => g.nome)).toEqual([
      "Class Fit",
      "Evidência competitiva",
      "Alto rendimento",
      "Campanha",
    ]);
    for (const g of corpo.gates) expect(g.apto + g.condicional + g.alerta).toBe(14);

    expect(corpo.mediaPilares).toHaveLength(9);
    const perf = itens.map((i) => i.pilares.find((x) => x.id === "perf")?.nota).filter((v): v is number => v != null);
    const mediaPerf = corpo.mediaPilares.find((m: { pilarId: string }) => m.pilarId === "perf").media;
    expect(mediaPerf).toBeCloseTo(perf.reduce((t, v) => t + v, 0) / perf.length, 9);
  });

  it("onde investir: score >= faixa f2, não bloqueado, perfil C ou D, por score desc", async () => {
    const { corpo } = await buscar(EMAILS_DEMO.gestor);
    const alvo = corpo.ondeInvestir as Alvo[];
    expect(alvo.length).toBeGreaterThan(0);
    for (const x of alvo) {
      expect(x.score).toBeGreaterThanOrEqual(75);
      expect(x.statusGates).not.toBe("nao_prioritario");
      expect(["C", "D"]).toContain(x.perfilSuporte);
      expect(typeof x.mesesAssegurados).toBe("number");
    }
    const scores = alvo.map((x) => x.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("IBVAR: agregados completos, lista só de quem consentiu, sem meses assegurados", async () => {
    const g = (await buscar(EMAILS_DEMO.gestor)).corpo;
    const i = await buscar(EMAILS_DEMO.ibvar);
    expect(i.status).toBe(200);
    expect(i.corpo.kpis).toEqual(g.kpis);
    expect(i.corpo.funil).toEqual(g.funil);
    expect(i.corpo.gates).toEqual(g.gates);
    expect(i.corpo.mediaPilares).toEqual(g.mediaPilares);

    expect(i.texto).not.toContain("Helena");
    expect(i.texto).not.toContain("mesesAssegurados\":1");
    for (const x of i.corpo.ondeInvestir as Alvo[]) expect(x.mesesAssegurados).toBeNull();

    const idHelena = await p.idDe("SP-T07");
    const alvoGestor = (g.ondeInvestir as Alvo[]).map((x) => x.atleta.id);
    const alvoIbvar = (i.corpo.ondeInvestir as Alvo[]).map((x) => x.atleta.id);
    expect(alvoIbvar).not.toContain(idHelena);
    expect(i.corpo.ocultosSemConsentimento).toBe(alvoGestor.length - alvoIbvar.length);
    expect(alvoIbvar).toEqual(alvoGestor.filter((id) => id !== idHelena));
  });

  it("sem consentimento da Helena no recorte, o IBVAR vê a contagem, nunca o nome", async () => {
    const idHelena = await p.idDe("SP-T07");
    // Garante que ela entra em "Onde investir": notas altas, financeiro C e gates liberados.
    await p.db.query(
      `insert into financeiro_campanha (atleta_id, perfil_suporte, meses_assegurados, informado_por)
       select $1::uuid, 'C', 5, id from usuarios where email = $2`,
      [idHelena, EMAILS_DEMO.gestor],
    );
    await p.db.query(
      `insert into gates_decisoes (atleta_id, gate, status, decidido_por)
       select $1::uuid, g, 'apto', u.id from usuarios u, generate_series(1,4) g where u.email = $2`,
      [idHelena, EMAILS_DEMO.gestor],
    );
    const pilares = await p.db.query<{ id: string }>("select id from indicadores where tipo <> 'R' and not calculado");
    const gestor = await p.db.query<{ id: string }>("select id from usuarios where email = $1", [EMAILS_DEMO.gestor]);
    for (const ind of pilares.rows) {
      await p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id)
         values ($1, $2, 5, 'Teste de investimento', 'avaliacao', $3)`,
        [idHelena, ind.id, gestor.rows[0]!.id],
      );
    }
    const g = (await buscar(EMAILS_DEMO.gestor)).corpo;
    expect((g.ondeInvestir as Alvo[]).some((x) => x.atleta.id === idHelena)).toBe(true);
    const i = await buscar(EMAILS_DEMO.ibvar);
    expect((i.corpo.ondeInvestir as Alvo[]).some((x) => x.atleta.id === idHelena)).toBe(false);
    expect(i.corpo.ocultosSemConsentimento).toBeGreaterThanOrEqual(1);
    expect(i.texto).not.toContain("Helena");
    expect(i.texto).not.toContain(idHelena);
  });
});

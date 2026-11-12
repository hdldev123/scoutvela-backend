import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const T0 = new Date("2026-11-06T12:00:00-03:00");
const ANTES = "2026-11-01T12:00:00-03:00";
const DEPOIS_1 = "2026-11-07T12:00:00-03:00";
const DEPOIS_2 = "2026-11-08T12:00:00-03:00";
const DEPOIS_3 = "2026-11-09T12:00:00-03:00";

describe("GET /revisoes/:id/lancamentos", () => {
  let p: Piloto;
  let atletaId: string;
  let outroAtletaId: string;
  let gestorId: string;
  let indPerf: string[];
  let indTec: string;

  beforeAll(async () => {
    p = await criarPiloto(() => T0);
    atletaId = (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;
    outroAtletaId = await p.idDe("RJ-T03");
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    indPerf = (
      await p.db.query<{ id: string }>(
        "select id from indicadores where pilar_id = 'perf' and not calculado and tipo = 'T' order by ordem",
      )
    ).rows.map((l) => l.id);
    indTec = (
      await p.db.query<{ id: string }>(
        "select id from indicadores where pilar_id = 'tec' and not calculado and tipo = 'T' order by ordem limit 1",
      )
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      ...(email ? { headers: await p.como(email) } : {}),
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const lancar = async (atleta: string, indicador: string, valor: number, quando: string) =>
    (
      await p.db.query<{ id: string }>(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id, lancado_em)
         values ($1, $2, $3, 'Evidência sigilosa', 'avaliacao', $4, $5) returning id::text as id`,
        [atleta, indicador, valor, gestorId, quando],
      )
    ).rows[0]!.id;
  const pedir = async (corpo: Record<string, unknown>) =>
    (
      await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
        motivo: "Não concordo com esta nota, peço revisão.",
        ...corpo,
      })
    ).corpo.id as string;
  const ids = (corpo: { lancamentos: { id: string }[] }) => corpo.lancamentos.map((l) => l.id);

  it("só o gestor acessa; sem token 401; pedido inexistente 404", async () => {
    const id = await pedir({ indicadorId: indPerf[0]! });
    const url = `/revisoes/${id}/lancamentos`;
    expect((await chamar(null, "GET", url)).status).toBe(401);
    for (const email of [EMAILS_DEMO.atleta, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "GET", url)).status, email).toBe(403);
    }
    expect((await chamar(EMAILS_DEMO.gestor, "GET", url)).status).toBe(200);
    expect((await chamar(EMAILS_DEMO.gestor, "GET", "/revisoes/99999/lancamentos")).status).toBe(
      404,
    );
  });

  it("pedido por indicador: lista só os elegíveis, do mais novo ao mais antigo, sem evidência", async () => {
    const ind = indPerf[0]!;
    const id = await pedir({ indicadorId: ind });
    await lancar(atletaId, ind, 2, ANTES);
    await lancar(outroAtletaId, ind, 3, DEPOIS_1);
    await lancar(atletaId, indTec, 3, DEPOIS_1);
    if (indPerf[1]) await lancar(atletaId, indPerf[1], 3, DEPOIS_1);
    const a = await lancar(atletaId, ind, 4, DEPOIS_1);
    const c = await lancar(atletaId, ind, 5, DEPOIS_3);
    const b = await lancar(atletaId, ind, 1, DEPOIS_2);

    const r = await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${id}/lancamentos`);
    expect(r.status).toBe(200);
    expect(ids(r.corpo)).toEqual([c, b, a]);
    expect(r.corpo.lancamentos[0]).toEqual({
      id: c,
      indicadorId: ind,
      indicadorNome: expect.any(String),
      valor: 5,
      lancadoEm: new Date(DEPOIS_3).toISOString(),
      origem: "avaliacao",
      avaliador: { id: gestorId, nome: expect.any(String) },
    });
    expect(JSON.stringify(r.corpo)).not.toContain("sigilosa");
  });

  it("pedido por pilar: aceita indicadores do pilar e exclui os de fora", async () => {
    const id = await pedir({ pilarId: "perf" });
    const dentro = await lancar(atletaId, indPerf[0]!, 4, DEPOIS_1);
    await lancar(atletaId, indTec, 4, DEPOIS_2);
    const r = await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${id}/lancamentos`);
    expect(ids(r.corpo)).toContain(dentro);
    expect(
      r.corpo.lancamentos.every((l: { indicadorId: string }) => indPerf.includes(l.indicadorId)),
    ).toBe(true);
  });

  it("funciona com pedido respondido e o PUT aceita exatamente os ids da lista", async () => {
    const ind = indPerf[0]!;
    const id = await pedir({ indicadorId: ind });
    const bom = await lancar(atletaId, ind, 4, DEPOIS_1);
    const deOutro = await lancar(outroAtletaId, ind, 4, DEPOIS_1);
    const deOutroIndicador = await lancar(atletaId, indTec, 4, DEPOIS_1);
    const anterior = await lancar(atletaId, ind, 4, ANTES);
    const lista = ids(
      (await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${id}/lancamentos`)).corpo,
    );
    expect(lista).toContain(bom);

    const responder = (avaliacaoId: string) =>
      chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
        resposta: "Resposta de teste.",
        avaliacaoId,
      });
    for (const fora of [deOutro, deOutroIndicador, anterior]) {
      expect(lista).not.toContain(fora);
      expect((await responder(fora)).status, fora).toBe(400);
    }
    expect((await responder(lista[0]!)).status).toBe(200);

    const depois = await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${id}/lancamentos`);
    expect(depois.status).toBe(200);
    expect(ids(depois.corpo)).toEqual(lista);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-25T12:00:00-03:00");

const FONTE_WORD = {
  documento: "Word Sistema de Talent Identification & Scouting (CBVela)",
  versao: "29/09/2026",
  data: "2026-09-29",
};

interface ClasseParam {
  id: string;
  pesoMinKg: number;
  pesoMedioKg: number;
  pesoMaxKg: number;
  fonte: { documento: string | null; versao: string | null; data: string | null } | null;
}

describe("D18: fonte da faixa de peso da classe", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const ler = async (email: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: "/parametros",
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };
  const classe = async (id: string) =>
    ((await ler(EMAILS_DEMO.gestor)).corpo.classes as ClasseParam[]).find((c) => c.id === id)!;
  const gravar = async (classes: unknown[], email: string = EMAILS_DEMO.gestor) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: { classes },
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const ficha = async (email: string, velaid: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${await p.idDe(velaid)}`,
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };

  it("a migration preenche as 14 classes com a fonte do Word", async () => {
    const todas = (await ler(EMAILS_DEMO.gestor)).corpo.classes as ClasseParam[];
    expect(todas).toHaveLength(14);
    for (const c of todas) expect(c.fonte).toEqual(FONTE_WORD);
  });

  it("GET /parametros: gestor e treinador leem; atleta e IBVAR 403; sem token 401", async () => {
    expect((await ler(EMAILS_DEMO.treinadora)).corpo.classes[0].fonte).toEqual(FONTE_WORD);
    expect((await ler(EMAILS_DEMO.atleta)).status).toBe(403);
    expect((await ler(EMAILS_DEMO.ibvar)).status).toBe(403);
    expect((await p.app.inject({ method: "GET", url: "/parametros" })).statusCode).toBe(401);
  });

  it("PUT edita a fonte junto com a faixa e grava auditoria antes/depois", async () => {
    const r = await gravar([
      {
        id: "ilca7",
        pesoMinKg: 82.8,
        pesoMedioKg: 85,
        pesoMaxKg: 87.2,
        fonte: { documento: "  Regra de classe ILCA 7  ", versao: "2026", data: "2026-10-01" },
      },
    ]);
    expect(r.status).toBe(200);
    const depois = r.corpo.classes.find((c: ClasseParam) => c.id === "ilca7") as ClasseParam;
    expect(depois.fonte).toEqual({
      documento: "Regra de classe ILCA 7",
      versao: "2026",
      data: "2026-10-01",
    });
    expect(depois.pesoMinKg).toBe(82.8);
    // Outras classes seguem com a fonte do Word.
    expect((await classe("ilca6")).fonte).toEqual(FONTE_WORD);

    const aud = (
      await p.db.query<{ detalhes: { classes: { antes: unknown; depois: unknown } } }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      )
    ).rows[0]!.detalhes.classes;
    expect(aud.antes).toMatchObject({
      ilca7: { fonte: FONTE_WORD, pesoKg: expect.any(Array) },
    });
    expect(aud.depois).toMatchObject({
      ilca7: { fonte: { documento: "Regra de classe ILCA 7", versao: "2026", data: "2026-10-01" } },
    });
  });

  it("editar só a faixa não mexe na fonte nem a põe na auditoria; fonte null limpa", async () => {
    expect(
      (await gravar([{ id: "ilca6", pesoMinKg: 60, pesoMedioKg: 63, pesoMaxKg: 66 }])).status,
    ).toBe(200);
    expect((await classe("ilca6")).fonte).toEqual(FONTE_WORD);
    const aud = (
      await p.db.query<{ detalhes: { classes: { antes: Record<string, object> } } }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      )
    ).rows[0]!.detalhes.classes;
    expect(aud.antes.ilca6).not.toHaveProperty("fonte");

    expect((await gravar([{ id: "ilca6", fonte: null }])).status).toBe(200);
    expect((await classe("ilca6")).fonte).toBeNull();
  });

  it("documento sem versão e sem data vale; validações por campo", async () => {
    const ok = await gravar([{ id: "ilca6", fonte: { documento: "Regra ILCA 6" } }]);
    expect(ok.status).toBe(200);
    expect((await classe("ilca6")).fonte).toEqual({
      documento: "Regra ILCA 6",
      versao: null,
      data: null,
    });
    for (const fonte of [
      { documento: "" },
      { documento: "x".repeat(201) },
      { documento: "ok", versao: "v".repeat(41) },
      { documento: "ok", data: "29/09/2026" },
      { versao: "1" },
    ]) {
      const r = await gravar([{ id: "ilca6", fonte }]);
      expect(r.status).toBe(400);
    }
  });

  it("PUT: treinador, atleta e IBVAR 403; sem token 401", async () => {
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await gravar([{ id: "ilca7", fonte: null }], email)).status).toBe(403);
    }
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      payload: { classes: [{ id: "ilca7", fonte: null }] },
    });
    expect(r.statusCode).toBe(401);
  });

  it("a ficha traz a fonte da classe para gestor, treinador e o próprio atleta; o IBVAR não recebe", async () => {
    await gravar([{ id: "ilca7", fonte: FONTE_WORD }]);
    const classeDe = async (velaid: string) =>
      (
        await p.db.query<{ classe_id: string }>(
          "select classe_id from atletas where velaid_codigo = $1",
          [velaid],
        )
      ).rows[0]!.classe_id;
    expect(await classeDe("SC-T01")).toBeTruthy();
    const g = await ficha(EMAILS_DEMO.gestor, "SC-T01");
    const fonteEsperada = (await classe(await classeDe("SC-T01"))).fonte;
    expect(g.corpo.classFit.fonte).toEqual(fonteEsperada);
    expect(g.corpo.classFit.fonte).not.toBeNull();
    expect((await ficha(EMAILS_DEMO.treinadora, "SC-T01")).corpo.classFit.fonte).toEqual(
      fonteEsperada,
    );
    const dele = (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;
    const propria = await p.app.inject({
      method: "GET",
      url: `/atletas/${dele}`,
      headers: await p.como(EMAILS_DEMO.atleta),
    });
    expect(propria.statusCode).toBe(200);
    expect(propria.json().classFit?.fonte ?? FONTE_WORD).toBeTruthy();
    const ib = await ficha(EMAILS_DEMO.ibvar, "SC-T01");
    expect(ib.corpo.classFit).toBeNull();
    expect(ib.texto).not.toContain("Talent Identification");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const V1 = "Piloto 18+ · v1";
const V2 = "Piloto 18+ · v2";
const V3 = "Piloto 18+ · v3";
const TEXTO =
  "Texto da nova versão do termo do piloto, com mais de cinquenta caracteres para validar.";

describe("termo: aceite antecipado da próxima versão", () => {
  let agora = new Date("2026-11-06T12:00:00-03:00");
  let p: Piloto;
  let atletaId: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    atletaId = (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: await p.como(email),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const noRanking = async (email: string = EMAILS_DEMO.gestor) =>
    new Set(
      ((await chamar(email, "GET", "/ranking")).corpo.itens as { atleta: { id: string } }[]).map(
        (i) => i.atleta.id,
      ),
    );

  it("sem versão futura: /termo/proxima é 404 e o painel traz termoProxima nulo", async () => {
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/termo/proxima")).status).toBe(404);
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo.termoProxima).toBeNull();
  });

  it("publica a v2 com vigência futura e liga TERMO_EXIGE_REACEITE", async () => {
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
          regras: { TERMO_EXIGE_REACEITE: { ativa: true } },
        })
      ).status,
    ).toBe(200);
    const pub = await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
      versao: V2,
      titulo: "Termo v2",
      texto: TEXTO,
      vigenteDesde: "2026-11-10T00:00:00-03:00",
    });
    expect(pub.status).toBe(201);
  });

  it("GET /termo continua na vigente; /termo/proxima traz a v2 com texto, só para atleta e gestor", async () => {
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/termo")).corpo.versao).toBe(V1);
    for (const email of [EMAILS_DEMO.atleta, EMAILS_DEMO.gestor]) {
      const r = await chamar(email, "GET", "/termo/proxima");
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({
        versao: V2,
        titulo: "Termo v2",
        texto: TEXTO,
        vigenteDesde: new Date("2026-11-10T00:00:00-03:00").toISOString(),
        incluiFotoBio: false,
      });
    }
    expect((await chamar(EMAILS_DEMO.treinadora, "GET", "/termo/proxima")).status).toBe(403);
    expect((await chamar(EMAILS_DEMO.ibvar, "GET", "/termo/proxima")).status).toBe(403);
    expect((await p.app.inject({ method: "GET", url: "/termo/proxima" })).statusCode).toBe(401);
  });

  it("o painel do atleta mostra termoProxima enquanto ele não aceitou", async () => {
    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo;
    expect(painel.termoProxima).toEqual({
      versao: V2,
      titulo: "Termo v2",
      vigenteDesde: new Date("2026-11-10T00:00:00-03:00").toISOString(),
    });
    expect(painel.consentimento.termoPendente).toBe(false); // a v1 vigente segue aceita
  });

  it("aceita só a vigente ou a próxima: outra versão é 400", async () => {
    await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
      versao: V3,
      titulo: "Termo v3",
      texto: TEXTO,
      vigenteDesde: "2026-12-10T00:00:00-03:00",
    });
    expect((await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V3 })).status).toBe(
      400,
    );
    expect(
      (await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: "Inexistente" })).status,
    ).toBe(400);
  });

  it("aceite antecipado da v2: o painel zera termoProxima; repetir é 409", async () => {
    const r = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 });
    expect(r.status).toBe(200);
    expect((await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 })).status).toBe(
      409,
    );
    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo;
    expect(painel.termoProxima).toBeNull();
    expect(painel.consentimento.termoPendente).toBe(false);
    expect(painel.consentimento.termoVersao).toBe(V2);
  });

  it("com a v2 em vigor e a regra ligada: quem aceitou antes fica no ranking e quem não aceitou sai", async () => {
    agora = new Date("2026-11-10T09:00:00-03:00");
    const ranking = await noRanking();
    expect(ranking.has(atletaId)).toBe(true);
    // O resto do piloto aceitou só a v1: sai.
    const outro = await p.idDe("SC-T01");
    expect(ranking.has(outro)).toBe(false);
    // O próprio atleta não aparece como pendente da v1 nem da v2.
    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo;
    expect(painel.consentimento.termoVigenteVersao).toBe(V2);
    expect(painel.consentimento.termoPendente).toBe(false);
    // O gestor vê quem está com o termo pendente.
    const pendentes = (await chamar(EMAILS_DEMO.gestor, "GET", "/atletas/pendentes")).corpo as {
      id: string;
    }[];
    expect(pendentes.some((a) => a.id === atletaId)).toBe(false);
    expect(pendentes.some((a) => a.id === outro)).toBe(true);
  });

  it("o gestor também registra o aceite da vigente e da próxima publicada em nome do atleta", async () => {
    const outro = await p.idDe("SC-T01");
    const v2 = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${outro}/termo`, {
      versao: V2,
    });
    expect(v2.status).toBe(200);
    expect((await noRanking()).has(outro)).toBe(true);
    const v3 = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${outro}/termo`, {
      versao: V3,
    });
    expect(v3.status).toBe(200); // a v3 é a próxima publicada agora
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${outro}/termo`, { versao: V3 })).status,
    ).toBe(409);
    expect((await noRanking()).has(outro)).toBe(true);
  });

  it("revogação depois do aceite antecipado tira o atleta; aceitar de novo traz de volta", async () => {
    await p.db.query(
      `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em)
       values ($1, 'termo_piloto', false, $2, $3)`,
      [atletaId, V2, new Date("2026-11-10T10:00:00-03:00")],
    );
    agora = new Date("2026-11-10T11:00:00-03:00");
    expect((await noRanking()).has(atletaId)).toBe(false);
    expect((await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 })).status).toBe(
      200,
    );
    expect((await noRanking()).has(atletaId)).toBe(true);
  });
});

describe("POST /ciclos/:id/fechar sem atleta para congelar", () => {
  const abrir = async (p: Piloto) => {
    const r = await p.app.inject({
      method: "GET",
      url: "/ciclos",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    return (r.json().itens as { id: string; status: string }[]).find((c) => c.status === "aberto")!;
  };

  it("recusa com 409 quando há atletas ativos sem o termo vigente aceito", async () => {
    let agora = new Date("2026-11-06T12:00:00-03:00");
    const p = await criarPiloto(() => agora);
    try {
      await p.app.inject({
        method: "PUT",
        url: "/parametros",
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: { regras: { TERMO_EXIGE_REACEITE: { ativa: true } } },
      });
      await p.app.inject({
        method: "POST",
        url: "/termos",
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: {
          versao: V2,
          titulo: "Termo v2",
          texto: TEXTO,
          vigenteDesde: "2026-11-10T00:00:00-03:00",
        },
      });
      agora = new Date("2026-11-10T09:00:00-03:00");
      const aberto = await abrir(p);
      const fechar = await p.app.inject({
        method: "POST",
        url: `/ciclos/${aberto.id}/fechar`,
        headers: await p.como(EMAILS_DEMO.gestor),
      });
      expect(fechar.statusCode).toBe(409);
      expect(fechar.json().mensagem).toMatch(/termo/i);
      // O ciclo continua aberto e nada foi congelado.
      expect(
        (await p.db.query("select 1 from scores_ciclo where ciclo_id = $1", [aberto.id])).rows,
      ).toHaveLength(0);
      const depois = await p.db.query<{ status: string }>(
        "select status from ciclos_avaliacao where id = $1",
        [aberto.id],
      );
      expect(depois.rows[0]!.status).toBe("aberto");
    } finally {
      await p.encerrar();
    }
  });

  it("sem atletas ativos, fechar vazio continua permitido", async () => {
    const p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
    try {
      await p.db.query("update atletas set ativo = false");
      const aberto = await abrir(p);
      const fechar = await p.app.inject({
        method: "POST",
        url: `/ciclos/${aberto.id}/fechar`,
        headers: await p.como(EMAILS_DEMO.gestor),
      });
      expect(fechar.statusCode).toBe(200);
      expect(fechar.json().atletas).toBe(0);
    } finally {
      await p.encerrar();
    }
  });
});

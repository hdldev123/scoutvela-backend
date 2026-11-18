import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const V1 = "Piloto 18+ · v1";
const V2 = "Piloto 18+ · v2";
const TEXTO_V2 =
  "Segunda versão do termo do piloto, com o texto revisado pela CBVela para o ciclo seguinte.";
const INICIO = new Date("2026-11-06T12:00:00-03:00");

describe("termos versionados (GET/POST /termos, aceite pendente, TERMO_EXIGE_REACEITE)", () => {
  let p: Piloto;
  let agora = INICIO;
  beforeAll(async () => {
    p = await criarPiloto(() => agora);
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      ...(email ? { headers: await p.como(email) } : {}),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const novo = (extra: Record<string, unknown> = {}) => ({
    versao: V2,
    titulo: "Termo do piloto, segunda versão",
    texto: TEXTO_V2,
    vigenteDesde: "2026-11-20T00:00:00-03:00",
    ...extra,
  });
  const posicoesNoRanking = async () =>
    (await chamar(EMAILS_DEMO.gestor, "GET", "/ranking")).corpo.itens.length as number;

  it("acesso: só o gestor lê e publica", async () => {
    for (const [metodo, corpo] of [
      ["GET", undefined],
      ["POST", novo()],
    ] as const) {
      expect((await chamar(null, metodo, "/termos", corpo)).status).toBe(401);
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        expect((await chamar(email, metodo, "/termos", corpo)).status, email).toBe(403);
      }
    }
  });

  it("GET /termos: versão vigente, sem texto, com a contagem de aceites", async () => {
    const { status, corpo } = await chamar(EMAILS_DEMO.gestor, "GET", "/termos");
    expect(status).toBe(200);
    expect(corpo).toEqual([
      {
        versao: V1,
        titulo: expect.any(String),
        vigenteDesde: "2026-10-01T03:00:00.000Z",
        criadoEm: expect.any(String),
        vigente: true,
        futura: false,
        aceites: 14,
      },
    ]);
    expect(JSON.stringify(corpo)).not.toContain("Minuta");
  });

  it("POST /termos: validações", async () => {
    const g = EMAILS_DEMO.gestor;
    expect((await chamar(g, "POST", "/termos", novo({ versao: V1 }))).status).toBe(400);
    expect(
      (await chamar(g, "POST", "/termos", novo({ vigenteDesde: "2026-11-01T00:00:00-03:00" })))
        .status,
    ).toBe(400);
    expect((await chamar(g, "POST", "/termos", novo({ texto: "curto" }))).status).toBe(400);
    expect((await chamar(g, "POST", "/termos", { ...novo(), extra: 1 })).status).toBe(400);
    expect((await chamar(g, "POST", "/termos", novo({ vigenteDesde: "amanhã" }))).status).toBe(400);
    const r = await chamar(g, "GET", "/termos");
    expect(r.corpo).toHaveLength(1);
  });

  it("publica a v2 futura: auditoria sem texto e ordem estável", async () => {
    const g = EMAILS_DEMO.gestor;
    const { status, corpo } = await chamar(g, "POST", "/termos", novo());
    expect(status).toBe(201);
    expect(corpo).toMatchObject({ versao: V2, vigente: false, futura: true, aceites: 0 });

    const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
      "select detalhes from auditoria where acao = 'publicar_termo'",
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]!.detalhes).toEqual({
      versao: V2,
      vigenteDesde: "2026-11-20T03:00:00.000Z",
    });
    expect(JSON.stringify(aud.rows[0])).not.toContain("Segunda versão");

    // Vigência igual ou anterior à da mais recente (a futura) é recusada.
    const igual = await chamar(
      g,
      "POST",
      "/termos",
      novo({ versao: "v3", vigenteDesde: "2026-11-20T00:00:00-03:00" }),
    );
    expect(igual.status).toBe(400);
    const antes = await chamar(
      g,
      "POST",
      "/termos",
      novo({ versao: "v3", vigenteDesde: "2026-11-10T00:00:00-03:00" }),
    );
    expect(antes.status).toBe(400);

    const lista = (await chamar(g, "GET", "/termos")).corpo;
    expect(lista.map((t: { versao: string }) => t.versao)).toEqual([V2, V1]);
  });

  it("a versão futura não vale antes da data", async () => {
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/termo")).corpo.versao).toBe(V1);
    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo.consentimento;
    expect(painel).toMatchObject({
      termoVersao: V1,
      termoVigenteVersao: V1,
      termoPendente: false,
    });
    expect((await chamar(EMAILS_DEMO.gestor, "GET", "/atletas/pendentes")).corpo).toEqual([]);
    expect(await posicoesNoRanking()).toBe(14);
  });

  it("v2 vigente: aceite pendente no painel e em /atletas/pendentes; ranking segue a regra", async () => {
    agora = new Date("2026-11-21T12:00:00-03:00");

    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/termo")).corpo.versao).toBe(V2);
    const lista = (await chamar(EMAILS_DEMO.gestor, "GET", "/termos")).corpo;
    expect(lista[0]).toMatchObject({ versao: V2, vigente: true, futura: false });
    expect(lista[1]).toMatchObject({ versao: V1, vigente: false });

    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo.consentimento;
    expect(painel).toMatchObject({
      termoVersao: V1,
      termoVigenteVersao: V2,
      termoPendente: true,
    });
    expect(painel.termoAceitoEm).toEqual(expect.any(String));

    const pend = (await chamar(EMAILS_DEMO.gestor, "GET", "/atletas/pendentes")).corpo;
    expect(pend).toHaveLength(14);
    expect(pend[0].termoAceitoVersao).toBe(V1);

    // Regra inativa (padrão): continua no ranking.
    expect(await posicoesNoRanking()).toBe(14);

    // Regra ativa: sai do ranking.
    const ativar = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      regras: { TERMO_EXIGE_REACEITE: { ativa: true } },
    });
    expect(ativar.status).toBe(200);
    expect(await posicoesNoRanking()).toBe(0);
  });

  it("o aceite da v2 resolve; contagem de aceites por versão", async () => {
    const aceite = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 });
    expect(aceite.status).toBe(200);

    const painel = (await chamar(EMAILS_DEMO.atleta, "GET", "/painel")).corpo.consentimento;
    expect(painel).toMatchObject({ termoVersao: V2, termoPendente: false });

    expect(await posicoesNoRanking()).toBe(1);
    const pend = (await chamar(EMAILS_DEMO.gestor, "GET", "/atletas/pendentes")).corpo;
    expect(pend).toHaveLength(13);

    const lista = (await chamar(EMAILS_DEMO.gestor, "GET", "/termos")).corpo;
    expect(lista[0].aceites).toBe(1);
    expect(lista[1].aceites).toBe(14);
  });

  it("gestor registra o aceite da v2 de outro atleta; repetir é 409", async () => {
    const id = await p.idDe("RJ-T03");
    const r = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/termo`, { versao: V2 });
    expect(r.status).toBe(200);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/termo`, { versao: V2 })).status,
    ).toBe(409);
    expect(await posicoesNoRanking()).toBe(2);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/termo`, { versao: V1 })).status,
    ).toBe(400);
  });

  it("com a regra desativada de novo, quem aceitou alguma versão volta ao ranking", async () => {
    await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      regras: { TERMO_EXIGE_REACEITE: { ativa: false } },
    });
    expect(await posicoesNoRanking()).toBe(14);
    const invalida = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      regras: { TERMO_EXIGE_REACEITE: { ativa: "sim" } },
    });
    expect(invalida.status).toBe(400);
  });
});

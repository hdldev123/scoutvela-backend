import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, tokenPara } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

// Ciclo aberto do seed: Novembro de 2026.
const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const TERMO = "Piloto 18+ · v1";

/**
 * Atleta com cadastro incompleto (D1): sem nome, gênero e nascimento. Fica fora do ranking, do score,
 * das pendências, do fechamento de ciclo, dos lembretes e do investimento, mesmo com o termo aceito
 * e o compartilhamento com o IBVAR concedido.
 */
describe("atleta com cadastro incompleto", () => {
  let p: Piloto;
  let incompletoId: string;
  let ana: string;

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    ana = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
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
      headers: email ? await p.como(email) : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };
  const gestor = (m: "GET" | "POST" | "PUT", url: string, body?: unknown) =>
    chamar(EMAILS_DEMO.gestor, m, url, body);

  const kpis = async () => (await gestor("GET", "/investimento")).corpo.kpis.atletas as number;

  it("cadastrado com termo aceito e IBVAR autorizado, segue fora de tudo", async () => {
    const antes = {
      ranking: (await gestor("GET", "/ranking")).corpo.itens.length as number,
      investimento: await kpis(),
      ibvar: (await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking")).corpo.itens.length as number,
    };

    const novo = await gestor("POST", "/atletas", {
      wsId: "BRAZZ99",
      email: "incompleto@exemplo.com",
      classeId: "ilca7",
      treinadorId: ana,
      confirmaMaioridade: true,
    });
    expect(novo.status).toBe(201);
    incompletoId = novo.corpo.id;
    expect((await gestor("POST", `/atletas/${incompletoId}/termo`, { versao: TERMO })).status).toBe(
      200,
    );
    await p.db.query(
      `insert into consentimentos (atleta_id, tipo, concedido, registrado_em, registrado_por)
       select $1, 'compartilhar_ibvar', true, now(), id from usuarios where email = $2`,
      [incompletoId, EMAILS_DEMO.gestor],
    );

    // Ranking (gestor, treinador, IBVAR) e investimento (gestor e IBVAR).
    expect((await gestor("GET", "/ranking")).corpo.itens).toHaveLength(antes.ranking);
    const rankTreinador = await chamar(EMAILS_DEMO.treinadora, "GET", "/ranking");
    expect(JSON.stringify(rankTreinador.corpo)).not.toContain("BRAZZ99");
    const rankIbvar = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
    expect(rankIbvar.corpo.itens).toHaveLength(antes.ibvar);
    expect(rankIbvar.corpo.ocultosSemConsentimento).toBeTypeOf("number");
    expect(await kpis()).toBe(antes.investimento);
    expect(
      JSON.stringify((await chamar(EMAILS_DEMO.ibvar, "GET", "/investimento")).corpo),
    ).not.toContain(incompletoId);

    // Ficha: 404 para todos (não há score a mostrar).
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "GET", `/atletas/${incompletoId}`)).status, email).toBe(404);
    }
  });

  it("fica fora das pendências do ciclo e dos lembretes", async () => {
    const aberto = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
    const { corpo } = await gestor("GET", `/ciclos/${aberto}/pendencias`);
    expect(JSON.stringify(corpo)).not.toContain(incompletoId);
    const treino = await chamar(EMAILS_DEMO.treinadora, "GET", "/me/notificacoes");
    // O treinador não recebe pendência de avaliar por atleta incompleto: o total bate com a regra única.
    expect(treino.status).toBe(200);
    const { pendenciasDoCiclo } = await import("../../src/repositories/pendencias.js");
    const regra = await pendenciasDoCiclo(p.db, aberto, AGORA());
    const ids = [
      ...regra.treinadores.flatMap((t) => t.atletasPendentes.map((a) => a.id)),
      ...regra.atletas.map((a) => a.id),
    ];
    expect(ids).not.toContain(incompletoId);
  });

  it("fica fora do fechamento do ciclo (não entra em scores_ciclo)", async () => {
    const aberto = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
    const r = await gestor("POST", `/ciclos/${aberto}/fechar`);
    expect(r.status).toBe(200);
    expect(r.corpo.atletas).toBe(14);
    expect(
      (await p.db.query("select 1 from scores_ciclo where atleta_id = $1", [incompletoId])).rows,
    ).toHaveLength(0);
  });

  it("aparece na lista de gestão, com WS ID, sem nome, e entra nos filtros e na busca por WS ID", async () => {
    const lista = await gestor("GET", "/atletas?cadastroCompleto=false");
    expect(lista.status).toBe(200);
    expect(lista.corpo).toEqual([
      expect.objectContaining({
        id: incompletoId,
        nome: null,
        wsId: "BRAZZ99",
        velaid: null,
        idade: null,
        cadastroCompleto: false,
        cadastroRecusado: false,
        termoAceito: true,
      }),
    ]);
    expect((await gestor("GET", "/atletas?cadastroCompleto=true")).corpo).toHaveLength(14);
    expect((await gestor("GET", "/atletas")).corpo).toHaveLength(15);

    const porWs = await gestor("GET", "/atletas?busca=brazz");
    expect(porWs.corpo.map((a: { id: string }) => a.id)).toEqual([incompletoId]);
    const porWsSeed = await gestor("GET", "/atletas?busca=BRASPT07");
    expect(porWsSeed.corpo).toHaveLength(1);
    expect(porWsSeed.corpo[0].velaid).toBe("SP-T07");
    // Só o gestor.
    expect(
      (await chamar(EMAILS_DEMO.treinadora, "GET", "/atletas?cadastroCompleto=false")).status,
    ).toBe(403);
  });

  it("o atleta incompleto não tem painel nem ficha, e o balão de aviso conta o cadastro pendente", async () => {
    const authId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where atleta_id = $2", [
      authId,
      incompletoId,
    ]);
    const cab = cabecalhoAuth(await tokenPara(authId));
    const ficha = await p.app.inject({
      method: "GET",
      url: `/atletas/${incompletoId}`,
      headers: cab,
    });
    expect(ficha.statusCode).toBe(404);
    const notif = await p.app.inject({ method: "GET", url: "/me/notificacoes", headers: cab });
    expect(notif.json().contagens.painel).toBeGreaterThanOrEqual(1);
    // Atleta não troca nome, gênero nem nascimento pelo perfil: só PUT /me/cadastro (uma vez).
    const perfil = await p.app.inject({
      method: "PUT",
      url: "/me/perfil",
      headers: cab,
      payload: { nome: "Outro Nome" },
    });
    expect(perfil.statusCode).toBe(400);
    const g = await p.app.inject({ method: "GET", url: "/me/perfil", headers: cab });
    expect(g.json().atleta).toMatchObject({
      wsId: "BRAZZ99",
      velaid: null,
      cadastroCompleto: false,
      dataNascimento: null,
    });
  });

  it("completo o cadastro, passa a entrar no ranking e no investimento", async () => {
    const antes = (await gestor("GET", "/ranking")).corpo.itens.length as number;
    const authId = (
      await p.db.query<{ auth_user_id: string }>(
        "select auth_user_id from usuarios where atleta_id = $1",
        [incompletoId],
      )
    ).rows[0]!.auth_user_id;
    const cab = cabecalhoAuth(await tokenPara(authId));
    const r = await p.app.inject({
      method: "PUT",
      url: "/me/cadastro",
      headers: cab,
      payload: { nome: "Zélia Zanetti", genero: "F", dataNascimento: "1999-12-31" },
    });
    expect(r.statusCode).toBe(200);
    expect((await gestor("GET", "/ranking")).corpo.itens).toHaveLength(antes + 1);
    const ibvar = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
    expect(
      ibvar.corpo.itens.find((i: { atleta: { wsId: string } }) => i.atleta.wsId === "BRAZZ99"),
    ).toMatchObject({ atleta: { nome: "Zélia Zanetti", velaid: null } });
    expect((await gestor("GET", `/atletas/${incompletoId}`)).corpo.atleta.wsId).toBe("BRAZZ99");
  });
});

describe("WS ID: leitura por papel e troca pelo gestor (PUT /atletas/:id)", () => {
  let p: Piloto;
  let id: string;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    id = await p.idDe("SC-T01");
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    method: "GET" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: email ? await p.como(email) : {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("só o gestor troca o WS ID: normaliza, valida, recusa duplicado e audita só o nome do campo", async () => {
    const ok = await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${id}`, { wsId: " bra sc 01x " });
    expect(ok.status).toBe(200);
    expect(ok.corpo.wsId).toBe("BRASC01X");
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'editar_atleta' and entidade_id = $1",
      [id],
    );
    expect(aud.rows.at(-1)!.detalhes).toEqual({ campos: ["wsId"] });
    expect(JSON.stringify(aud.rows)).not.toContain("BRASC01X");

    // O mesmo valor no próprio atleta não é duplicado; no de outro é.
    expect(
      (await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${id}`, { wsId: "BRASC01X" })).status,
    ).toBe(200);
    const outro = await p.idDe("SP-T07");
    const dup = await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${outro}`, { wsId: "brasc01x" });
    expect(dup.status).toBe(409);
    expect(dup.corpo.mensagem).toBe("Já existe um atleta com este ID World Sailing.");
    for (const wsId of ["", "XX", "BRA-1", "1BRAAB", "BRAABCDEFGHIJKLM"]) {
      expect(
        (await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${id}`, { wsId })).status,
        wsId,
      ).toBe(400);
    }
  });

  it("treinador, atleta e IBVAR recebem 403; sem token, 401", async () => {
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect(
        (await chamar(email, "PUT", `/atletas/${id}`, { wsId: "BRAOUT1" })).status,
        email,
      ).toBe(403);
    }
    expect((await chamar(null, "PUT", `/atletas/${id}`, { wsId: "BRAOUT1" })).status).toBe(401);
    expect(
      (await p.db.query<{ ws_id: string }>("select ws_id from atletas where id = $1", [id]))
        .rows[0]!.ws_id,
    ).toBe("BRASC01X");
  });

  it("ficha, perfil e ranking devolvem wsId; o IBVAR só vê o de quem consentiu", async () => {
    const gestorFicha = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}`);
    expect(gestorFicha.corpo.atleta).toMatchObject({ wsId: "BRASC01X", velaid: "SC-T01" });
    const perfil = await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil");
    expect(perfil.corpo.atleta.wsId).toBe("BRASPT07");

    const ranking = await chamar(EMAILS_DEMO.gestor, "GET", "/ranking");
    for (const i of ranking.corpo.itens) expect(i.atleta.wsId).toMatch(/^[A-Z]{3}[A-Z0-9]{2,12}$/);

    const consentiu = (
      await p.db.query<{ ws_id: string }>(
        `select a.ws_id from atletas a
          where exists (select 1 from consentimento_atual c
                         where c.atleta_id = a.id and c.tipo = 'compartilhar_ibvar' and c.concedido)`,
      )
    ).rows.map((l) => l.ws_id);
    const naoConsentiu = (
      await p.db.query<{ ws_id: string }>(
        `select a.ws_id from atletas a
          where not exists (select 1 from consentimento_atual c
                             where c.atleta_id = a.id and c.tipo = 'compartilhar_ibvar' and c.concedido)`,
      )
    ).rows.map((l) => l.ws_id);
    expect(naoConsentiu.length).toBeGreaterThan(0);
    const ibvar = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
    const vistos = ibvar.corpo.itens.map((i: { atleta: { wsId: string } }) => i.atleta.wsId);
    expect(vistos.every((w: string) => consentiu.includes(w))).toBe(true);
    const texto = JSON.stringify(ibvar.corpo);
    for (const w of naoConsentiu) expect(texto).not.toContain(w);
  });
});

describe("anonimização de atletas sem VelaID e com cadastro incompleto", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  it("grava WS ID e VelaID neutros e únicos (dois atletas sem VelaID não colidem)", async () => {
    const ana = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
    const gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    const ids: string[] = [];
    for (const [wsId, email] of [
      ["BRAANO01", "anon1@exemplo.com"],
      ["BRAANO02", "anon2@exemplo.com"],
    ] as const) {
      const r = await p.app.inject({
        method: "POST",
        url: "/atletas",
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: {
          wsId,
          email,
          classeId: "ilca7",
          treinadorId: ana,
          confirmaMaioridade: true,
          criarConta: false,
        },
      });
      expect(r.statusCode).toBe(201);
      ids.push(r.json().id);
    }
    for (const id of ids) {
      const pedido = await p.db.query<{ id: string }>(
        `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
         values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
        [id, gestorId],
      );
      const r = await p.app.inject({
        method: "POST",
        url: `/atletas/${id}/anonimizar`,
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: { pedidoTitularId: pedido.rows[0]!.id, confirmacao: "ANONIMIZAR" },
      });
      expect(r.statusCode).toBe(200);
    }
    const linhas = (
      await p.db.query<{ ws_id: string; velaid_codigo: string; nome: string | null }>(
        "select ws_id, velaid_codigo, nome from atletas where id = any($1::uuid[]) order by ws_id",
        [ids],
      )
    ).rows;
    expect(linhas).toHaveLength(2);
    expect(linhas[0]!.ws_id).not.toBe(linhas[1]!.ws_id);
    for (const l of linhas) {
      expect(l.ws_id).toMatch(/^ANON[0-9A-F]{8}$/);
      expect(l.velaid_codigo).toMatch(/^ANON-[0-9A-F]{8}$/);
      expect(l.nome).toBe("Atleta anonimizado");
    }
    expect(
      (await p.db.query("select 1 from atletas where ws_id in ('BRAANO01', 'BRAANO02')")).rows,
    ).toHaveLength(0);
  });
});

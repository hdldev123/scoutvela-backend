import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};

describe("revisão: treinador na 1ª instância, gestor na 2ª (recurso)", () => {
  let p: Piloto;
  let gestorId: string;
  let outroAtletaId: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    outroAtletaId = await p.idDe("RS-T02"); // atleta de outro treinador
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
  const pedir = async () =>
    (
      await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
        pilarId: "amb",
        motivo: "Não concordo com esta nota, peço revisão.",
      })
    ).corpo.id as string;
  const responder = (email: string, id: string, resposta = "Nota mantida, conforme a evidência.") =>
    chamar(email, "PUT", `/revisoes/${id}`, { resposta });
  const recorrer = (id: string, texto = "Discordo: a evidência não foi considerada.") =>
    chamar(EMAILS_DEMO.atleta, "POST", `/revisoes/${id}/recurso`, { texto });
  const contagem = async (email: string) =>
    (await chamar(email, "GET", "/me/notificacoes")).corpo.contagens.revisoes as number;
  const obter = async (email: string, id: string) =>
    (await chamar(email, "GET", "/revisoes")).corpo.find((r: { id: string }) => r.id === id);

  it("treinador responde só os próprios atletas (outro: 404); gestor responde qualquer", async () => {
    const meu = await pedir();
    const alheio = (
      await p.db.query<{ id: string }>(
        `insert into pedidos_revisao (atleta_id, pilar_id, motivo, criado_por)
         values ($1, 'amb', 'Pedido de atleta de outro treinador.', $2) returning id::text as id`,
        [outroAtletaId, gestorId],
      )
    ).rows[0]!.id;

    expect((await responder(EMAILS_DEMO.treinadora, alheio)).status).toBe(404);
    expect((await responder(EMAILS_DEMO.treinadora, "99999")).status).toBe(404);
    expect((await responder(EMAILS_DEMO.atleta, meu)).status).toBe(403);
    expect((await responder(EMAILS_DEMO.ibvar, meu)).status).toBe(403);
    expect(
      (await chamar(null, "PUT", `/revisoes/${meu}`, { resposta: "Resposta sem login." })).status,
    ).toBe(401);

    const ok = await responder(EMAILS_DEMO.treinadora, meu);
    expect(ok.status).toBe(200);
    expect(ok.corpo).toMatchObject({
      status: "respondido",
      instancia: 1,
      recurso: null,
      respostaFinal: null,
      podeRecurso: true,
      primeiraResposta: { papel: "treinador", texto: "Nota mantida, conforme a evidência." },
    });
    expect((await responder(EMAILS_DEMO.gestor, alheio)).status).toBe(200);

    const aud = await p.db.query<{ detalhes: unknown }>(
      `select detalhes from auditoria where acao = 'responder_revisao' and entidade_id = $1 order by id`,
      [meu],
    );
    expect(aud.rows[0]!.detalhes).toEqual({ avaliacaoId: null, papel: "treinador", instancia: 1 });
  });

  it("recurso: antes da resposta 409; depois da resposta do treinador volta a aberto na 2ª instância", async () => {
    const id = await pedir();
    expect((await recorrer(id)).status).toBe(409);

    avancar(10);
    await responder(EMAILS_DEMO.treinadora, id, "Primeira resposta do treinador.");
    avancar(10);
    const r = await recorrer(id, "Discordo da resposta do treinador.");
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({
      status: "aberto",
      instancia: 2,
      resposta: null,
      respondidoEm: null,
      podeRecurso: false,
      respostaFinal: null,
      primeiraResposta: { papel: "treinador", texto: "Primeira resposta do treinador." },
      recurso: { texto: "Discordo da resposta do treinador.", em: agora.toISOString() },
    });

    // Só uma vez por pedido.
    expect((await recorrer(id)).status).toBe(409);

    // Na 2ª instância o treinador não responde (403); o gestor responde e encerra.
    expect((await responder(EMAILS_DEMO.treinadora, id)).status).toBe(403);
    avancar(10);
    const final = await responder(EMAILS_DEMO.gestor, id, "Decisão final do gestor.");
    expect(final.status).toBe(200);
    expect(final.corpo).toMatchObject({
      status: "respondido",
      instancia: 2,
      resposta: "Decisão final do gestor.",
      podeRecurso: false,
      primeiraResposta: { papel: "treinador", texto: "Primeira resposta do treinador." },
      respostaFinal: { papel: "gestor", texto: "Decisão final do gestor." },
    });
    expect((await recorrer(id)).status).toBe(409);
    expect((await responder(EMAILS_DEMO.gestor, id)).status).toBe(409);

    const aud = await p.db.query<{ acao: string; detalhes: Record<string, unknown> }>(
      `select acao, detalhes from auditoria where entidade = 'pedidos_revisao' and entidade_id = $1 order by id`,
      [id],
    );
    expect(aud.rows.map((a) => a.acao)).toEqual([
      "pedir_revisao",
      "responder_revisao",
      "recurso_revisao",
      "responder_revisao",
    ]);
    expect(aud.rows[2]!.detalhes).toEqual({ instancia: 2 });
    expect(aud.rows[3]!.detalhes).toMatchObject({ papel: "gestor", instancia: 2 });
    expect(JSON.stringify(aud.rows)).not.toContain("Discordo");
    expect(JSON.stringify(aud.rows)).not.toContain("Decisão final");
  });

  it("pedido respondido pelo gestor na 1ª instância não tem recurso (409)", async () => {
    const id = await pedir();
    await responder(EMAILS_DEMO.gestor, id);
    const r = await recorrer(id);
    expect(r.status).toBe(409);
    expect(r.corpo.mensagem ?? r.corpo.message ?? JSON.stringify(r.corpo)).toContain("gestor");
    expect((await obter(EMAILS_DEMO.atleta, id)).podeRecurso).toBe(false);
  });

  it("validações e acesso do recurso", async () => {
    const id = await pedir();
    await responder(EMAILS_DEMO.treinadora, id);
    const url = `/revisoes/${id}/recurso`;
    expect((await chamar(EMAILS_DEMO.atleta, "POST", url, { texto: "   " })).status).toBe(400);
    expect((await chamar(EMAILS_DEMO.atleta, "POST", url, {})).status).toBe(400);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "POST", url, { texto: "x".repeat(1001) })).status,
    ).toBe(400);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "POST", `/revisoes/abc/recurso`, { texto: "ok" })).status,
    ).toBe(400);
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "POST", url, { texto: "Recurso." })).status, email).toBe(403);
    }
    expect((await chamar(null, "POST", url, { texto: "Recurso." })).status).toBe(401);

    // Pedido de outro atleta: 404, sem revelar que existe.
    const alheio = (
      await p.db.query<{ id: string }>(
        `insert into pedidos_revisao (atleta_id, pilar_id, motivo, criado_por, status, resposta, respondido_por, respondido_em)
         values ($1, 'amb', 'Pedido de atleta de outro treinador.', $2, 'respondido', 'Resposta.',
                 (select id from usuarios where email = $3), now()) returning id::text as id`,
        [outroAtletaId, gestorId, EMAILS_DEMO.treinadora],
      )
    ).rows[0]!.id;
    expect((await recorrer(alheio)).status).toBe(404);
    expect((await recorrer("99999")).status).toBe(404);
    expect((await recorrer(id, "x".repeat(1000))).status).toBe(200);
  });

  it("listagem por papel traz instância, primeira resposta, recurso e resposta final", async () => {
    const id = await pedir();
    await responder(EMAILS_DEMO.treinadora, id, "Resposta 1.");
    await recorrer(id, "Recurso do atleta.");

    const vistas = {
      atleta: await obter(EMAILS_DEMO.atleta, id),
      treinadora: await obter(EMAILS_DEMO.treinadora, id),
      gestor: await obter(EMAILS_DEMO.gestor, id),
    };
    for (const v of Object.values(vistas)) {
      expect(v).toMatchObject({
        instancia: 2,
        status: "aberto",
        primeiraResposta: { texto: "Resposta 1.", papel: "treinador" },
        recurso: { texto: "Recurso do atleta." },
        respostaFinal: null,
      });
    }
    expect((await chamar(EMAILS_DEMO.ibvar, "GET", "/revisoes")).status).toBe(403);
    // Um pedido de atleta de outro treinador não aparece para a treinadora.
    const alheio = (
      await p.db.query<{ id: string }>(
        `insert into pedidos_revisao (atleta_id, pilar_id, motivo, criado_por)
         values ($1, 'amb', 'Pedido de atleta de outro treinador.', $2) returning id::text as id`,
        [outroAtletaId, gestorId],
      )
    ).rows[0]!.id;
    expect(await obter(EMAILS_DEMO.treinadora, alheio)).toBeUndefined();
    expect(await obter(EMAILS_DEMO.atleta, alheio)).toBeUndefined();
    expect(await obter(EMAILS_DEMO.gestor, alheio)).toBeDefined();
  });

  it("balões: recurso conta para o gestor, não para o treinador; atleta conta resposta nova", async () => {
    const g0 = await contagem(EMAILS_DEMO.gestor);
    const t0 = await contagem(EMAILS_DEMO.treinadora);

    const id = await pedir();
    expect(await contagem(EMAILS_DEMO.gestor)).toBe(g0 + 1);
    expect(await contagem(EMAILS_DEMO.treinadora)).toBe(t0 + 1);

    avancar(5);
    await responder(EMAILS_DEMO.treinadora, id);
    expect(await contagem(EMAILS_DEMO.gestor)).toBe(g0);
    expect(await contagem(EMAILS_DEMO.treinadora)).toBe(t0);

    avancar(5);
    await recorrer(id);
    expect(await contagem(EMAILS_DEMO.gestor)).toBe(g0 + 1);
    expect(await contagem(EMAILS_DEMO.treinadora)).toBe(t0);

    avancar(5);
    await responder(EMAILS_DEMO.gestor, id);
    expect(await contagem(EMAILS_DEMO.gestor)).toBe(g0);
  });

  it("restrição de coerência: 2ª instância exige 1ª resposta e recurso", async () => {
    const id = await pedir();
    await responder(EMAILS_DEMO.treinadora, id, "Texto sigiloso da primeira resposta.");
    await recorrer(id, "Texto sigiloso do recurso.");
    const r = await p.db.query<{ atleta_id: string }>(
      "select atleta_id from pedidos_revisao where id = $1::bigint",
      [id],
    );
    expect(r.rows[0]!.atleta_id).toBeDefined();
    // Restrição de coerência: instância 2 exige resposta 1 e recurso preenchidos.
    await expect(
      p.db.query("update pedidos_revisao set recurso_texto = null where id = $1::bigint", [id]),
    ).rejects.toThrow();
  });
});

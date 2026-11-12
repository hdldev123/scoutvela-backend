import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anonimizarAtleta } from "../../src/servicos/anonimizacao.js";
import { criarAdminAuthFalso, type AdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("anonimização do atleta (LGPD)", () => {
  let p: Piloto;
  let admin: AdminAuthFalso;
  beforeAll(async () => {
    admin = criarAdminAuthFalso();
    p = await criarPiloto(AGORA, { adminAuth: admin });
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    metodo: "GET" | "POST",
    url: string,
    corpo?: unknown,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: email ? await p.como(email) : {},
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const anonimizar = (atletaId: string, pedidoTitularId: string, extra: object = {}) =>
    chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${atletaId}/anonimizar`, {
      pedidoTitularId,
      confirmacao: "ANONIMIZAR",
      ...extra,
    });
  const gestorId = async () =>
    (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
  const criarPedido = async (atletaId: string, tipo = "exclusao") => {
    const r = await p.db.query<{ id: string }>(
      `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
       values ($1, $2, 'Quero que apaguem meus dados.', $3) returning id::text as id`,
      [atletaId, tipo, await gestorId()],
    );
    return r.rows[0]!.id;
  };
  const anexar = async (atletaId: string, nomeArquivo = "laudo-segredo.pdf") => {
    const r = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${atletaId}/evidencias`, {
      nomeArquivo,
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
    });
    expect(r.status).toBe(201);
    return r.corpo.id as string;
  };
  /** Cria uma conta de login para um atleta do seed que ainda não tem. */
  const criarConta = async (atletaId: string) => {
    const authUserId = crypto.randomUUID();
    await p.db.query(
      `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
       values ($1, $2, 'Nome Pessoal da Conta', 'atleta', $3)`,
      [authUserId, `conta-${authUserId.slice(0, 8)}@exemplo.dev`, atletaId],
    );
    return authUserId;
  };
  const contar = async (tabela: string, atletaId: string) =>
    Number(
      (
        await p.db.query<{ n: string }>(
          `select count(*)::text as n from ${tabela} where atleta_id = $1`,
          [atletaId],
        )
      ).rows[0]!.n,
    );

  it("ponta a ponta: tira a identificação, mantém a série histórica e audita sem dado pessoal", async () => {
    const id = await p.idDe("SP-T07");
    const antes = (
      await p.db.query<{
        nome: string;
        velaid_codigo: string;
        email_contato: string | null;
        clube: string | null;
      }>("select nome, velaid_codigo, email_contato, clube from atletas where id = $1", [id])
    ).rows[0]!;
    expect(antes.nome).toBe("Helena Vasques");
    const conta = (
      await p.db.query<{ auth_user_id: string; email: string }>(
        "select auth_user_id::text as auth_user_id, email from usuarios where atleta_id = $1",
        [id],
      )
    ).rows[0]!;
    const e1 = await anexar(id);
    const e2 = await anexar(id, "outro-documento.pdf");
    const caminhos = (
      await p.db.query<{ caminho: string }>(
        "select caminho from evidencias_anexos where atleta_id = $1",
        [id],
      )
    ).rows.map((r) => r.caminho);
    expect(caminhos).toHaveLength(2);
    for (const c of caminhos) expect(p.armazenamento.arquivos.has(c)).toBe(true);
    const avaliacoes = await contar("avaliacoes", id);
    const medidas = await contar("medidas_corporais", id);
    const consentimentosAntes = await contar("consentimentos", id);
    expect(avaliacoes).toBeGreaterThan(0);
    expect(medidas).toBeGreaterThan(0);

    // O atleta pede a exclusão pela API.
    const pedido = await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
      tipo: "exclusao",
      descricao: "Quero a exclusão dos meus dados.",
    });
    expect(pedido.status).toBe(201);

    const r = await anonimizar(id, pedido.corpo.id);
    expect(r.status).toBe(200);
    expect(r.corpo).toEqual({
      atletaId: id,
      anonimizadoEm: "2026-11-06T15:00:00.000Z",
      evidenciasRemovidas: 2,
      pendencias: { arquivos: 0, conta: false },
    });

    // atletas
    const depois = (
      await p.db.query<Record<string, unknown>>("select * from atletas where id = $1", [id])
    ).rows[0]!;
    expect(depois).toMatchObject({
      nome: "Atleta anonimizado",
      clube: null,
      cidade: null,
      uf: null,
      numero_vela: null,
      ws_id: null,
      email_contato: null,
      ativo: false,
    });
    expect(depois.velaid_codigo).toMatch(/^ANON-[0-9A-F]{8}$/);
    expect(depois.velaid_codigo).not.toBe(antes.velaid_codigo);
    expect(new Date(depois.anonimizado_em as Date).toISOString()).toBe("2026-11-06T15:00:00.000Z");

    // velaid_registros: a linha do código antigo foi apagada
    expect(
      (await p.db.query("select 1 from velaid_registros where codigo = $1", [antes.velaid_codigo]))
        .rows,
    ).toHaveLength(0);

    // usuarios
    const usuario = (
      await p.db.query<Record<string, unknown>>("select * from usuarios where atleta_id = $1", [id])
    ).rows[0]!;
    expect(usuario).toMatchObject({ nome: "Atleta anonimizado", ativo: false, auth_user_id: null });
    expect(usuario.email).toMatch(/^anonimizado\+[0-9a-f-]{36}@anonimizado\.invalid$/);
    expect(usuario.email).not.toBe(conta.email);

    // consentimentos revogados (histórico preservado)
    const atual = await p.db.query<{ tipo: string; concedido: boolean }>(
      "select tipo, concedido from consentimento_atual where atleta_id = $1 order by tipo",
      [id],
    );
    expect(atual.rows).toEqual([
      { tipo: "compartilhar_ibvar", concedido: false },
      { tipo: "termo_piloto", concedido: false },
    ]);
    expect(await contar("consentimentos", id)).toBe(consentimentosAntes + 2);

    // evidências marcadas e arquivos removidos
    const ev = await p.db.query<{ id: string; nome_arquivo: string; removido_em: Date | null }>(
      "select id, nome_arquivo, removido_em from evidencias_anexos where atleta_id = $1",
      [id],
    );
    expect(ev.rows.map((x) => x.id).sort()).toEqual([e1, e2].sort());
    for (const x of ev.rows) {
      expect(x.nome_arquivo).toBe("removido");
      expect(x.removido_em).not.toBeNull();
    }
    for (const c of caminhos) expect(p.armazenamento.arquivos.has(c)).toBe(false);

    // conta no Auth
    expect(admin.removidas).toEqual([conta.auth_user_id]);
    expect(
      (await p.db.query("select 1 from anonimizacoes_pendentes where atleta_id = $1", [id])).rows,
    ).toHaveLength(0);

    // pedido respondido
    const ped = (
      await p.db.query<{ status: string; resposta: string; respondido_por: string }>(
        "select status, resposta, respondido_por::text as respondido_por from pedidos_titular where id = $1::bigint",
        [pedido.corpo.id],
      )
    ).rows[0]!;
    expect(ped.status).toBe("respondido");
    expect(ped.resposta).toBe(
      "Dados pessoais anonimizados em 06/11/2026. A série histórica de avaliações foi mantida sem identificação direta.",
    );
    expect(ped.respondido_por).toBe(await gestorId());

    // auditoria sem dado pessoal
    const aud = await p.db.query<{ detalhes: unknown; entidade_id: string }>(
      "select detalhes, entidade_id from auditoria where acao = 'anonimizar_atleta'",
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]!.entidade_id).toBe(id);
    expect(aud.rows[0]!.detalhes).toEqual({
      pedidoTitularId: pedido.corpo.id,
      evidencias: 2,
      contaAuth: true,
    });
    const tudoAuditoria = JSON.stringify(
      (await p.db.query("select * from auditoria where acao = 'anonimizar_atleta'")).rows,
    );
    for (const texto of [
      "Helena",
      "Vasques",
      antes.velaid_codigo,
      depois.velaid_codigo as string,
      conta.email,
    ])
      expect(tudoAuditoria).not.toContain(texto);

    // série histórica intacta
    expect(await contar("avaliacoes", id)).toBe(avaliacoes);
    expect(await contar("medidas_corporais", id)).toBe(medidas);

    // o nome antigo não aparece em nenhuma coluna de texto de atletas, usuarios e velaid_registros
    for (const tabela of ["atletas", "usuarios", "velaid_registros"]) {
      const todas = await p.db.query<{ t: string }>(
        `select row_to_json(x)::text as t from ${tabela} x`,
      );
      const linhas = todas.rows.filter(
        (l) =>
          /Helena|Vasques/i.test(l.t) ||
          l.t.includes(antes.velaid_codigo) ||
          l.t.includes(conta.email),
      );
      expect(linhas, tabela).toEqual([]);
    }
    expect(
      (await p.db.query("select 1 from atletas where nome ilike '%Helena%'")).rows,
    ).toHaveLength(0);
    expect(
      (
        await p.db.query(
          "select 1 from usuarios where nome ilike '%Helena%' or email ilike '%atleta@scoutvela%'",
        )
      ).rows,
    ).toHaveLength(0);

    // sai do ranking e aparece como anonimizado nos pedidos do titular
    const ranking = await chamar(EMAILS_DEMO.gestor, "GET", "/ranking");
    expect(ranking.status).toBe(200);
    expect(JSON.stringify(ranking.corpo)).not.toContain("Helena");
    const pedidos = await chamar(EMAILS_DEMO.gestor, "GET", "/pedidos-titular");
    const meu = (pedidos.corpo as { id: string; atleta: { nome: string } }[]).find(
      (x) => x.id === pedido.corpo.id,
    );
    expect(meu?.atleta.nome).toBe("Atleta anonimizado");

    // repetir com o mesmo pedido não repete a transação nem a auditoria
    const repetido = await anonimizar(id, pedido.corpo.id);
    expect(repetido.status).toBe(200);
    expect(repetido.corpo.pendencias).toEqual({ arquivos: 0, conta: false });
    expect(
      (await p.db.query("select 1 from auditoria where acao = 'anonimizar_atleta'")).rows,
    ).toHaveLength(1);
  });

  it("só o gestor anonimiza", async () => {
    const id = await p.idDe("SC-T01");
    const pedido = await criarPedido(id);
    const url = `/atletas/${id}/anonimizar`;
    const corpo = { pedidoTitularId: pedido, confirmacao: "ANONIMIZAR" };
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "POST", url, corpo)).status).toBe(403);
    }
    expect((await chamar(null, "POST", url, corpo)).status).toBe(401);
    const intacto = await p.db.query(
      "select 1 from atletas where id = $1 and anonimizado_em is null",
      [id],
    );
    expect(intacto.rows).toHaveLength(1);
  });

  it("valida confirmação, atleta e pedido", async () => {
    const id = await p.idDe("RS-T02");
    const outro = await p.idDe("SC-T01");
    const pedido = await criarPedido(id);
    const url = `/atletas/${id}/anonimizar`;
    const gestor = (corpo: unknown) => chamar(EMAILS_DEMO.gestor, "POST", url, corpo);

    expect((await gestor({ pedidoTitularId: pedido, confirmacao: "anonimizar" })).status).toBe(400);
    expect((await gestor({ pedidoTitularId: pedido })).status).toBe(400);
    expect(
      (await gestor({ pedidoTitularId: pedido, confirmacao: "ANONIMIZAR", extra: 1 })).status,
    ).toBe(400);

    // atleta inexistente
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${crypto.randomUUID()}/anonimizar`, {
          pedidoTitularId: pedido,
          confirmacao: "ANONIMIZAR",
        })
      ).status,
    ).toBe(404);
    // pedido inexistente, de outro atleta e de outro tipo
    expect((await anonimizar(id, "999999")).status).toBe(400);
    expect((await anonimizar(id, await criarPedido(outro))).status).toBe(400);
    expect((await anonimizar(id, await criarPedido(id, "acesso"))).status).toBe(400);

    // pedido já respondido
    await p.db.query(
      `update pedidos_titular set status = 'respondido', resposta = 'ok', respondido_por = $2, respondido_em = now() where id = $1::bigint`,
      [pedido, await gestorId()],
    );
    expect((await anonimizar(id, pedido)).status).toBe(409);
    expect(
      (await p.db.query("select 1 from atletas where id = $1 and anonimizado_em is null", [id]))
        .rows,
    ).toHaveLength(1);
  });

  it("atleta já anonimizado com outro pedido: 409", async () => {
    const id = await p.idDe("RJ-T03");
    const primeiro = await criarPedido(id);
    expect((await anonimizar(id, primeiro)).status).toBe(200);
    const segundo = await criarPedido(id);
    expect((await anonimizar(id, segundo)).status).toBe(409);
  });

  it("falha no Storage vira pendência; repetir o pedido conclui a remoção", async () => {
    const id = await p.idDe("RJ-T04");
    await anexar(id);
    await anexar(id);
    const pedido = await criarPedido(id);
    p.armazenamento.falharRemocao = true;
    const r = await anonimizar(id, pedido);
    p.armazenamento.falharRemocao = false;
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({
      evidenciasRemovidas: 0,
      pendencias: { arquivos: 2, conta: false },
    });
    const caminhos = (
      await p.db.query<{ caminho: string }>(
        "select caminho from evidencias_anexos where atleta_id = $1",
        [id],
      )
    ).rows.map((x) => x.caminho);
    for (const c of caminhos) expect(p.armazenamento.arquivos.has(c)).toBe(true);
    // A anonimização no banco valeu.
    expect(
      (await p.db.query("select 1 from atletas where id = $1 and anonimizado_em is not null", [id]))
        .rows,
    ).toHaveLength(1);

    const retomada = await anonimizar(id, pedido);
    expect(retomada.status).toBe(200);
    expect(retomada.corpo).toMatchObject({
      evidenciasRemovidas: 2,
      pendencias: { arquivos: 0, conta: false },
    });
    for (const c of caminhos) expect(p.armazenamento.arquivos.has(c)).toBe(false);
  });

  it("falha no Auth vira pendência (e guarda o id); repetir o pedido apaga a conta", async () => {
    const id = await p.idDe("RJ-T06");
    const authUserId = await criarConta(id);
    const pedido = await criarPedido(id);
    admin.falharRemocao = true;
    const r = await anonimizar(id, pedido);
    admin.falharRemocao = false;
    expect(r.status).toBe(200);
    expect(r.corpo.pendencias).toEqual({ arquivos: 0, conta: true });
    expect(admin.removidas).not.toContain(authUserId);
    const guardado = await p.db.query<{ auth_user_id: string }>(
      "select auth_user_id::text as auth_user_id from anonimizacoes_pendentes where atleta_id = $1",
      [id],
    );
    expect(guardado.rows).toEqual([{ auth_user_id: authUserId }]);

    const retomada = await anonimizar(id, pedido);
    expect(retomada.status).toBe(200);
    expect(retomada.corpo.pendencias).toEqual({ arquivos: 0, conta: false });
    expect(admin.removidas).toContain(authUserId);
    expect(
      (await p.db.query("select 1 from anonimizacoes_pendentes where atleta_id = $1", [id])).rows,
    ).toHaveLength(0);
  });

  it("não loga caminho, id nem e-mail ao falhar (serviço direto)", async () => {
    const id = await p.idDe("DF-T11");
    const authUserId = await criarConta(id);
    await anexar(id);
    const pedido = await criarPedido(id);
    const logs: Record<string, unknown>[] = [];
    p.armazenamento.falharRemocao = true;
    admin.falharRemocao = true;
    const r = await anonimizarAtleta(
      {
        db: p.db,
        armazenamento: p.armazenamento,
        adminAuth: admin,
        agora: AGORA,
        log: { warn: (obj) => logs.push(obj) },
      },
      { atletaId: id, pedidoTitularId: pedido, gestorId: await gestorId() },
    );
    p.armazenamento.falharRemocao = false;
    admin.falharRemocao = false;
    expect(r.pendencias).toEqual({ arquivos: 1, conta: true });
    expect(logs).toEqual([
      { evento: "anonimizacao_pendencia", tipo: "arquivo", erro: "Error" },
      { evento: "anonimizacao_pendencia", tipo: "conta", erro: "Error" },
    ]);
    expect(JSON.stringify(logs)).not.toContain(authUserId);
  });

  it("sem AdminAuth configurado a conta fica pendente", async () => {
    const id = await p.idDe("DF-T12");
    await criarConta(id);
    const pedido = await criarPedido(id);
    const r = await anonimizarAtleta(
      {
        db: p.db,
        armazenamento: p.armazenamento,
        adminAuth: null,
        agora: AGORA,
        log: { warn: () => undefined },
      },
      { atletaId: id, pedidoTitularId: pedido, gestorId: await gestorId() },
    );
    expect(r.pendencias).toEqual({ arquivos: 0, conta: true });
  });
});

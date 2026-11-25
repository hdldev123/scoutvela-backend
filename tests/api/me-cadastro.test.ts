import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { cabecalhoAuth, criarAppDeTeste, criarUsuarioDeTeste, tokenPara } from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("PUT /me/cadastro", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db, { agora: AGORA });
    await db.query(
      `insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
       values ('classe_teste', 'Classe Teste', 'Evento Teste', 'ind', 60, 70, 80, 9999)
       on conflict (id) do nothing`,
    );
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  /** Atleta com cadastro incompleto e a conta de login ligada. */
  async function incompleto(sufixo: string, velaid: string | null = null) {
    const authUserId = crypto.randomUUID();
    const a = await db.query<{ id: string }>(
      `insert into atletas (ws_id, velaid_codigo, classe_id, email_contato)
       values ($1, $2, 'classe_teste', $3) returning id`,
      [`BRA${sufixo}`, velaid, `${sufixo.toLowerCase()}@exemplo.dev`],
    );
    const atletaId = a.rows[0]!.id;
    const u = await db.query<{ id: string }>(
      `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
       values ($1, $2, $3, 'atleta', $4) returning id`,
      [authUserId, `${sufixo.toLowerCase()}@exemplo.dev`, sufixo.toLowerCase(), atletaId],
    );
    return {
      atletaId,
      usuarioId: u.rows[0]!.id,
      cab: cabecalhoAuth(await tokenPara(authUserId)),
    };
  }
  const put = async (cab: { authorization: string } | null, payload: unknown) => {
    const r = await app.inject({
      method: "PUT",
      url: "/me/cadastro",
      headers: cab ?? {},
      payload: payload as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const valido = { nome: "Maria da Silva", genero: "F", dataNascimento: "2000-05-10" };

  it("papéis: sem token 401; gestor, treinador e IBVAR 403", async () => {
    expect((await put(null, valido)).status).toBe(401);
    for (const papel of ["gestor", "treinador", "ibvar"] as const) {
      const u = await criarUsuarioDeTeste(db, { papel });
      const r = await put(cabecalhoAuth(await tokenPara(u.authUserId)), valido);
      expect(r.status, papel).toBe(403);
    }
  });

  it("validações: nome, gênero, data e campos extras -> 400, sem gravar", async () => {
    const a = await incompleto("VAL01");
    const invalidos: unknown[] = [
      { ...valido, nome: "A" },
      { ...valido, nome: "   " },
      { ...valido, nome: "x".repeat(121) },
      { ...valido, genero: "X" },
      { ...valido, dataNascimento: "10/05/2000" },
      { ...valido, dataNascimento: "2000-02-31" },
      { ...valido, dataNascimento: "2026-11-07" },
      { ...valido, dataNascimento: "1900-01-01" },
      { ...valido, extra: 1 },
      { nome: valido.nome, genero: valido.genero },
      {},
    ];
    for (const corpo of invalidos) {
      const r = await put(a.cab, corpo);
      expect(r.status, JSON.stringify(corpo)).toBe(400);
    }
    const linha = (
      await db.query<{ nome: string | null; cadastro_completo_em: Date | null; ativo: boolean }>(
        "select nome, cadastro_completo_em, ativo from atletas where id = $1",
        [a.atletaId],
      )
    ).rows[0]!;
    expect(linha).toEqual({ nome: null, cadastro_completo_em: null, ativo: true });
  });

  it("completa uma vez: grava, sincroniza o nome da conta, audita só os campos e a segunda dá 409", async () => {
    const a = await incompleto("OK001");
    const r = await put(a.cab, { ...valido, nome: "  Ana Clara Souza  " });
    expect(r.status).toBe(200);
    expect(r.corpo).toEqual({
      nome: "Ana Clara Souza",
      genero: "F",
      dataNascimento: "2000-05-10",
      cadastroCompleto: true,
    });
    const linha = (
      await db.query<{ nome: string; genero: string; dn: string; em: Date }>(
        "select nome, genero, data_nascimento::text as dn, cadastro_completo_em as em from atletas where id = $1",
        [a.atletaId],
      )
    ).rows[0]!;
    expect(linha).toMatchObject({ nome: "Ana Clara Souza", genero: "F", dn: "2000-05-10" });
    expect(linha.em).toEqual(AGORA());
    expect(
      (await db.query<{ nome: string }>("select nome from usuarios where id = $1", [a.usuarioId]))
        .rows[0]!.nome,
    ).toBe("Ana Clara Souza");
    const aud = await db.query<{ acao: string; detalhes: unknown }>(
      "select acao, detalhes from auditoria where entidade_id = $1",
      [a.atletaId],
    );
    expect(aud.rows).toEqual([
      { acao: "completar_cadastro", detalhes: { campos: ["nome", "genero", "dataNascimento"] } },
    ]);
    expect(JSON.stringify(aud.rows)).not.toMatch(/2000|Ana Clara/);

    const de_novo = await put(a.cab, {
      nome: "Outra Pessoa",
      genero: "M",
      dataNascimento: "1990-01-01",
    });
    expect(de_novo.status).toBe(409);
    expect(de_novo.corpo.mensagem).toContain("pedido do titular");
    expect(
      (await db.query<{ nome: string }>("select nome from atletas where id = $1", [a.atletaId]))
        .rows[0]!.nome,
    ).toBe("Ana Clara Souza");
  });

  it("18 anos completos hoje passa; um dia a menos recusa", async () => {
    const ok = await incompleto("IDA18");
    expect((await put(ok.cab, { ...valido, dataNascimento: "2008-11-06" })).status).toBe(200);
    const menor = await incompleto("IDA17");
    expect((await put(menor.cab, { ...valido, dataNascimento: "2008-11-07" })).status).toBe(400);
  });

  it("menor de 18: recusa sem gravar a data, inativa atleta e conta, abre pedido, audita sem a data e avisa o gestor", async () => {
    const gestorU = await criarUsuarioDeTeste(db, { papel: "gestor" });
    const cabGestor = cabecalhoAuth(await tokenPara(gestorU.authUserId));
    const balao = async () =>
      (await app.inject({ method: "GET", url: "/me/notificacoes", headers: cabGestor })).json()
        .contagens.cadastro as number;
    const balaoAntes = await balao();

    const a = await incompleto("MEN01");
    const r = await put(a.cab, {
      nome: "Menor de Idade",
      genero: "M",
      dataNascimento: "2010-03-03",
    });
    expect(r.status).toBe(400);
    expect(r.corpo.erro).toBe("requisicao_invalida");
    expect(r.corpo.mensagem).toContain("18 anos ou mais");
    expect(r.corpo.mensagem).not.toContain("2010");

    const linha = (
      await db.query<{
        nome: string | null;
        genero: string | null;
        data_nascimento: string | null;
        ativo: boolean;
        completo: Date | null;
        recusado: Date | null;
      }>(
        `select nome, genero, data_nascimento::text, ativo, cadastro_completo_em as completo,
                cadastro_recusado_em as recusado from atletas where id = $1`,
        [a.atletaId],
      )
    ).rows[0]!;
    expect(linha).toEqual({
      nome: null,
      genero: null,
      data_nascimento: null,
      ativo: false,
      completo: null,
      recusado: AGORA(),
    });
    expect(
      (
        await db.query<{ ativo: boolean }>("select ativo from usuarios where id = $1", [
          a.usuarioId,
        ])
      ).rows[0]!.ativo,
    ).toBe(false);

    // Auditoria sem a data, a idade nem o nome.
    const aud = await db.query<{ acao: string; detalhes: unknown }>(
      "select acao, detalhes from auditoria where entidade_id = $1",
      [a.atletaId],
    );
    expect(aud.rows).toEqual([{ acao: "recusar_cadastro_menor", detalhes: {} }]);

    // Pedido de exclusão aberto pelo sistema, para o gestor anonimizar.
    const pedido = await db.query<{ tipo: string; status: string }>(
      "select tipo, status from pedidos_titular where atleta_id = $1",
      [a.atletaId],
    );
    expect(pedido.rows).toEqual([{ tipo: "exclusao", status: "aberto" }]);

    // O gestor vê no balão de Cadastro e na lista.
    expect(await balao()).toBe(balaoAntes + 1);
    const lista = await app.inject({
      method: "GET",
      url: "/atletas?cadastroCompleto=false",
      headers: cabGestor,
    });
    expect(lista.json().find((x: { id: string }) => x.id === a.atletaId)).toMatchObject({
      ativo: false,
      cadastroCompleto: false,
      cadastroRecusado: true,
    });

    // A conta fica inativa: a sessão deixa de valer.
    const depois = await put(a.cab, valido);
    expect(depois.status).toBe(403);
  });

  it("GET /me traz a sugestão do VelaID, só enquanto o cadastro está pendente", async () => {
    await db.query(
      `insert into velaid_registros (codigo, nome, genero, data_nascimento, fonte)
       values ('SP-S01', 'Sugestão Silva', 'M', '1998-01-02', 'simulado')`,
    );
    const com = await incompleto("SUG01", "SP-S01");
    const r = await app.inject({ method: "GET", url: "/me", headers: com.cab });
    expect(r.json().cadastroPendente).toEqual({
      wsId: "BRASUG01",
      velaid: "SP-S01",
      sugestao: { nome: "Sugestão Silva", genero: "M", dataNascimento: "1998-01-02" },
      origemSugestao: "velaid",
    });
    expect(r.json().atleta).toEqual({ id: com.atletaId, nome: null });

    const sem = await incompleto("SUG02", "SP-X99");
    const r2 = await app.inject({ method: "GET", url: "/me", headers: sem.cab });
    expect(r2.json().cadastroPendente).toEqual({
      wsId: "BRASUG02",
      velaid: "SP-X99",
      sugestao: null,
      origemSugestao: null,
    });

    // Treinador não tem cadastro pendente.
    const t = await criarUsuarioDeTeste(db, { papel: "treinador" });
    const rt = await app.inject({
      method: "GET",
      url: "/me",
      headers: cabecalhoAuth(await tokenPara(t.authUserId)),
    });
    expect(rt.json().cadastroPendente).toBeNull();
  });
});

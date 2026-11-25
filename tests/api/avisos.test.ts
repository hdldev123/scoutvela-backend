import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAdminAuthFalso, tokenPara } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("D8: avisos entre treinador e atleta", () => {
  let p: Piloto;
  let helena: string; // SP-T07, conta de atleta, da treinadora Ana
  let marcosAtleta: string; // RS-T02, do Marcos Pires, sem conta de login
  let anaId: string;
  let marcosId: string;
  let authMarcos: { authorization: string };

  beforeAll(async () => {
    p = await criarPiloto(() => agora, { adminAuth: criarAdminAuthFalso() });
    [helena, marcosAtleta] = await Promise.all([p.idDe("SP-T07"), p.idDe("RS-T02")]);
    anaId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
    marcosId = (
      await p.db.query<{ treinador_id: string }>("select treinador_id from atletas where id = $1", [
        marcosAtleta,
      ])
    ).rows[0]!.treinador_id;
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authUserId, marcosId]);
    authMarcos = cabecalhoAuth(await tokenPara(authUserId));
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    quem: string | { authorization: string } | null,
    metodo: "GET" | "POST" | "PUT",
    url: string,
    corpo?: unknown,
  ) => {
    const headers = quem === null ? {} : typeof quem === "string" ? await p.como(quem) : quem;
    const r = await p.app.inject({
      method: metodo,
      url,
      headers,
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const avisosDe = async (quem: string | { authorization: string }, query = "") =>
    (await chamar(quem, "GET", `/me/avisos${query}`)).corpo as {
      itens: {
        id: string;
        tipo: string;
        lidoEm: string | null;
        atleta: { id: string; nome: string } | null;
        referencia: Record<string, unknown>;
        criadoPor: { nome: string; papel: string } | null;
        mensagem: string | null;
        indicador: { id: string; nome: string } | null;
      }[];
      proximoAntesDe: string | null;
      naoLidos: number;
    };
  const naoLidosNoBalao = async (quem: string | { authorization: string }) =>
    ((await chamar(quem, "GET", "/me/notificacoes")).corpo as { contagens: Record<string, number> })
      .contagens.avisos;
  const tipos = (l: { itens: { tipo: string }[] }) => l.itens.map((i) => i.tipo);

  describe("eventos do atleta geram aviso ao treinador dele", () => {
    it("começa sem avisos para ninguém", async () => {
      expect((await avisosDe(EMAILS_DEMO.treinadora)).itens).toEqual([]);
      expect((await avisosDe(authMarcos)).itens).toEqual([]);
    });

    it("POST /respostas: atleta_respondeu com o indicador, só para a treinadora do atleta", async () => {
      avancar(1);
      const r = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", {
        indicadorId: "amb_apoio_familiar",
        resposta: "Apoia totalmente",
      });
      expect(r.status).toBe(201);
      const l = await avisosDe(EMAILS_DEMO.treinadora);
      expect(l.itens).toHaveLength(1);
      expect(l.itens[0]).toMatchObject({
        tipo: "atleta_respondeu",
        lidoEm: null,
        atleta: { id: helena },
        referencia: { indicadorId: "amb_apoio_familiar" },
        criadoPor: { papel: "atleta" },
        mensagem: null,
        indicador: { id: "amb_apoio_familiar" },
      });
      // Sem nota, peso nem texto da resposta.
      expect(JSON.stringify(l.itens[0]!.referencia)).not.toContain("Apoia");
      expect((await avisosDe(authMarcos)).itens).toEqual([]);
      expect((await avisosDe(EMAILS_DEMO.gestor)).itens).toEqual([]);
    });

    it("POST /atletas/:id/evidencias pelo atleta: atleta_anexou com anexoId e categoria, sem nome de arquivo", async () => {
      avancar(1);
      const r = await chamar(EMAILS_DEMO.atleta, "POST", `/atletas/${helena}/evidencias`, {
        nomeArquivo: "segredo-do-atleta.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: pdf().toString("base64"),
        categoria: "sumula",
      });
      expect(r.status).toBe(201);
      const a = (await avisosDe(EMAILS_DEMO.treinadora)).itens.find(
        (i) => i.tipo === "atleta_anexou",
      )!;
      expect(a.referencia).toEqual({ anexoId: r.corpo.id, categoria: "sumula" });
      expect(JSON.stringify(a)).not.toContain("segredo");
    });

    it("anexo enviado pela treinadora ou pelo gestor não gera aviso", async () => {
      avancar(1);
      const antes = (await avisosDe(EMAILS_DEMO.treinadora)).itens.length;
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.gestor]) {
        const r = await chamar(email, "POST", `/atletas/${helena}/evidencias`, {
          nomeArquivo: "doc.pdf",
          tipoMime: "application/pdf",
          conteudoBase64: pdf().toString("base64"),
        });
        expect(r.status).toBe(201);
      }
      expect((await avisosDe(EMAILS_DEMO.treinadora)).itens).toHaveLength(antes);
      expect((await avisosDe(EMAILS_DEMO.atleta)).itens).toEqual([]);
    });

    it("PUT /me/perfil do atleta: atleta_atualizou_perfil só com os nomes dos campos; o do treinador não avisa", async () => {
      avancar(1);
      const antes = (await avisosDe(EMAILS_DEMO.treinadora)).itens.length;
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "PUT", "/me/perfil", { nome: "Ana R." })).status,
      ).toBe(200);
      expect((await avisosDe(EMAILS_DEMO.treinadora)).itens).toHaveLength(antes);
      const r = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", {
        telefone: "(11) 99999-8888",
      });
      expect(r.status).toBe(200);
      const a = (await avisosDe(EMAILS_DEMO.treinadora)).itens[0]!;
      expect(a).toMatchObject({
        tipo: "atleta_atualizou_perfil",
        referencia: { campos: ["telefone"] },
      });
      expect(JSON.stringify(a)).not.toContain("99999");
    });

    it("PUT /me/cadastro: atleta_completou_cadastro ao treinador do atleta (e não a outro)", async () => {
      avancar(1);
      const classe = (await p.db.query<{ id: string }>("select id from classes limit 1")).rows[0]!
        .id;
      const authUserId = crypto.randomUUID();
      const a = await p.db.query<{ id: string }>(
        `insert into atletas (ws_id, classe_id, treinador_id, email_contato)
         values ('BRAAVISO01', $1, $2, 'aviso01@exemplo.dev') returning id`,
        [classe, anaId],
      );
      await p.db.query(
        `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
         values ($1, 'aviso01@exemplo.dev', 'aviso01', 'atleta', $2)`,
        [authUserId, a.rows[0]!.id],
      );
      const r = await chamar(cabecalhoAuth(await tokenPara(authUserId)), "PUT", "/me/cadastro", {
        nome: "Maria da Silva",
        genero: "F",
        dataNascimento: "2000-05-10",
      });
      expect(r.status).toBe(200);
      const l = await avisosDe(EMAILS_DEMO.treinadora);
      expect(l.itens[0]).toMatchObject({
        tipo: "atleta_completou_cadastro",
        atleta: { id: a.rows[0]!.id, nome: "Maria da Silva" },
      });
      expect((await avisosDe(authMarcos)).itens).toEqual([]);
    });

    it("atleta sem treinador não gera aviso nem erro", async () => {
      avancar(1);
      await p.db.query("update atletas set treinador_id = null where id = $1", [helena]);
      const antes = (await avisosDe(EMAILS_DEMO.treinadora)).itens.length;
      const r = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { telefone: "11988887777" });
      expect(r.status).toBe(200);
      expect((await avisosDe(EMAILS_DEMO.treinadora)).itens).toHaveLength(antes);
      await p.db.query("update atletas set treinador_id = $2 where id = $1", [helena, anaId]);
    });

    it("quem deixou de ser o treinador do atleta não vê mais o aviso dele (acesso no SQL)", async () => {
      const antes = await avisosDe(EMAILS_DEMO.treinadora);
      const resp = antes.itens.find(
        (i) => i.atleta?.id === helena && i.tipo === "atleta_respondeu",
      )!;
      await p.db.query("update atletas set treinador_id = $2 where id = $1", [helena, marcosId]);
      const durante = await avisosDe(EMAILS_DEMO.treinadora);
      expect(durante.itens.find((i) => i.id === resp.id)).toBeUndefined();
      expect(durante.naoLidos).toBeLessThan(antes.naoLidos);
      await p.db.query("update atletas set treinador_id = $2 where id = $1", [helena, anaId]);
    });
  });

  describe("POST /atletas/:id/pedidos-ajuste", () => {
    const url = (id: string) => `/atletas/${id}/pedidos-ajuste`;

    it("papéis: sem token 401; atleta e IBVAR 403; treinador de outro atleta 404", async () => {
      const corpo = { mensagem: "Revise a tática." };
      expect((await chamar(null, "POST", url(helena), corpo)).status).toBe(401);
      expect((await chamar(EMAILS_DEMO.atleta, "POST", url(helena), corpo)).status).toBe(403);
      expect((await chamar(EMAILS_DEMO.ibvar, "POST", url(helena), corpo)).status).toBe(403);
      expect((await chamar(authMarcos, "POST", url(helena), corpo)).status).toBe(404);
      expect((await chamar(EMAILS_DEMO.treinadora, "POST", url(marcosAtleta), corpo)).status).toBe(
        404,
      );
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "POST", url(crypto.randomUUID()), corpo)).status,
      ).toBe(404);
    });

    it("validações por campo: mensagem vazia ou acima de 300, indicador inexistente, campo extra", async () => {
      for (const mensagem of ["", "   ", "x".repeat(301)]) {
        const r = await chamar(EMAILS_DEMO.treinadora, "POST", url(helena), { mensagem });
        expect(r.status).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("mensagem");
      }
      const ind = await chamar(EMAILS_DEMO.treinadora, "POST", url(helena), {
        mensagem: "Revise.",
        indicadorId: "nao_existe",
      });
      expect(ind.status).toBe(400);
      expect(ind.corpo.campos).toEqual([
        { campo: "indicadorId", mensagem: "Indicador inexistente." },
      ]);
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "POST", url(helena), { mensagem: "a", extra: 1 }))
          .status,
      ).toBe(400);
      expect((await chamar(EMAILS_DEMO.treinadora, "POST", url(helena), {})).status).toBe(400);
    });

    it("treinadora pede ajuste de um indicador: 201, aviso ao atleta com mensagem e indicador, auditoria só com ids", async () => {
      avancar(1);
      const mensagem = "Você preencheu tática diferente, revise.";
      const r = await chamar(EMAILS_DEMO.treinadora, "POST", url(helena), {
        mensagem,
        indicadorId: "amb_apoio_familiar",
      });
      expect(r.status).toBe(201);
      expect(r.corpo).toEqual({ id: expect.any(String), avisoEnviado: true });
      const l = await avisosDe(EMAILS_DEMO.atleta);
      expect(l.itens).toHaveLength(1);
      expect(l.itens[0]).toMatchObject({
        tipo: "pedido_ajuste",
        atleta: { id: helena },
        referencia: { pedidoAjusteId: r.corpo.id },
        criadoPor: { nome: "Ana R.", papel: "treinador" },
        mensagem,
        indicador: { id: "amb_apoio_familiar" },
      });
      expect(await naoLidosNoBalao(EMAILS_DEMO.atleta)).toBe(1);

      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'pedir_ajuste' and entidade_id = $1",
        [helena],
      );
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0]!.detalhes).toEqual({
        pedidoAjusteId: r.corpo.id,
        indicadorId: "amb_apoio_familiar",
        avisados: 1,
      });
      expect(JSON.stringify(aud.rows)).not.toContain("tática");
      // O treinador não recebe aviso do próprio pedido.
      expect(tipos(await avisosDe(EMAILS_DEMO.treinadora))).not.toContain("pedido_ajuste");
    });

    it("gestor pede ajuste sobre o perfil (sem indicador)", async () => {
      avancar(1);
      const r = await chamar(EMAILS_DEMO.gestor, "POST", url(helena), {
        mensagem: "Confira o telefone.",
      });
      expect(r.status).toBe(201);
      const a = (await avisosDe(EMAILS_DEMO.atleta)).itens[0]!;
      expect(a).toMatchObject({
        tipo: "pedido_ajuste",
        indicador: null,
        mensagem: "Confira o telefone.",
        criadoPor: { papel: "gestor" },
      });
    });

    it("atleta sem conta de login: grava o pedido e responde sem aviso", async () => {
      const r = await chamar(authMarcos, "POST", url(marcosAtleta), {
        mensagem: "Revise o perfil.",
      });
      expect(r.status).toBe(201);
      expect(r.corpo.avisoEnviado).toBe(false);
      const n = await p.db.query<{ n: string }>(
        "select count(*)::text as n from pedidos_ajuste where atleta_id = $1",
        [marcosAtleta],
      );
      expect(n.rows[0]!.n).toBe("1");
    });

    it("a tabela é só de inserção", async () => {
      await expect(p.db.exec("update pedidos_ajuste set mensagem = 'x'")).rejects.toThrow(
        /aceita só inserção/,
      );
      await expect(p.db.exec("delete from pedidos_ajuste")).rejects.toThrow(/aceita só inserção/);
    });
  });

  describe("leitura e marcação", () => {
    it("sem token 401 e IBVAR com lista vazia (e 403 ao marcar)", async () => {
      expect((await chamar(null, "GET", "/me/avisos")).status).toBe(401);
      expect((await chamar(null, "PUT", "/me/avisos/lidos")).status).toBe(401);
      expect((await chamar(null, "PUT", "/me/avisos/1/lido")).status).toBe(401);
      expect(await avisosDe(EMAILS_DEMO.ibvar)).toEqual({
        itens: [],
        proximoAntesDe: null,
        naoLidos: 0,
      });
      expect((await chamar(EMAILS_DEMO.ibvar, "PUT", "/me/avisos/lidos")).status).toBe(403);
      expect((await chamar(EMAILS_DEMO.ibvar, "PUT", "/me/avisos/1/lido")).status).toBe(403);
      const n = (await chamar(EMAILS_DEMO.ibvar, "GET", "/me/notificacoes")).corpo;
      expect(n.contagens).not.toHaveProperty("avisos");
    });

    it("contagem de não lidos no balão em gestor, treinador e atleta", async () => {
      expect(await naoLidosNoBalao(EMAILS_DEMO.gestor)).toBe(0);
      const t = await avisosDe(EMAILS_DEMO.treinadora);
      expect(await naoLidosNoBalao(EMAILS_DEMO.treinadora)).toBe(t.naoLidos);
      expect(t.naoLidos).toBeGreaterThan(0);
      expect(await naoLidosNoBalao(EMAILS_DEMO.atleta)).toBe(2);
    });

    it("só o dono marca como lido: aviso de outra pessoa é 404 e continua não lido", async () => {
      const dele = (await avisosDe(EMAILS_DEMO.atleta)).itens[0]!;
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "PUT", `/me/avisos/${dele.id}/lido`)).status,
      ).toBe(404);
      expect((await chamar(authMarcos, "PUT", `/me/avisos/${dele.id}/lido`)).status).toBe(404);
      expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/me/avisos/abc/lido")).status).toBe(400);
      expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/me/avisos/999999999/lido")).status).toBe(
        404,
      );
      expect((await avisosDe(EMAILS_DEMO.atleta)).itens[0]!.lidoEm).toBeNull();

      avancar(1);
      expect((await chamar(EMAILS_DEMO.atleta, "PUT", `/me/avisos/${dele.id}/lido`)).status).toBe(
        204,
      );
      const depois = await avisosDe(EMAILS_DEMO.atleta);
      expect(depois.itens[0]!.lidoEm).toBe(agora.toISOString());
      expect(depois.naoLidos).toBe(1);
      // Repetir mantém a primeira data.
      avancar(5);
      expect((await chamar(EMAILS_DEMO.atleta, "PUT", `/me/avisos/${dele.id}/lido`)).status).toBe(
        204,
      );
      expect((await avisosDe(EMAILS_DEMO.atleta)).itens[0]!.lidoEm).not.toBe(agora.toISOString());
    });

    it("apenasNaoLidos filtra e a paginação por data devolve tudo sem repetir", async () => {
      const naoLidos = await avisosDe(EMAILS_DEMO.atleta, "?apenasNaoLidos=true");
      expect(naoLidos.itens).toHaveLength(1);
      expect(naoLidos.itens[0]!.lidoEm).toBeNull();

      const todos = await avisosDe(EMAILS_DEMO.treinadora, "?limite=100");
      expect(todos.itens.length).toBeGreaterThanOrEqual(4);
      const vistos: string[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const pagina = await avisosDe(
          EMAILS_DEMO.treinadora,
          `?limite=2${cursor ? `&antesDe=${encodeURIComponent(cursor)}` : ""}`,
        );
        vistos.push(...pagina.itens.map((x) => x.id));
        cursor = pagina.proximoAntesDe;
        if (!cursor) break;
      }
      expect(vistos).toEqual(todos.itens.map((x) => x.id));
      expect((await chamar(EMAILS_DEMO.treinadora, "GET", "/me/avisos?limite=0")).status).toBe(400);
      expect((await chamar(EMAILS_DEMO.treinadora, "GET", "/me/avisos?antesDe=ontem")).status).toBe(
        400,
      );
    });

    it("PUT /me/avisos/lidos marca todos e só os do próprio usuário", async () => {
      const treinadoraAntes = (await avisosDe(EMAILS_DEMO.treinadora)).naoLidos;
      const r = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/avisos/lidos");
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ marcados: 1 });
      expect(await naoLidosNoBalao(EMAILS_DEMO.atleta)).toBe(0);
      expect((await avisosDe(EMAILS_DEMO.treinadora)).naoLidos).toBe(treinadoraAntes);
      const t = await chamar(EMAILS_DEMO.treinadora, "PUT", "/me/avisos/lidos");
      expect(t.corpo.marcados).toBe(treinadoraAntes);
      expect(await naoLidosNoBalao(EMAILS_DEMO.treinadora)).toBe(0);
    });
  });

  describe("anonimização do atleta", () => {
    it("apaga os pedidos de ajuste e os avisos do atleta, e preserva os de outros atletas", async () => {
      const contar = async (tabela: string, atleta: string) =>
        Number(
          (
            await p.db.query<{ n: string }>(
              `select count(*)::text as n from ${tabela} where atleta_id = $1`,
              [atleta],
            )
          ).rows[0]!.n,
        );
      expect(await contar("pedidos_ajuste", helena)).toBe(2);
      expect(await contar("avisos", helena)).toBeGreaterThan(4);
      const outros = await contar("pedidos_ajuste", marcosAtleta);
      expect(outros).toBe(1);

      const pedido = await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
        tipo: "exclusao",
        descricao: "Quero que apaguem os meus dados.",
      });
      expect(pedido.status).toBe(201);
      const r = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${helena}/anonimizar`, {
        pedidoTitularId: pedido.corpo.id,
        confirmacao: "ANONIMIZAR",
      });
      expect(r.status).toBe(200);

      expect(await contar("pedidos_ajuste", helena)).toBe(0);
      expect(await contar("avisos", helena)).toBe(0);
      expect(await contar("pedidos_ajuste", marcosAtleta)).toBe(outros);
      // Sobra só o aviso do outro atleta (o cadastro completado).
      expect(tipos(await avisosDe(EMAILS_DEMO.treinadora))).toEqual(["atleta_completou_cadastro"]);
      // Nenhuma coluna guarda a mensagem do pedido.
      const sobra = await p.db.query(
        "select 1 from auditoria where detalhes::text like '%tática%'",
      );
      expect(sobra.rows).toEqual([]);
    });
  });
});

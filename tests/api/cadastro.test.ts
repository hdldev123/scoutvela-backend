import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const TERMO = "Piloto 18+ · v1";

describe("cadastro pelo VelaID, termo e importações", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const chamar = async (email: string, method: "GET" | "POST", url: string, payload?: unknown) => {
    const r = await p.app.inject({
      method,
      url,
      headers: await p.como(email),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const gestor = (method: "GET" | "POST", url: string, payload?: unknown) =>
    chamar(EMAILS_DEMO.gestor, method, url, payload);
  const contar = async (sql: string) =>
    Number((await p.db.query<{ n: string }>(`select count(*)::text n from ${sql}`)).rows[0]!.n);
  const treinadorId = async (email: string) =>
    (await p.db.query<{ id: string }>("select id from usuarios where email = $1", [email])).rows[0]!
      .id;

  describe("POST /velaid/busca", () => {
    it("acha adulto elegível, normaliza o código e não devolve e-mail", async () => {
      const { status, corpo } = await gestor("POST", "/velaid/busca", { codigo: "  mg-t15 " });
      expect(status).toBe(200);
      expect(corpo).toEqual({
        codigo: "MG-T15",
        nome: "Renata Bastos",
        genero: "F",
        dataNascimento: "2005-08-19",
        idade: 21,
        clube: "Clube Náutico Lagoa Azul",
        cidade: "Lagoa Santa",
        uf: "MG",
        wsId: "BRARB51",
        jaNoPiloto: false,
        elegivel: true,
        motivo: null,
      });
      expect(JSON.stringify(corpo)).not.toContain("@");
    });

    it("17 anos -> inelegível com o motivo do protótipo", async () => {
      const { corpo } = await gestor("POST", "/velaid/busca", { codigo: "PE-T17" });
      expect(corpo.idade).toBe(17);
      expect(corpo.elegivel).toBe(false);
      expect(corpo.motivo).toBe(
        "Cadastro bloqueado: Sofia Lins tem 17 anos. O piloto aceita só 18+; a versão para menores, com responsável, está em desenho.",
      );
    });

    it("já no piloto -> inelegível", async () => {
      const { corpo } = await gestor("POST", "/velaid/busca", { codigo: "SC-T01" });
      expect(corpo.jaNoPiloto).toBe(true);
      expect(corpo.elegivel).toBe(false);
      expect(corpo.motivo).toBe("O código SC-T01 já está no piloto.");
    });

    it("inexistente -> 404; malformado -> 400", async () => {
      const nao = await gestor("POST", "/velaid/busca", { codigo: "ZZ-X99" });
      expect(nao.status).toBe(404);
      expect(nao.corpo.mensagem).toBe("Nenhum atleta com o código ZZ-X99 no VelaID.");
      for (const codigo of ["MG15", "M-T15", "MG-T", "MG-T15; drop", "1G-T15", ""]) {
        expect((await gestor("POST", "/velaid/busca", { codigo })).status, codigo).toBe(400);
      }
      expect((await gestor("POST", "/velaid/busca", {})).status).toBe(400);
    });
  });

  describe("GET /treinadores", () => {
    it("lista treinadores ativos por nome", async () => {
      const { status, corpo } = await gestor("GET", "/treinadores");
      expect(status).toBe(200);
      expect(corpo.map((t: { nome: string }) => t.nome)).toEqual(["Ana Ribeiro", "Marcos Pires"]);
    });
  });

  describe("fluxo completo", () => {
    let novoId: string;

    it("POST /atletas cadastra, audita o envio do termo e não entra no ranking", async () => {
      const ana = await treinadorId(EMAILS_DEMO.treinadora);
      const { status, corpo } = await gestor("POST", "/atletas", {
        velaidCodigo: "mg-t15",
        classeId: "ilca7",
        treinadorId: ana,
      });
      expect(status).toBe(201);
      expect(corpo.nome).toBe("Renata Bastos");
      expect(corpo.termo).toEqual({ status: "aguardando_aceite", versao: TERMO });
      novoId = corpo.id;

      const a = (
        await p.db.query<{
          email_contato: string;
          treinador_id: string;
          criado_por: string;
          uf: string;
          ws_id: string;
        }>("select email_contato, treinador_id, criado_por, uf, ws_id from atletas where id = $1", [
          novoId,
        ])
      ).rows[0]!;
      expect(a.email_contato).toBe("renata@exemplo.com");
      expect(a.treinador_id).toBe(ana);
      expect(a.uf).toBe("MG");
      expect(a.ws_id).toBe("BRARB51");

      const aud = await p.db.query<{ acao: string; detalhes: Record<string, unknown> }>(
        "select acao, detalhes from auditoria where entidade_id = $1 order by id",
        [novoId],
      );
      expect(aud.rows.map((x) => x.acao)).toEqual(["cadastrar_atleta", "enviar_termo"]);
      expect(JSON.stringify(aud.rows)).not.toContain("exemplo.com");

      const ranking = await gestor("GET", "/ranking");
      expect(ranking.corpo.itens).toHaveLength(14);
      expect(
        ranking.corpo.itens.some(
          (i: { atleta: { velaid: string } }) => i.atleta.velaid === "MG-T15",
        ),
      ).toBe(false);
    });

    it("GET /atletas/pendentes lista só quem espera aceite (rota estática convive com /atletas/:id)", async () => {
      const { status, corpo } = await gestor("GET", "/atletas/pendentes");
      expect(status).toBe(200);
      expect(corpo).toHaveLength(1);
      expect(corpo[0]).toMatchObject({
        id: novoId,
        nome: "Renata Bastos",
        velaid: "MG-T15",
        classe: { id: "ilca7", nome: "ILCA 7" },
      });
      expect(typeof corpo[0].criadoEm).toBe("string");

      const ficha = await gestor("GET", `/atletas/${novoId}`);
      expect(ficha.status).toBe(200);
      expect(ficha.corpo.atleta.termoAceito).toBe(false);
      expect((await gestor("GET", "/atletas/nao-e-uuid")).status).toBe(400);
    });

    it("busca agora marca o código como já no piloto", async () => {
      const { corpo } = await gestor("POST", "/velaid/busca", { codigo: "MG-T15" });
      expect(corpo.jaNoPiloto).toBe(true);
      expect(corpo.elegivel).toBe(false);
    });

    it("POST /atletas/:id/termo registra o aceite, entra no ranking com 0% e não concede IBVAR", async () => {
      const { status, corpo } = await gestor("POST", `/atletas/${novoId}/termo`, { versao: TERMO });
      expect(status).toBe(200);
      expect(corpo).toEqual({ ok: true });

      const ct = await p.db.query<{
        tipo: string;
        concedido: boolean;
        versao_termo: string | null;
        registrado_por: string;
      }>(
        "select tipo, concedido, versao_termo, registrado_por from consentimentos where atleta_id = $1",
        [novoId],
      );
      expect(ct.rows).toHaveLength(1);
      expect(ct.rows[0]).toMatchObject({
        tipo: "termo_piloto",
        concedido: true,
        versao_termo: TERMO,
      });
      expect(
        await contar(
          `auditoria where acao = 'registrar_aceite_termo' and entidade_id = '${novoId}'`,
        ),
      ).toBe(1);

      expect((await gestor("GET", "/atletas/pendentes")).corpo).toEqual([]);

      const ranking = await gestor("GET", "/ranking");
      expect(ranking.corpo.itens).toHaveLength(15);
      const item = ranking.corpo.itens.find(
        (i: { atleta: { velaid: string } }) => i.atleta.velaid === "MG-T15",
      );
      expect(item.score).toBe(0);
      expect(item.completo).toBe(false);

      const ficha = await gestor("GET", `/atletas/${novoId}`);
      const g = Object.fromEntries(
        ficha.corpo.gates.itens.map((x: { gate: number; motivo: string }) => [x.gate, x.motivo]),
      );
      expect(g[1]).toBe("Sem pesagem registrada");
      expect(g[4]).toBe("Financeiro da campanha ainda não informado");

      // IBVAR não vê: o atleta não consentiu em compartilhar.
      const ibvar = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
      expect(
        ibvar.corpo.itens.some((i: { atleta: { velaid: string } }) => i.atleta.velaid === "MG-T15"),
      ).toBe(false);
    });

    it("aceite repetido -> 409; atleta inexistente -> 404; versão errada -> 400", async () => {
      expect((await gestor("POST", `/atletas/${novoId}/termo`, { versao: TERMO })).status).toBe(
        409,
      );
      expect(
        (await gestor("POST", `/atletas/${crypto.randomUUID()}/termo`, { versao: TERMO })).status,
      ).toBe(404);
      expect((await gestor("POST", `/atletas/${novoId}/termo`, { versao: "outra" })).status).toBe(
        400,
      );
    });
  });

  describe("validações de POST /atletas", () => {
    it("menor de 18 -> 400, sem gravar", async () => {
      const marcos = await treinadorId("marcos.pires@scoutvela.dev");
      const antes = await contar("atletas");
      const { status, corpo } = await gestor("POST", "/atletas", {
        velaidCodigo: "PE-T17",
        classeId: "ilca7",
        treinadorId: marcos,
      });
      expect(status).toBe(400);
      expect(corpo.mensagem).toContain("tem 17 anos");
      expect(await contar("atletas")).toBe(antes);
    });

    it("já cadastrado -> 409", async () => {
      const marcos = await treinadorId("marcos.pires@scoutvela.dev");
      const { status, corpo } = await gestor("POST", "/atletas", {
        velaidCodigo: "SC-T01",
        classeId: "ilca7",
        treinadorId: marcos,
      });
      expect(status).toBe(409);
      expect(corpo.mensagem).toBe("O código SC-T01 já está no piloto.");
    });

    it("código inexistente -> 404; malformado -> 400", async () => {
      const marcos = await treinadorId("marcos.pires@scoutvela.dev");
      expect(
        (
          await gestor("POST", "/atletas", {
            velaidCodigo: "ZZ-X99",
            classeId: "ilca7",
            treinadorId: marcos,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await gestor("POST", "/atletas", {
            velaidCodigo: "x",
            classeId: "ilca7",
            treinadorId: marcos,
          })
        ).status,
      ).toBe(400);
    });

    it("classe inexistente ou inativa -> 400", async () => {
      const marcos = await treinadorId("marcos.pires@scoutvela.dev");
      const base = { velaidCodigo: "BA-T16", treinadorId: marcos };
      expect((await gestor("POST", "/atletas", { ...base, classeId: "nao-existe" })).status).toBe(
        400,
      );
      await p.db.query("update classes set ativa = false where id = 'ilca7'");
      const inativa = await gestor("POST", "/atletas", { ...base, classeId: "ilca7" });
      await p.db.query("update classes set ativa = true where id = 'ilca7'");
      expect(inativa.status).toBe(400);
      expect(inativa.corpo.mensagem).toBe("Classe inválida ou inativa.");
    });

    it("treinador inexistente, de outro papel ou inativo -> 400", async () => {
      const base = { velaidCodigo: "BA-T16", classeId: "ilca7" };
      expect(
        (await gestor("POST", "/atletas", { ...base, treinadorId: crypto.randomUUID() })).status,
      ).toBe(400);
      const gestorId = await treinadorId(EMAILS_DEMO.gestor);
      expect((await gestor("POST", "/atletas", { ...base, treinadorId: gestorId })).status).toBe(
        400,
      );
      const marcos = await treinadorId("marcos.pires@scoutvela.dev");
      await p.db.query("update usuarios set ativo = false where id = $1", [marcos]);
      const inativo = await gestor("POST", "/atletas", { ...base, treinadorId: marcos });
      await p.db.query("update usuarios set ativo = true where id = $1", [marcos]);
      expect(inativo.status).toBe(400);
      expect((await gestor("POST", "/atletas", { ...base, treinadorId: "nao-uuid" })).status).toBe(
        400,
      );
      expect(await contar("atletas where velaid_codigo = 'BA-T16'")).toBe(0);
    });
  });

  describe("permissões", () => {
    it("só o gestor usa as rotas de cadastro", async () => {
      const id = await p.idDe("SC-T01");
      const chamadas: [string, "GET" | "POST", string, unknown][] = [
        ["busca", "POST", "/velaid/busca", { codigo: "MG-T15" }],
        ["treinadores", "GET", "/treinadores", undefined],
        [
          "cadastro",
          "POST",
          "/atletas",
          { velaidCodigo: "MG-T15", classeId: "ilca7", treinadorId: crypto.randomUUID() },
        ],
        ["pendentes", "GET", "/atletas/pendentes", undefined],
        ["termo", "POST", `/atletas/${id}/termo`, { versao: TERMO }],
        [
          "importacao",
          "POST",
          "/importacoes",
          { tipo: "velaid", conteudo: "codigo;nome;genero;data_nascimento\n" },
        ],
      ];
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        for (const [nome, method, url, payload] of chamadas) {
          expect((await chamar(email, method, url, payload)).status, `${email} ${nome}`).toBe(403);
        }
      }
    });

    it("sem token -> 401", async () => {
      expect((await p.app.inject({ method: "GET", url: "/atletas/pendentes" })).statusCode).toBe(
        401,
      );
      expect(
        (
          await p.app.inject({
            method: "POST",
            url: "/importacoes",
            payload: { tipo: "velaid", conteudo: "x" },
          })
        ).statusCode,
      ).toBe(401);
    });
  });

  describe("POST /importacoes", () => {
    const importar = (tipo: string, conteudo: string, arquivoNome?: string) =>
      gestor("POST", "/importacoes", { tipo, conteudo, ...(arquivoNome ? { arquivoNome } : {}) });

    it("coluna cpf rejeita o arquivo inteiro sem gravar", async () => {
      const antes = { v: await contar("velaid_registros"), i: await contar("importacoes") };
      const csv =
        "codigo;nome;genero;data_nascimento;CPF\nRS-T20;Maria Souza;F;1999-01-01;123.456.789-00\n";
      const { status, corpo } = await importar("velaid", csv);
      expect(status).toBe(400);
      expect(corpo.mensagem).toContain("cpf");
      expect(corpo.mensagem).not.toContain("123.456");
      expect(await contar("velaid_registros")).toBe(antes.v);
      expect(await contar("importacoes")).toBe(antes.i);
      expect(
        (
          await importar(
            "velaid",
            "codigo,nome,genero,data_nascimento,Endereço\nRS-T20,Maria,F,1999-01-01,Rua X\n",
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await importar(
            "velaid",
            "codigo,nome,genero,data_nascimento,Renda\nRS-T20,Maria,F,1999-01-01,1000\n",
          )
        ).status,
      ).toBe(400);
    });

    it("cabeçalho incompleto, arquivo vazio e tipo inválido -> 400", async () => {
      expect((await importar("velaid", "codigo;nome\nRS-T20;Maria\n")).status).toBe(400);
      expect((await importar("velaid", "codigo;nome;genero;data_nascimento\n")).status).toBe(400);
      expect((await importar("velaid", "   \n")).status).toBe(400);
      expect((await importar("outro", "a;b\n1;2\n")).status).toBe(400);
      expect(
        (
          await importar(
            "velaid",
            'codigo;nome;genero;data_nascimento\nRS-T20;"Maria;F;1999-01-01\n',
          )
        ).status,
      ).toBe(400);
    });

    it("importa VelaID com ';', aspas e CRLF, e a busca passa a achar; linhas ruins viram erro", async () => {
      const csv =
        "﻿Código;Nome;Gênero;Data Nascimento;Clube;Cidade;UF;WS ID;Email\r\n" +
        'RS-T20;"Souza, Maria ""Mari"""; F ;19/03/1999;"Clube; do Sul";Porto Alegre;rs;BRAMS01;maria@exemplo.com\r\n' +
        "rs-t21;João Lima;M;2001-12-31;;;;;\r\n" +
        "XX;Sem Código;F;2000-01-01;;;;;\r\n" +
        "RS-T22;Data Ruim;M;31/02/2000;;;;;\r\n" +
        "\r\n";
      const { status, corpo } = await importar("velaid", csv, "velaid-nov.csv");
      expect(status).toBe(201);
      expect(corpo.linhasOk).toBe(2);
      expect(corpo.linhasErro).toBe(2);
      expect(corpo.erros.map((e: { linha: number }) => e.linha)).toEqual([4, 5]);
      expect(JSON.stringify(corpo.erros)).not.toMatch(/Sem Código|Data Ruim|RS-T22/);

      const busca = await gestor("POST", "/velaid/busca", { codigo: "RS-T20" });
      expect(busca.status).toBe(200);
      expect(busca.corpo).toMatchObject({
        nome: 'Souza, Maria "Mari"',
        genero: "F",
        dataNascimento: "1999-03-19",
        clube: "Clube; do Sul",
        uf: "RS",
        wsId: "BRAMS01",
        elegivel: true,
      });
      const joao = await gestor("POST", "/velaid/busca", { codigo: "RS-T21" });
      expect(joao.corpo).toMatchObject({ nome: "João Lima", clube: null, uf: null });

      const reg = (
        await p.db.query<{ fonte: string; email: string }>(
          "select fonte, email from velaid_registros where codigo = 'RS-T20'",
        )
      ).rows[0]!;
      expect(reg).toEqual({ fonte: "csv", email: "maria@exemplo.com" });

      const imp = (
        await p.db.query<{
          tipo: string;
          arquivo_nome: string;
          linhas_ok: number;
          linhas_erro: number;
          erros: unknown[];
        }>(
          "select tipo, arquivo_nome, linhas_ok, linhas_erro, erros from importacoes where id = $1",
          [corpo.id],
        )
      ).rows[0]!;
      expect(imp).toMatchObject({
        tipo: "velaid",
        arquivo_nome: "velaid-nov.csv",
        linhas_ok: 2,
        linhas_erro: 2,
      });
      expect(imp.erros).toHaveLength(2);
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'importar_csv' and entidade_id = $1",
        [String(corpo.id)],
      );
      expect(aud.rows[0]!.detalhes).toEqual({ tipo: "velaid", linhasOk: 2, linhasErro: 2 });
    });

    it("importa VelaID com ',' e faz upsert por código", async () => {
      const csv = "codigo,nome,genero,data_nascimento\nRS-T20,Maria Souza Lima,F,1999-03-19\n";
      const { status, corpo } = await importar("velaid", csv);
      expect(status).toBe(201);
      expect(corpo.linhasOk).toBe(1);
      expect((await gestor("POST", "/velaid/busca", { codigo: "RS-T20" })).corpo.nome).toBe(
        "Maria Souza Lima",
      );
      expect(await contar("velaid_registros where codigo = 'RS-T20'")).toBe(1);
    });

    it("ranking CBVela soma pontos na ficha; duplicado e atleta fora do piloto viram erro", async () => {
      const id = await p.idDe("SC-T01");
      const antes = (await gestor("GET", `/atletas/${id}`)).corpo;
      const csv =
        "velaid;nivel;evento;data;posicao;tamanho_frota;pontos\n" +
        "SC-T01;estadual;Estadual Importado;20/10/2026;2;30;12,5\n" +
        "SC-T01;Regional;Regional Importado;2026-10-25;4;20;7\n" +
        "SC-T01;estadual;Estadual Importado;2026-10-20;2;30;12,5\n" +
        "ZZ-X99;estadual;Outro Evento;2026-10-20;1;10;10\n" +
        "SC-T01;mundial;Mundial Indevido;2026-10-20;1;10;10\n" +
        "SC-T01;estadual;Posição Alta;2026-10-21;11;10;3\n";
      const { status, corpo } = await importar("ranking_cbvela", csv);
      expect(status).toBe(201);
      expect(corpo.linhasOk).toBe(2);
      expect(corpo.linhasErro).toBe(4);
      expect(corpo.erros.map((e: { linha: number; mensagem: string }) => e.linha)).toEqual([
        4, 5, 6, 7,
      ]);
      expect(corpo.erros[0].mensagem).toBe("Resultado já importado (mesmo atleta, evento e data).");

      const depois = (await gestor("GET", `/atletas/${id}`)).corpo;
      expect(depois.pontosCbvela).toBeCloseTo(antes.pontosCbvela + 19.5, 2);
      expect(depois.resultados).toHaveLength(antes.resultados.length + 2);
      const novo = depois.resultados.find(
        (r: { evento: string }) => r.evento === "Estadual Importado",
      );
      expect(novo).toMatchObject({
        nivel: "estadual",
        posicao: 2,
        tamanhoFrota: 30,
        internacional: false,
        pontosCbvela: 12.5,
        fonte: "ranking_cbvela",
        linkOficial: null,
      });

      // Reenviar o mesmo arquivo: tudo é duplicado.
      const de_novo = await importar(
        "ranking_cbvela",
        csv.split("\n").slice(0, 3).join("\n") + "\n",
      );
      expect(de_novo.corpo.linhasOk).toBe(0);
      expect(de_novo.corpo.linhasErro).toBe(2);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAdminAuthFalso, tokenPara } from "../apoio/app.js";
import { jpegValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-25T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const BIO = "Velejadora de Ilhabela, campeã de base e focada no ciclo olímpico de 2032.";
const TITULO = "Campeã paulista de ILCA 6 sub-21";
const V2 = "Piloto 18+ · v2 (foto e bio)";
const V3 = "Piloto 18+ · v3 (sem foto e bio)";
const TEXTO_TERMO =
  "Nova versão do termo do piloto. Cita foto e bio entre o que vai ao IBVAR, com consentimento.";

interface ConquistaFicha {
  tipo: "resultado" | "manual";
  titulo: string;
  ano: number;
  evento?: string;
  nivel?: string;
  posicao?: number;
}

describe("D14: mini bio, conquistas e o acesso do IBVAR à foto e à bio", () => {
  let p: Piloto;
  let helena: string; // SP-T07: conta de atleta, da treinadora Ana
  let marcosAtleta: string; // RS-T02: de outro treinador
  let authMarcos: { authorization: string };

  beforeAll(async () => {
    p = await criarPiloto(() => agora, { adminAuth: criarAdminAuthFalso() });
    [helena, marcosAtleta] = await Promise.all([p.idDe("SP-T07"), p.idDe("RS-T02")]);
    const marcosId = (
      await p.db.query<{ treinador_id: string }>("select treinador_id from atletas where id = $1", [
        marcosAtleta,
      ])
    ).rows[0]!.treinador_id;
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authUserId, marcosId]);
    authMarcos = cabecalhoAuth(await tokenPara(authUserId));
  });
  afterAll(() => p.encerrar());

  type Quem = string | { authorization: string } | null;
  const chamar = async (
    quem: Quem,
    metodo: "GET" | "POST" | "PUT" | "DELETE",
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
    return { status: r.statusCode, corpo: r.body ? r.json() : null, texto: r.body };
  };
  const ficha = (quem: Quem, id = helena) => chamar(quem, "GET", `/atletas/${id}`);
  const anexar = async (
    atleta = helena,
    quem: Quem = EMAILS_DEMO.atleta,
    categoria: "evidencia" | "sumula" | "balanca" = "evidencia",
  ) => {
    const r = await chamar(quem, "POST", `/atletas/${atleta}/evidencias`, {
      nomeArquivo: "prova.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
      categoria,
    });
    expect(r.status).toBe(201);
    return r.corpo.id as string;
  };
  const registrar = async (corpo: Record<string, unknown> = {}, quem: Quem = EMAILS_DEMO.atleta) =>
    chamar(quem, "POST", "/me/conquistas", {
      titulo: TITULO,
      ano: 2025,
      anexoId: await anexar(),
      ...corpo,
    });
  const decidir = (quem: Quem, id: string, corpo: unknown) =>
    chamar(quem, "PUT", `/conquistas/${id}/validacao`, corpo);
  const avisosDe = async (quem: Quem) =>
    (await chamar(quem, "GET", "/me/avisos")).corpo.itens as {
      tipo: string;
      referencia: Record<string, unknown>;
    }[];
  const conquistasDaFicha = async (quem: Quem) =>
    (await ficha(quem)).corpo.conquistas as ConquistaFicha[];

  describe("bio", () => {
    it("o atleta edita no PUT /me/perfil; volta no GET /me/perfil; vazio e null apagam", async () => {
      expect((await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil")).corpo.atleta.bio).toBeNull();
      const r = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: `  ${BIO}  ` });
      expect(r.status).toBe(200);
      expect(r.corpo.atleta.bio).toBe(BIO);
      expect((await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil")).corpo.atleta.bio).toBe(BIO);

      expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: "   " })).status).toBe(
        200,
      );
      expect((await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil")).corpo.atleta.bio).toBeNull();
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: BIO });
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: null });
      expect((await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil")).corpo.atleta.bio).toBeNull();
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: BIO });
    });

    it("validações por campo: mais de 500 caracteres e caractere de controle", async () => {
      const longa = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: "x".repeat(501) });
      expect(longa.status).toBe(400);
      expect(JSON.stringify(longa.corpo)).toContain("bio");
      const limite = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", {
        bio: "x".repeat(500),
      });
      expect(limite.status).toBe(200);
      const controle = await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: "oi\u0000x" });
      expect(controle.status).toBe(400);
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: BIO });
    });

    it("só o atleta edita a bio; a auditoria guarda o nome do campo e não o texto", async () => {
      for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora]) {
        expect((await chamar(email, "PUT", "/me/perfil", { bio: BIO })).status, email).toBe(400);
      }
      expect((await chamar(EMAILS_DEMO.ibvar, "PUT", "/me/perfil", { bio: BIO })).status).toBe(403);
      expect((await chamar(null, "PUT", "/me/perfil", { bio: BIO })).status).toBe(401);
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'editar_perfil' order by id desc limit 1",
      );
      expect(aud.rows[0]!.detalhes).toEqual({ campos: ["bio"] });
      const todas = await p.db.query("select detalhes::text as t from auditoria");
      expect(JSON.stringify(todas.rows)).not.toContain("ciclo olímpico de 2032");
    });

    it("a ficha traz a bio para gestor, treinador do atleta e o próprio atleta; outro treinador 404", async () => {
      for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
        const r = await ficha(quem);
        expect(r.status).toBe(200);
        expect(r.corpo.atleta.bio).toBe(BIO);
      }
      expect((await ficha(authMarcos)).status).toBe(404);
      expect((await ficha(null)).status).toBe(401);
    });
  });

  describe("conquistas manuais", () => {
    let conquistaValida: string;
    let conquistaRecusada: string;

    it("acesso ao POST /me/conquistas: só o atleta", async () => {
      const corpo = { titulo: TITULO, ano: 2025, anexoId: crypto.randomUUID() };
      expect((await chamar(null, "POST", "/me/conquistas", corpo)).status).toBe(401);
      for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
        expect((await chamar(quem, "POST", "/me/conquistas", corpo)).status, String(quem)).toBe(
          403,
        );
      }
    });

    it("validações: título, ano, anexo obrigatório, categoria certa e anexo de outro atleta", async () => {
      const anexoOk = await anexar();
      const invalido = async (corpo: Record<string, unknown>, campo: string) => {
        const r = await chamar(EMAILS_DEMO.atleta, "POST", "/me/conquistas", {
          titulo: TITULO,
          ano: 2025,
          anexoId: anexoOk,
          ...corpo,
        });
        expect(r.status, campo).toBe(400);
        expect(JSON.stringify(r.corpo), campo).toContain(campo);
      };
      await invalido({ titulo: "A" }, "titulo");
      await invalido({ titulo: "x".repeat(121) }, "titulo");
      await invalido({ ano: 1949 }, "ano");
      await invalido({ ano: 2027 }, "ano");
      await invalido({ anexoId: undefined }, "anexoId");
      await invalido({ anexoId: crypto.randomUUID() }, "anexoId");
      await invalido({ anexoId: await anexar(helena, EMAILS_DEMO.atleta, "sumula") }, "anexoId");
      await invalido({ anexoId: await anexar(helena, EMAILS_DEMO.atleta, "balanca") }, "anexoId");
      const doOutro = await anexar(marcosAtleta, EMAILS_DEMO.gestor);
      await invalido({ anexoId: doOutro }, "anexoId");
      const removido = await anexar();
      expect((await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${removido}`)).status).toBe(
        204,
      );
      await invalido({ anexoId: removido }, "anexoId");
      expect(
        (
          await chamar(EMAILS_DEMO.atleta, "POST", "/me/conquistas", {
            titulo: TITULO,
            ano: 2025,
            anexoId: anexoOk,
            extra: 1,
          })
        ).status,
      ).toBe(400);
      const nada = await p.db.query("select 1 from conquistas_atleta");
      expect(nada.rows).toHaveLength(0);
    });

    it("cria pendente, avisa o treinador e audita sem o título; o anexo não sai mais", async () => {
      const anexo = await anexar();
      const r = await chamar(EMAILS_DEMO.atleta, "POST", "/me/conquistas", {
        titulo: `  ${TITULO}  `,
        ano: 2025,
        anexoId: anexo,
      });
      expect(r.status).toBe(201);
      expect(r.corpo).toMatchObject({
        titulo: TITULO,
        ano: 2025,
        status: "pendente",
        motivo: null,
        anexoId: anexo,
        decididoPor: null,
        decididoEm: null,
      });
      conquistaValida = r.corpo.id;

      const aviso = (await avisosDe(EMAILS_DEMO.treinadora)).find(
        (a) => a.tipo === "atleta_registrou_conquista",
      );
      expect(aviso?.referencia).toEqual({ conquistaId: conquistaValida });
      expect(
        (await avisosDe(EMAILS_DEMO.gestor)).some((a) => a.tipo === "atleta_registrou_conquista"),
      ).toBe(false);

      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'registrar_conquista'",
      );
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0]!.detalhes).toEqual({
        conquistaId: conquistaValida,
        anexoId: anexo,
        campos: ["titulo", "ano", "anexoId"],
      });
      expect(JSON.stringify(aud.rows)).not.toContain("paulista");

      // O anexo ligado à conquista não pode ser removido, nem reaproveitado em outra conquista.
      const remover = await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${anexo}`);
      expect(remover.status).toBe(409);
      expect(remover.corpo.mensagem ?? JSON.stringify(remover.corpo)).toContain("conquista");
      const outra = await chamar(EMAILS_DEMO.atleta, "POST", "/me/conquistas", {
        titulo: "Outra conquista",
        ano: 2024,
        anexoId: anexo,
      });
      expect(outra.status).toBe(400);
      expect(JSON.stringify(outra.corpo)).toContain("anexoId");
      const gestorRemove = await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${anexo}`);
      expect(gestorRemove.status).toBe(409);
    });

    it("pendente não aparece na ficha; GET /atletas/:id/conquistas por papel", async () => {
      expect(await conquistasDaFicha(EMAILS_DEMO.gestor)).toEqual([]);
      for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
        const r = await chamar(quem, "GET", `/atletas/${helena}/conquistas`);
        expect(r.status, String(quem)).toBe(200);
        expect(r.corpo.automaticas).toEqual([]);
        expect(r.corpo.manuais).toHaveLength(1);
        expect(r.corpo.manuais[0]).toMatchObject({ id: conquistaValida, status: "pendente" });
      }
      expect((await chamar(null, "GET", `/atletas/${helena}/conquistas`)).status).toBe(401);
      expect((await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${helena}/conquistas`)).status).toBe(
        403,
      );
      expect((await chamar(authMarcos, "GET", `/atletas/${helena}/conquistas`)).status).toBe(404);
    });

    it("decisão: atleta e IBVAR 403, outro treinador 404, sem token 401; recusa exige motivo", async () => {
      const corpo = { decisao: "validar" };
      expect((await decidir(null, conquistaValida, corpo)).status).toBe(401);
      expect((await decidir(EMAILS_DEMO.atleta, conquistaValida, corpo)).status).toBe(403);
      expect((await decidir(EMAILS_DEMO.ibvar, conquistaValida, corpo)).status).toBe(403);
      expect((await decidir(authMarcos, conquistaValida, corpo)).status).toBe(404);
      expect((await decidir(EMAILS_DEMO.gestor, crypto.randomUUID(), corpo)).status).toBe(404);
      expect((await decidir(EMAILS_DEMO.gestor, "nao-e-uuid", corpo)).status).toBe(400);
      const semMotivo = await decidir(EMAILS_DEMO.treinadora, conquistaValida, {
        decisao: "recusar",
      });
      expect(semMotivo.status).toBe(400);
      expect(JSON.stringify(semMotivo.corpo)).toContain("motivo");
      expect(
        (await decidir(EMAILS_DEMO.treinadora, conquistaValida, { decisao: "talvez" })).status,
      ).toBe(400);
      const pendente = await p.db.query(
        "select 1 from conquistas_atleta where status <> 'pendente'",
      );
      expect(pendente.rows).toHaveLength(0);
    });

    it("o treinador valida; avisa o atleta, audita sem título e a decisão é definitiva", async () => {
      const r = await decidir(EMAILS_DEMO.treinadora, conquistaValida, { decisao: "validar" });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ status: "validada", motivo: null });
      expect(r.corpo.decididoPor).toMatchObject({ nome: expect.any(String) });
      expect(r.corpo.decididoEm).toBe(agora.toISOString());

      const aviso = (await avisosDe(EMAILS_DEMO.atleta)).find(
        (a) => a.tipo === "conquista_validada",
      );
      expect(aviso?.referencia).toEqual({ conquistaId: conquistaValida });
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'decidir_conquista'",
      );
      expect(aud.rows[0]!.detalhes).toEqual({
        conquistaId: conquistaValida,
        decisao: "validar",
        comMotivo: false,
      });
      expect(
        (
          await decidir(EMAILS_DEMO.gestor, conquistaValida, {
            decisao: "recusar",
            motivo: "Tarde demais",
          })
        ).status,
      ).toBe(409);
      expect(
        (await decidir(EMAILS_DEMO.treinadora, conquistaValida, { decisao: "validar" })).status,
      ).toBe(409);
    });

    it("o gestor recusa com motivo; a recusada fica fora da ficha e o atleta vê o motivo", async () => {
      const nova = await registrar({ titulo: "Medalha de bronze", ano: 2023 });
      expect(nova.status).toBe(201);
      conquistaRecusada = nova.corpo.id;
      const r = await decidir(EMAILS_DEMO.gestor, conquistaRecusada, {
        decisao: "recusar",
        motivo: "O documento não cita o seu nome.",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({
        status: "recusada",
        motivo: "O documento não cita o seu nome.",
      });
      expect(
        (await avisosDe(EMAILS_DEMO.atleta)).some((a) => a.tipo === "conquista_recusada"),
      ).toBe(true);
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'decidir_conquista' order by id desc limit 1",
      );
      expect(aud.rows[0]!.detalhes).toEqual({
        conquistaId: conquistaRecusada,
        decisao: "recusar",
        comMotivo: true,
      });
      expect(JSON.stringify(aud.rows)).not.toContain("documento");

      const propria = await chamar(EMAILS_DEMO.atleta, "GET", `/atletas/${helena}/conquistas`);
      expect(propria.corpo.manuais.map((c: { status: string }) => c.status).sort()).toEqual([
        "recusada",
        "validada",
      ]);
      // Só a validada chega à ficha.
      const fichaConquistas = await conquistasDaFicha(EMAILS_DEMO.treinadora);
      expect(fichaConquistas).toEqual([{ tipo: "manual", titulo: TITULO, ano: 2025 }]);
    });

    it("a tabela só aceita a decisão da pendente: título e decisão não mudam depois", async () => {
      await expect(
        p.db.query("update conquistas_atleta set titulo = 'Outro título' where id = $1", [
          conquistaValida,
        ]),
      ).rejects.toThrow(/Conquista/);
      await expect(
        p.db.query("update conquistas_atleta set status = 'recusada', motivo = 'x' where id = $1", [
          conquistaValida,
        ]),
      ).rejects.toThrow(/Conquista/);
      await expect(
        p.db.query("delete from conquistas_atleta where id = $1", [conquistaValida]),
      ).rejects.toThrow(/Conquista/);
    });
  });

  describe("conquistas automáticas (pódios dos resultados validados)", () => {
    const resultadoDoGestor = (posicao: number, evento: string, nivel = "mundial") =>
      chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${helena}/resultados`, {
        nivel,
        evento,
        data: "2026-08-10",
        posicao,
        tamanhoFrota: 80,
        linkOficial: "https://resultados.exemplo.invalid/evento",
      });

    it("só pódio (1 a 3) validado entra, com evento, nível, posição e edição", async () => {
      expect((await resultadoDoGestor(2, "Mundial de ILCA 6")).status).toBe(201);
      expect((await resultadoDoGestor(8, "Sul-Americano de ILCA 6", "sul_americano")).status).toBe(
        201,
      );
      const lista = await conquistasDaFicha(EMAILS_DEMO.gestor);
      expect(lista).toEqual([
        {
          tipo: "resultado",
          titulo: "2º lugar em Mundial de ILCA 6",
          ano: 2026,
          evento: "Mundial de ILCA 6",
          nivel: "mundial",
          posicao: 2,
        },
        { tipo: "manual", titulo: TITULO, ano: 2025 },
      ]);
      const r = await chamar(EMAILS_DEMO.treinadora, "GET", `/atletas/${helena}/conquistas`);
      expect(r.corpo.automaticas).toHaveLength(1);
    });

    it("resultado do atleta pendente não conta; validado, conta", async () => {
      const novo = await chamar(EMAILS_DEMO.atleta, "POST", "/me/resultados", {
        evento: "Brasileiro de ILCA 6",
        nivel: "nacional",
        ano: 2026,
        posicao: 1,
        linkOficial: "https://resultados.exemplo.invalid/brasileiro",
      });
      expect(novo.status).toBe(201);
      expect(await conquistasDaFicha(EMAILS_DEMO.atleta)).toHaveLength(2);
      const decisao = await chamar(
        EMAILS_DEMO.treinadora,
        "PUT",
        `/resultados/${novo.corpo.id}/validacao`,
        {
          decisao: "validar",
        },
      );
      expect(decisao.status).toBe(200);
      const lista = await conquistasDaFicha(EMAILS_DEMO.atleta);
      expect(lista.map((c) => c.titulo)).toEqual([
        "1º lugar em Brasileiro de ILCA 6",
        "2º lugar em Mundial de ILCA 6",
        TITULO,
      ]);
      expect(lista[0]).toMatchObject({ tipo: "resultado", nivel: "brasileiro", posicao: 1 });
    });

    it("resultado recusado não conta", async () => {
      const novo = await chamar(EMAILS_DEMO.atleta, "POST", "/me/resultados", {
        evento: "Copa Brasil de ILCA 6",
        nivel: "nacional",
        ano: 2026,
        posicao: 3,
        linkOficial: "https://resultados.exemplo.invalid/copa",
      });
      await chamar(EMAILS_DEMO.gestor, "PUT", `/resultados/${novo.corpo.id}/validacao`, {
        decisao: "recusar",
        motivo: "Link não confere.",
      });
      expect((await conquistasDaFicha(EMAILS_DEMO.atleta)).map((c) => c.titulo)).not.toContain(
        "3º lugar em Copa Brasil de ILCA 6",
      );
    });
  });

  describe("IBVAR: foto, bio e conquistas dependem do consentimento e do termo", () => {
    const itemDoRanking = async (quem: Quem) => {
      const r = await chamar(quem, "GET", "/ranking");
      return (r.corpo.itens as { atleta: { id: string; fotoUrl: string | null } }[]).find(
        (i) => i.atleta.id === helena,
      );
    };

    it("sem consentimento com o IBVAR a ficha não existe para ele", async () => {
      expect((await ficha(EMAILS_DEMO.ibvar)).status).toBe(404);
      expect(await itemDoRanking(EMAILS_DEMO.ibvar)).toBeUndefined();
    });

    it("com o consentimento e o termo antigo: sem foto e sem bio; pódios sim, conquista manual não", async () => {
      const foto = await chamar(EMAILS_DEMO.atleta, "POST", "/me/foto", {
        tipoMime: "image/jpeg",
        conteudoBase64: jpegValido().toString("base64"),
      });
      expect(foto.status).toBe(200);
      expect(
        (await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: true }))
          .status,
      ).toBe(200);

      const r = await ficha(EMAILS_DEMO.ibvar);
      expect(r.status).toBe(200);
      expect(r.corpo.atleta.fotoUrl).toBeNull();
      expect(r.corpo.atleta.bio).toBeNull();
      expect(r.texto).not.toContain("ciclo olímpico de 2032");
      expect(r.texto).not.toContain("storage.teste");
      const conquistas = r.corpo.conquistas as ConquistaFicha[];
      expect(conquistas.every((c) => c.tipo === "resultado")).toBe(true);
      expect(conquistas.length).toBeGreaterThan(0);
      expect(r.texto).not.toContain(TITULO);
      expect((await itemDoRanking(EMAILS_DEMO.ibvar))?.atleta.fotoUrl).toBeNull();

      // Gestor, treinador e o próprio atleta veem sempre.
      for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
        const f = await ficha(quem);
        expect(f.corpo.atleta.bio, String(quem)).toBe(BIO);
        expect(f.corpo.atleta.fotoUrl, String(quem)).toContain("storage.teste");
      }
      expect((await itemDoRanking(EMAILS_DEMO.gestor))?.atleta.fotoUrl).toContain("storage.teste");
    });

    it("GET /termos e POST /termos expõem incluiFotoBio; a auditoria guarda só o booleano", async () => {
      const g = EMAILS_DEMO.gestor;
      const padrao = await chamar(g, "POST", "/termos", {
        versao: "Padrão sem marca",
        titulo: "Versão sem a marca",
        texto: TEXTO_TERMO,
        vigenteDesde: "2026-11-27T00:00:00-03:00",
      });
      expect(padrao.status).toBe(201);
      expect(padrao.corpo.incluiFotoBio).toBe(false);
      const v2 = await chamar(g, "POST", "/termos", {
        versao: V2,
        titulo: "Termo com foto e bio",
        texto: TEXTO_TERMO,
        incluiFotoBio: true,
        vigenteDesde: "2026-12-01T00:00:00-03:00",
      });
      expect(v2.status).toBe(201);
      expect(v2.corpo.incluiFotoBio).toBe(true);
      const lista = await chamar(g, "GET", "/termos");
      expect(
        lista.corpo.map((t: { versao: string; incluiFotoBio: boolean }) => [
          t.versao,
          t.incluiFotoBio,
        ]),
      ).toEqual([
        [V2, true],
        ["Padrão sem marca", false],
        ["Piloto 18+ · v1", false],
      ]);
      expect(
        (
          await chamar(g, "POST", "/termos", {
            versao: "x",
            titulo: "Título",
            texto: TEXTO_TERMO,
            incluiFotoBio: "sim",
            vigenteDesde: "2026-12-05T00:00:00-03:00",
          })
        ).status,
      ).toBe(400);
      for (const quem of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        expect(
          (
            await chamar(quem, "POST", "/termos", {
              versao: "y",
              titulo: "Título",
              texto: TEXTO_TERMO,
              incluiFotoBio: true,
              vigenteDesde: "2026-12-05T00:00:00-03:00",
            })
          ).status,
        ).toBe(403);
      }
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'publicar_termo' order by id desc limit 1",
      );
      expect(aud.rows[0]!.detalhes).toMatchObject({ versao: V2, incluiFotoBio: true });
      expect(JSON.stringify(aud.rows)).not.toContain("Cita foto");
    });

    it("o atleta lê no termo proposto se ele inclui foto e bio", async () => {
      // A v2 é a próxima publicada? Antes dela há a versão "Padrão sem marca" (27/11), a mais próxima.
      const proxima = await chamar(EMAILS_DEMO.atleta, "GET", "/termo/proxima");
      expect(proxima.status).toBe(200);
      expect(proxima.corpo.incluiFotoBio).toBe(false);
      const vigente = await chamar(EMAILS_DEMO.atleta, "GET", "/termo");
      expect(vigente.corpo.incluiFotoBio).toBe(false);
    });

    it("aceitar a versão que inclui foto e bio libera a foto e a bio só quando ela passa a valer", async () => {
      // O aceite de uma versão mais nova vale também para as anteriores (aceite antecipado).
      const aceite = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 });
      expect(aceite.status).toBe(400); // V2 ainda não é a próxima: a próxima é a de 27/11

      agora = new Date("2026-11-28T12:00:00-03:00"); // a versão sem a marca vira a vigente
      const antecipado = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 });
      expect(antecipado.status).toBe(200);
      // V2 ainda não começou a valer (01/12): o IBVAR segue sem foto e sem bio.
      const antes = await ficha(EMAILS_DEMO.ibvar);
      expect(antes.corpo.atleta.fotoUrl).toBeNull();
      expect(antes.corpo.atleta.bio).toBeNull();

      agora = new Date("2026-12-02T12:00:00-03:00");
      const depois = await ficha(EMAILS_DEMO.ibvar);
      expect(depois.status).toBe(200);
      expect(depois.corpo.atleta.fotoUrl).toContain("storage.teste");
      expect(depois.corpo.atleta.bio).toBe(BIO);
      expect((depois.corpo.conquistas as ConquistaFicha[]).map((c) => c.tipo)).toContain("manual");
      expect(JSON.stringify(depois.corpo.conquistas)).toContain(TITULO);
      expect((await itemDoRanking(EMAILS_DEMO.ibvar))?.atleta.fotoUrl).toContain("storage.teste");
      // A recusada e a pendente nunca vão para o IBVAR.
      expect(depois.texto).not.toContain("Medalha de bronze");
    });

    it("a bio do IBVAR acompanha o que o atleta escreve e o aceite mais recente manda", async () => {
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: "Bio nova para o investidor." });
      expect((await ficha(EMAILS_DEMO.ibvar)).corpo.atleta.bio).toBe("Bio nova para o investidor.");
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: null });
      expect((await ficha(EMAILS_DEMO.ibvar)).corpo.atleta.bio).toBeNull();
      await chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", { bio: BIO });

      // Nova versão sem a marca, aceita depois: o aceite mais recente não inclui foto e bio.
      const v3 = await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
        versao: V3,
        titulo: "Termo sem foto e bio",
        texto: TEXTO_TERMO,
        vigenteDesde: "2026-12-10T00:00:00-03:00",
      });
      expect(v3.status).toBe(201);
      expect(
        (await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V3 })).status,
      ).toBe(200);
      agora = new Date("2026-12-11T12:00:00-03:00");
      const r = await ficha(EMAILS_DEMO.ibvar);
      expect(r.corpo.atleta.fotoUrl).toBeNull();
      expect(r.corpo.atleta.bio).toBeNull();
      expect(JSON.stringify(r.corpo.conquistas)).not.toContain(TITULO);
      expect((await itemDoRanking(EMAILS_DEMO.ibvar))?.atleta.fotoUrl).toBeNull();
    });

    it("retirar o consentimento tira a ficha do IBVAR", async () => {
      await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: false });
      expect((await ficha(EMAILS_DEMO.ibvar)).status).toBe(404);
      expect(await itemDoRanking(EMAILS_DEMO.ibvar)).toBeUndefined();
    });
  });

  describe("exportação LGPD (GET /meus-dados)", () => {
    it("traz a bio e as conquistas manuais, de qualquer situação, sem o anexo", async () => {
      const r = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
      expect(r.status).toBe(200);
      expect(r.corpo.atleta.bio).toBe(BIO);
      const titulos = (r.corpo.conquistas as { titulo: string; status: string }[])
        .map((c) => `${c.titulo}:${c.status}`)
        .sort();
      expect(titulos).toEqual(["Medalha de bronze:recusada", `${TITULO}:validada`].sort());
      expect(r.corpo.conquistas[0]).toHaveProperty("criadoEm");
    });
  });
});

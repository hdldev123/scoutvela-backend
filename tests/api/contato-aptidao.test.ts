import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const T0 = new Date("2026-11-06T12:00:00-03:00");
let agora = T0;

describe("telefone, validade do passaporte e aptidão conferida (D15)", () => {
  let p: Piloto;
  let helenaId: string; // atleta da treinadora, sem consentimento do IBVAR
  let consentidoId: string; // SC-T01: IBVAR enxerga
  let gestorId: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    helenaId = await p.idDe("SP-T07");
    consentidoId = await p.idDe("SC-T01");
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
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
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };
  const editar = (corpo: Record<string, unknown>) =>
    chamar(EMAILS_DEMO.atleta, "PUT", "/me/perfil", corpo);
  const aptidoes = async (atleta: string) =>
    (await p.db.query("select * from aptidoes where atleta_id = $1", [atleta])).rows;
  const leiturasAuditadas = async (atleta: string) =>
    Number(
      (
        await p.db.query<{ n: string }>(
          "select count(*)::text as n from auditoria where acao = 'ler_aptidao' and entidade_id = $1",
          [atleta],
        )
      ).rows[0]!.n,
    );

  describe("PUT /me/perfil (atleta)", () => {
    it("grava telefone normalizado e passaporte no último dia do mês; GET devolve AAAA-MM", async () => {
      const r = await editar({ telefone: "(11) 99999-8888", passaporteValidoAte: "2028-02" });
      expect(r.status).toBe(200);
      expect(r.corpo.atleta).toMatchObject({
        telefone: "+5511999998888",
        passaporteValidoAte: "2028-02",
        aptidao: null,
      });
      const l = await p.db.query<{ telefone: string; d: string }>(
        "select telefone, passaporte_valido_ate::text as d from atletas where id = $1",
        [helenaId],
      );
      expect(l.rows[0]).toEqual({ telefone: "+5511999998888", d: "2028-02-29" });
      const g = await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil");
      expect(g.corpo.atleta).toMatchObject({
        telefone: "+5511999998888",
        passaporteValidoAte: "2028-02",
      });
    });

    it("telefone internacional com + é mantido; passaporte vencido é aceito", async () => {
      const r = await editar({ telefone: "+351 912 345 678", passaporteValidoAte: "2020-01" });
      expect(r.status).toBe(200);
      expect(r.corpo.atleta).toMatchObject({
        telefone: "+351912345678",
        passaporteValidoAte: "2020-01",
      });
    });

    it("cada campo é independente: enviar só um não mexe no outro", async () => {
      await editar({ telefone: "11999998888", passaporteValidoAte: "2030-05" });
      const r = await editar({ telefone: "21 3333-4444" });
      expect(r.corpo.atleta).toMatchObject({
        telefone: "+552133334444",
        passaporteValidoAte: "2030-05",
      });
    });

    it("telefone inválido: 400 por campo", async () => {
      for (const telefone of ["abc", "123", "", "+0 123 456 789", "99999-8888"]) {
        const r = await editar({ telefone });
        expect(r.status, telefone).toBe(400);
        expect(r.corpo.campos).toEqual([
          { campo: "telefone", mensagem: expect.stringContaining("telefone") },
        ]);
      }
    });

    it("mês do passaporte inválido: 400 por campo", async () => {
      for (const passaporteValidoAte of [
        "2028-13",
        "2028-00",
        "2028-1",
        "2028-02-28",
        "28-02",
        "",
      ]) {
        const r = await editar({ passaporteValidoAte });
        expect(r.status, passaporteValidoAte).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("passaporteValidoAte");
      }
      const dois = await editar({ telefone: "x", passaporteValidoAte: "2028-13" });
      expect(dois.corpo.campos.map((c: { campo: string }) => c.campo).sort()).toEqual([
        "passaporteValidoAte",
        "telefone",
      ]);
    });

    it("null apaga os dois; nada é gravado quando um campo é inválido", async () => {
      await editar({ telefone: "11999998888", passaporteValidoAte: "2030-05" });
      expect((await editar({ telefone: "x", passaporteValidoAte: "2031-01" })).status).toBe(400);
      const antes = await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil");
      expect(antes.corpo.atleta.passaporteValidoAte).toBe("2030-05");

      const r = await editar({ telefone: null, passaporteValidoAte: null });
      expect(r.status).toBe(200);
      expect(r.corpo.atleta).toMatchObject({ telefone: null, passaporteValidoAte: null });
    });

    it("treinador e gestor não editam esses campos; sem token 401; IBVAR 403", async () => {
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.gestor]) {
        const r = await chamar(email, "PUT", "/me/perfil", { telefone: "11999998888" });
        expect(r.status, email).toBe(400);
      }
      expect((await chamar(null, "PUT", "/me/perfil", { telefone: "11999998888" })).status).toBe(
        401,
      );
      expect(
        (await chamar(EMAILS_DEMO.ibvar, "PUT", "/me/perfil", { telefone: "11999998888" })).status,
      ).toBe(403);
    });

    it("a auditoria guarda só os nomes dos campos", async () => {
      await editar({ telefone: "11977776666", passaporteValidoAte: "2033-09" });
      const a = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'editar_perfil' order by id desc limit 1",
      );
      expect(a.rows[0]!.detalhes).toEqual({ campos: ["telefone", "passaporteValidoAte"] });
      const tudo = JSON.stringify((await p.db.query("select detalhes from auditoria")).rows);
      expect(tudo).not.toContain("977776666");
      expect(tudo).not.toContain("2033");
    });

    it("o banco recusa telefone fora do E.164 e passaporte que não é fim de mês", async () => {
      await expect(
        p.db.query("update atletas set telefone = '11999998888' where id = $1", [helenaId]),
      ).rejects.toThrow();
      await expect(
        p.db.query("update atletas set passaporte_valido_ate = '2028-02-15' where id = $1", [
          helenaId,
        ]),
      ).rejects.toThrow();
    });
  });

  describe("POST /atletas/:id/aptidao", () => {
    it("só o gestor registra; outros papéis 403; sem token 401", async () => {
      const url = `/atletas/${helenaId}/aptidao`;
      expect((await chamar(null, "POST", url, { apto: true })).status).toBe(401);
      for (const email of [EMAILS_DEMO.atleta, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
        expect((await chamar(email, "POST", url, { apto: true })).status, email).toBe(403);
      }
      expect(await aptidoes(helenaId)).toHaveLength(0);

      const r = await chamar(EMAILS_DEMO.gestor, "POST", url, { apto: true });
      expect(r.status).toBe(201);
      expect(r.corpo).toEqual({
        apto: true,
        conferidoEm: T0.toISOString(),
        conferidoPor: { nome: expect.any(String) },
      });
      expect(await aptidoes(helenaId)).toHaveLength(1);
    });

    it("validações: corpo estrito, atleta inexistente e id inválido", async () => {
      const url = `/atletas/${helenaId}/aptidao`;
      expect((await chamar(EMAILS_DEMO.gestor, "POST", url, {})).status).toBe(400);
      expect((await chamar(EMAILS_DEMO.gestor, "POST", url, { apto: "sim" })).status).toBe(400);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "POST", url, { apto: true, observacao: "atestado" }))
          .status,
      ).toBe(400);
      expect(
        (
          await chamar(
            EMAILS_DEMO.gestor,
            "POST",
            "/atletas/00000000-0000-4000-8000-000000000000/aptidao",
            { apto: true },
          )
        ).status,
      ).toBe(404);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "POST", "/atletas/x/aptidao", { apto: true })).status,
      ).toBe(400);
    });

    it("série histórica: vale a última; o banco recusa UPDATE e DELETE", async () => {
      agora = new Date(T0.getTime() + 3_600_000);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${helenaId}/aptidao`, { apto: false }))
          .status,
      ).toBe(201);
      expect(await aptidoes(helenaId)).toHaveLength(2);
      const f = await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil");
      expect(f.corpo.atleta.aptidao).toMatchObject({
        apto: false,
        conferidoEm: agora.toISOString(),
      });
      await expect(p.db.exec("update aptidoes set apto = true")).rejects.toThrow(
        /aceita só inserção/,
      );
      await expect(p.db.exec("delete from aptidoes")).rejects.toThrow(/aceita só inserção/);
    });

    it("a auditoria do registro não guarda o resultado", async () => {
      const a = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'registrar_aptidao' and entidade_id = $1",
        [helenaId],
      );
      expect(a.rows.length).toBeGreaterThan(0);
      for (const l of a.rows) expect(Object.keys(l.detalhes)).toEqual(["aptidaoId"]);
    });
  });

  describe("leitura na ficha e no perfil", () => {
    beforeAll(async () => {
      await p.db.query(
        "update atletas set telefone = '+5511999998888', passaporte_valido_ate = '2029-03-31' where id in ($1, $2)",
        [helenaId, consentidoId],
      );
      await p.db.query(
        "insert into aptidoes (atleta_id, apto, conferido_por, conferido_em) values ($1, true, $3, $4), ($2, true, $3, $4)",
        [helenaId, consentidoId, gestorId, T0],
      );
    });

    it("gestor e treinador do atleta recebem os três; o próprio atleta também", async () => {
      for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
        const r = await chamar(email, "GET", `/atletas/${helenaId}`);
        expect(r.status, email).toBe(200);
        expect(r.corpo.contato, email).toMatchObject({
          telefone: "+5511999998888",
          passaporteValidoAte: "2029-03",
          aptidao: { apto: expect.any(Boolean), conferidoPor: { nome: expect.any(String) } },
        });
      }
    });

    it("IBVAR não recebe nenhum dos três (contato nulo e nada no corpo)", async () => {
      const r = await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${consentidoId}`);
      expect(r.status).toBe(200);
      expect(r.corpo.contato).toBeNull();
      for (const termo of ["telefone", "passaporte", "aptidao", "999998888", "2029-03"]) {
        expect(r.texto, termo).not.toContain(termo);
      }
      // Nem nas listas.
      const lista = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
      expect(lista.texto).not.toContain("999998888");
      expect(lista.texto).not.toContain("aptidao");
    });

    it("treinador de outro atleta não lê (404 na ficha)", async () => {
      const r = await chamar(EMAILS_DEMO.treinadora, "GET", `/atletas/${consentidoId}`);
      // SC-T01 é de outro treinador? Se for da treinadora, o acesso é legítimo.
      const dono = await p.db.query<{ email: string }>(
        "select u.email from atletas a join usuarios u on u.id = a.treinador_id where a.id = $1",
        [consentidoId],
      );
      expect(r.status).toBe(dono.rows[0]!.email === EMAILS_DEMO.treinadora ? 200 : 404);
    });

    it("leitura da aptidão por gestor ou treinador é auditada (só ids); a do atleta não", async () => {
      const antes = await leiturasAuditadas(helenaId);
      await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${helenaId}`);
      expect(await leiturasAuditadas(helenaId)).toBe(antes + 1);
      await chamar(EMAILS_DEMO.treinadora, "GET", `/atletas/${helenaId}`);
      expect(await leiturasAuditadas(helenaId)).toBe(antes + 2);
      await chamar(EMAILS_DEMO.atleta, "GET", `/atletas/${helenaId}`);
      await chamar(EMAILS_DEMO.atleta, "GET", "/me/perfil");
      expect(await leiturasAuditadas(helenaId)).toBe(antes + 2);
      const consentidoAntes = await leiturasAuditadas(consentidoId);
      await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${consentidoId}`);
      expect(await leiturasAuditadas(consentidoId)).toBe(consentidoAntes);

      const a = await p.db.query<{ detalhes: unknown; usuario_id: string }>(
        "select detalhes, usuario_id from auditoria where acao = 'ler_aptidao' and entidade_id = $1 order by id desc limit 1",
        [helenaId],
      );
      expect(a.rows[0]!.detalhes).toEqual({});
    });

    it("sem aptidão registrada: aptidao nula e nada auditado", async () => {
      const outro = await p.idDe("RS-T02");
      const r = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${outro}`);
      expect(r.corpo.contato).toMatchObject({
        telefone: null,
        passaporteValidoAte: null,
        aptidao: null,
      });
      expect(await leiturasAuditadas(outro)).toBe(0);
    });
  });

  describe("LGPD: exportação e anonimização", () => {
    it("GET /meus-dados traz telefone, passaporte e as aptidões", async () => {
      const r = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
      expect(r.status).toBe(200);
      expect(r.corpo.atleta).toMatchObject({
        telefone: "+5511999998888",
        passaporteValidoAte: "2029-03",
      });
      expect(r.corpo.aptidoes.length).toBeGreaterThan(0);
      expect(r.corpo.aptidoes[0]).toEqual({
        apto: expect.any(Boolean),
        conferidoPor: expect.any(String),
        conferidoEm: expect.any(String),
      });
    });
  });
});

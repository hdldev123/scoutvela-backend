import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const V1 = "Piloto 18+ · v1";

describe("termo de consentimento versionado", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto();
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
  const atletaId = async () =>
    (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;

  it("GET /termo: qualquer perfil autenticado lê; sem token, 401", async () => {
    for (const email of Object.values(EMAILS_DEMO)) {
      const { status, corpo } = await chamar(email, "GET", "/termo");
      expect(status, email).toBe(200);
      expect(corpo.versao).toBe(V1);
      expect(corpo.texto.startsWith("Minuta para validação jurídica da CBVela.")).toBe(true);
      expect(Number.isNaN(Date.parse(corpo.vigenteDesde))).toBe(false);
    }
    expect((await p.app.inject({ method: "GET", url: "/termo" })).statusCode).toBe(401);
  });

  it("a minuta cobre piloto 18+, dados, finalidade, IBVAR separado, art. 20 e direitos", async () => {
    const { texto } = (await chamar(EMAILS_DEMO.atleta, "GET", "/termo")).corpo;
    for (const trecho of [
      "18 anos ou mais",
      "medidas corporais",
      "perfil mental",
      "financeiras da campanha",
      "priorização de investimento",
      "sugere",
      "IBVAR",
      "revogá-lo",
      "art. 20",
      "correção e exclusão",
    ]) {
      expect(texto, trecho).toContain(trecho);
    }
  });

  it("o texto é só de inserção e o vigente é o de maior vigente_desde", async () => {
    await expect(p.db.exec("update termos_consentimento set texto = 'x'")).rejects.toThrow(
      /aceita só inserção/,
    );
    await expect(p.db.exec("delete from termos_consentimento")).rejects.toThrow(
      /aceita só inserção/,
    );
    await p.db.query(
      "insert into termos_consentimento (versao, titulo, texto, vigente_desde) values ('Piloto 18+ · v2', 'Termo v2', 'Texto v2', '2026-11-01T00:00:00Z')",
    );
    const { corpo } = await chamar(EMAILS_DEMO.gestor, "GET", "/termo");
    expect(corpo).toMatchObject({
      versao: "Piloto 18+ · v2",
      titulo: "Termo v2",
      texto: "Texto v2",
    });
  });

  describe("POST /termo/aceite", () => {
    it("só atleta; versão que não é a vigente -> 400", async () => {
      for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
        expect(
          (await chamar(email, "POST", "/termo/aceite", { versao: "Piloto 18+ · v2" })).status,
          email,
        ).toBe(403);
      }
      expect(
        (await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V1 })).status,
      ).toBe(400);
      expect((await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", {})).status).toBe(400);
    });

    it("aceita a vigente, grava consentimento termo_piloto pelo próprio usuário e audita; repetir -> 409", async () => {
      const r = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", {
        versao: "Piloto 18+ · v2",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ ok: true });

      const id = await atletaId();
      const usuario = (
        await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
          EMAILS_DEMO.atleta,
        ])
      ).rows[0]!.id;
      const ultimo = (
        await p.db.query<{
          tipo: string;
          concedido: boolean;
          versao_termo: string;
          registrado_por: string;
        }>(
          "select tipo, concedido, versao_termo, registrado_por from consentimentos where atleta_id = $1 and tipo = 'termo_piloto' order by id desc limit 1",
          [id],
        )
      ).rows[0]!;
      expect(ultimo).toEqual({
        tipo: "termo_piloto",
        concedido: true,
        versao_termo: "Piloto 18+ · v2",
        registrado_por: usuario,
      });
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'aceitar_termo' and entidade_id = $1",
        [id],
      );
      expect(aud.rows).toEqual([{ detalhes: { versaoTermo: "Piloto 18+ · v2" } }]);

      const outra = await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", {
        versao: "Piloto 18+ · v2",
      });
      expect(outra.status).toBe(409);
    });

    it("não concede o compartilhamento com o IBVAR", async () => {
      const r = await p.db.query(
        "select 1 from consentimentos where atleta_id = $1 and tipo = 'compartilhar_ibvar' and registrado_por is not null and versao_termo = 'Piloto 18+ · v2'",
        [await atletaId()],
      );
      expect(r.rows).toHaveLength(0);
    });
  });

  it("POST /atletas/:id/termo (gestor) confere com a versão vigente lida do banco", async () => {
    const id = await p.idDe("SC-T01");
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/termo`, { versao: V1 })).status,
    ).toBe(400);
  });
});

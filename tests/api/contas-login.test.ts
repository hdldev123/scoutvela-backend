import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { cabecalhoAuth, criarAppDeTeste, criarUsuarioDeTeste, tokenPara } from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("vínculo da conta no primeiro login", () => {
  let db: Db;
  let app: FastifyInstance;
  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db);
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const me = async (token: string) => app.inject({ method: "GET", url: "/me", headers: cabecalhoAuth(token) });
  const cadastrar = async (email: string, papel = "treinador", ativo = true) =>
    (
      await db.query<{ id: string }>(
        "insert into usuarios (email, nome, papel, ativo) values ($1, 'Convidado', $2, $3) returning id",
        [email, papel, ativo],
      )
    ).rows[0]!.id;

  it("grava o sub no usuário ativo com o mesmo e-mail (sem diferenciar maiúsculas) e audita sem e-mail", async () => {
    const id = await cadastrar("convidada@exemplo.com");
    const sub = crypto.randomUUID();
    const r = await me(await tokenPara(sub, { email: "Convidada@Exemplo.com" }));
    expect(r.statusCode).toBe(200);
    expect(r.json().usuario.papel).toBe("treinador");
    expect((await db.query<{ auth_user_id: string }>("select auth_user_id from usuarios where id = $1", [id])).rows[0]!.auth_user_id).toBe(sub);
    const aud = await db.query<{ detalhes: unknown }>("select detalhes from auditoria where acao = 'vincular_conta' and entidade_id = $1", [id]);
    expect(aud.rows).toEqual([{ detalhes: {} }]);
    // Segunda chamada já encontra pelo sub.
    expect((await me(await tokenPara(sub, { email: "convidada@exemplo.com" }))).statusCode).toBe(200);
  });

  it("não vincula sem e-mail no token, com e-mail desconhecido ou usuário inativo", async () => {
    const inativo = await cadastrar("inativo@exemplo.com", "treinador", false);
    expect((await me(await tokenPara(crypto.randomUUID()))).statusCode).toBe(403);
    expect((await me(await tokenPara(crypto.randomUUID(), { email: "ninguem@exemplo.com" }))).statusCode).toBe(403);
    expect((await me(await tokenPara(crypto.randomUUID(), { email: "inativo@exemplo.com" }))).statusCode).toBe(403);
    expect((await db.query<{ auth_user_id: string | null }>("select auth_user_id from usuarios where id = $1", [inativo])).rows[0]!.auth_user_id).toBeNull();
  });

  it("não sobrescreve um cadastro já vinculado a outro login", async () => {
    const dono = crypto.randomUUID();
    await criarUsuarioDeTeste(db, { papel: "gestor", authUserId: dono });
    const email = (await db.query<{ email: string }>("select email from usuarios where auth_user_id = $1", [dono])).rows[0]!.email;
    expect((await me(await tokenPara(crypto.randomUUID(), { email }))).statusCode).toBe(403);
    expect((await db.query<{ auth_user_id: string }>("select auth_user_id from usuarios where email = $1", [email])).rows[0]!.auth_user_id).toBe(dono);
  });
});

describe("MFA (aal2) para gestor e IBVAR", () => {
  let db: Db;
  let ligado: FastifyInstance;
  let desligado: FastifyInstance;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    ligado = await criarAppDeTeste(db, { config: { EXIGIR_MFA: true } });
    desligado = await criarAppDeTeste(db, { config: { EXIGIR_MFA: false } });
    for (const papel of ["gestor", "ibvar", "treinador", "atleta"] as const) {
      ids[papel] = (await criarUsuarioDeTeste(db, { papel })).authUserId;
    }
  });
  afterAll(async () => {
    await ligado.close();
    await desligado.close();
    await db.fechar();
  });

  const chamar = async (app: FastifyInstance, papel: string, aal?: "aal1" | "aal2", url = "/me") =>
    app.inject({ method: "GET", url, headers: cabecalhoAuth(await tokenPara(ids[papel]!, aal ? { aal } : {})) });

  it("com EXIGIR_MFA, gestor e IBVAR em aal1 (ou sem claim) recebem 403 mfa_obrigatorio, inclusive em /me", async () => {
    for (const papel of ["gestor", "ibvar"]) {
      for (const aal of ["aal1", undefined] as const) {
        const r = await chamar(ligado, papel, aal);
        expect(r.statusCode, `${papel} ${aal}`).toBe(403);
        expect(r.json().erro).toBe("mfa_obrigatorio");
      }
      expect((await chamar(ligado, papel, "aal1", "/ranking")).json().erro).toBe("mfa_obrigatorio");
    }
  });

  it("com aal2 passam", async () => {
    expect((await chamar(ligado, "gestor", "aal2")).statusCode).toBe(200);
    expect((await chamar(ligado, "ibvar", "aal2")).statusCode).toBe(200);
  });

  it("treinador e atleta não precisam de aal2", async () => {
    expect((await chamar(ligado, "treinador", "aal1")).statusCode).toBe(200);
    expect((await chamar(ligado, "atleta", "aal1")).statusCode).toBe(200);
  });

  it("com EXIGIR_MFA desligado nada muda", async () => {
    expect((await chamar(desligado, "gestor", "aal1")).statusCode).toBe(200);
    expect((await chamar(desligado, "ibvar")).statusCode).toBe(200);
  });
});

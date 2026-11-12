import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import {
  ORIGEM_PERMITIDA_TESTE,
  cabecalhoAuth,
  criarAppDeTeste,
  criarUsuarioDeTeste,
  tokenPara,
} from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("autenticação", () => {
  let db: Db;
  let app: FastifyInstance;
  let gestor: Awaited<ReturnType<typeof criarUsuarioDeTeste>>;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db);
    gestor = await criarUsuarioDeTeste(db, { papel: "gestor" });
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const chamarMe = (headers?: Record<string, string>) =>
    app.inject({ method: "GET", url: "/me", ...(headers ? { headers } : {}) });

  it("sem header Authorization responde 401", async () => {
    const r = await chamarMe();
    expect(r.statusCode).toBe(401);
    expect(r.json().erro).toBe("nao_autenticado");
  });

  it("esquema diferente de Bearer responde 401", async () => {
    expect((await chamarMe({ authorization: "Basic abc" })).statusCode).toBe(401);
  });

  it("token com assinatura errada responde 401", async () => {
    const t = await tokenPara(gestor.authUserId, {
      segredo: "outro-segredo-qualquer-com-32-caracteres!!",
    });
    expect((await chamarMe(cabecalhoAuth(t))).statusCode).toBe(401);
  });

  it("token expirado responde 401", async () => {
    const t = await tokenPara(gestor.authUserId, { expiraEm: new Date(Date.now() - 60_000) });
    expect((await chamarMe(cabecalhoAuth(t))).statusCode).toBe(401);
  });

  it("issuer errado responde 401", async () => {
    const t = await tokenPara(gestor.authUserId, { issuer: "http://outro.projeto/auth/v1" });
    expect((await chamarMe(cabecalhoAuth(t))).statusCode).toBe(401);
  });

  it("audience errada responde 401", async () => {
    const t = await tokenPara(gestor.authUserId, { audience: "anon" });
    expect((await chamarMe(cabecalhoAuth(t))).statusCode).toBe(401);
  });

  it("usuário sem cadastro responde 403", async () => {
    const t = await tokenPara(crypto.randomUUID());
    const r = await chamarMe(cabecalhoAuth(t));
    expect(r.statusCode).toBe(403);
    expect(r.json().erro).toBe("sem_acesso");
  });

  it("usuário inativo responde 403", async () => {
    const u = await criarUsuarioDeTeste(db, { papel: "treinador", ativo: false });
    expect((await chamarMe(cabecalhoAuth(await tokenPara(u.authUserId)))).statusCode).toBe(403);
  });

  it("papel responsável responde 403", async () => {
    const u = await criarUsuarioDeTeste(db, { papel: "responsavel" });
    expect((await chamarMe(cabecalhoAuth(await tokenPara(u.authUserId)))).statusCode).toBe(403);
  });

  it("token válido de usuário cadastrado passa", async () => {
    const r = await chamarMe(cabecalhoAuth(await tokenPara(gestor.authUserId)));
    expect(r.statusCode).toBe(200);
  });
});

describe("health, CORS, erros e documentação", () => {
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

  it("/health não exige autenticação", async () => {
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ ok: true });
  });

  it("CORS libera origem da lista", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: ORIGEM_PERMITIDA_TESTE },
    });
    expect(r.headers["access-control-allow-origin"]).toBe(ORIGEM_PERMITIDA_TESTE);
  });

  it("CORS recusa origem fora da lista", async () => {
    const r = await app.inject({
      method: "GET",
      url: "/health",
      headers: { origin: "http://malicioso.exemplo" },
    });
    expect(r.headers["access-control-allow-origin"]).toBeUndefined();
    const pre = await app.inject({
      method: "OPTIONS",
      url: "/me",
      headers: { origin: "http://malicioso.exemplo", "access-control-request-method": "GET" },
    });
    expect(pre.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rota inexistente responde 404 no formato padrão", async () => {
    const r = await app.inject({ method: "GET", url: "/nao-existe" });
    expect(r.statusCode).toBe(404);
    expect(r.json().erro).toBe("nao_encontrado");
  });

  it("erro interno responde 500 sem detalhes", async () => {
    const u = await criarUsuarioDeTeste(db, { papel: "gestor" });
    const quebrado = await criarAppDeTeste({
      ...db,
      query: async () => {
        throw new Error("segredo interno: senha=abc");
      },
    });
    const r = await quebrado.inject({
      method: "GET",
      url: "/me",
      headers: cabecalhoAuth(await tokenPara(u.authUserId)),
    });
    expect(r.statusCode).toBe(500);
    expect(r.json().erro).toBe("erro_interno");
    expect(r.body).not.toContain("segredo");
    await quebrado.close();
  });

  it("/docs/json documenta /health e /me", async () => {
    const r = await app.inject({ method: "GET", url: "/docs/json" });
    expect(r.statusCode).toBe(200);
    const paths = Object.keys(r.json().paths);
    expect(paths).toContain("/me");
    expect(paths).toContain("/health");
  });

  it("swagger-ui fica desligado em produção", async () => {
    const prod = await criarAppDeTeste(db, { config: { APP_ENV: "producao" } });
    expect((await prod.inject({ method: "GET", url: "/docs" })).statusCode).toBe(404);
    expect((await prod.inject({ method: "GET", url: "/docs/json" })).statusCode).toBe(404);
    await prod.close();
  });
});

describe("segurança HTTP", () => {
  let db: Db;
  beforeAll(async () => {
    db = await criarBancoDeTeste();
  });
  afterAll(async () => {
    await db.fechar();
  });

  it("rotas da API trazem cabeçalhos de segurança", async () => {
    const app = await criarAppDeTeste(db);
    const r = await app.inject({ method: "GET", url: "/health" });
    expect(r.headers["strict-transport-security"]).toContain("max-age=31536000");
    expect(r.headers["strict-transport-security"]).toContain("includeSubDomains");
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(r.headers["x-content-type-options"]).toBe("nosniff");
    await app.close();
  });

  it("responde 429 no formato padrão ao estourar o limite; /health é isento", async () => {
    const app = await criarAppDeTeste(db, { limiteRequisicoes: { max: 3, janelaMs: 60_000 } });
    const codigos: number[] = [];
    for (let i = 0; i < 5; i++)
      codigos.push((await app.inject({ method: "GET", url: "/me" })).statusCode);
    expect(codigos).toEqual([401, 401, 401, 429, 429]);
    const r = await app.inject({ method: "GET", url: "/me" });
    expect(r.json().erro).toBe("limite_excedido");
    for (let i = 0; i < 10; i++) {
      expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
    }
    await app.close();
  });

  it("/docs responde fora de produção com CSP própria e não existe em produção", async () => {
    const dev = await criarAppDeTeste(db);
    const r = await dev.inject({ method: "GET", url: "/docs/" });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-security-policy"]).toContain("script-src");
    expect(r.headers["content-security-policy"]).not.toContain("default-src 'none'");
    await dev.close();
    const prod = await criarAppDeTeste(db, { config: { APP_ENV: "producao" } });
    expect((await prod.inject({ method: "GET", url: "/docs/" })).statusCode).toBe(404);
    await prod.close();
  });
});

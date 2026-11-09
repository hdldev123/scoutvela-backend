import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarAuthLocal, ouvirLocal, vincularContasLocais } from "../../dev/auth-local.js";
import { migrar } from "../../src/db/migrar.js";
import { criarDbPglite } from "../../src/db/pglite.js";
import type { Db } from "../../src/db/db.js";
import { semear } from "../../seed/semear.js";
import { criarApp } from "../../src/app.js";
import { criarVerificadorSupabase } from "../../src/auth/jwt.js";
import { configDeTeste } from "../apoio/app.js";

const SEGREDO = "segredo-local-de-teste-com-mais-de-32-caracteres";

let db: Db;
let auth: FastifyInstance;
let api: FastifyInstance;
let urlAuth: string;

// Node 20 não tem WebSocket nativo e o realtime do cliente o exige; só o Auth é usado aqui.
class TransporteNulo {}

function novoCliente(): SupabaseClient {
  return createClient(urlAuth, "chave-local-dev", {
    realtime: { transport: TransporteNulo as never },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

beforeAll(async () => {
  db = await criarDbPglite();
  await migrar(db);
  await semear(db);
  await vincularContasLocais(db);
  // O issuer precisa da URL final; sobe numa porta efêmera e recria com a URL real.
  const provisorio = await criarAuthLocal({ db, supabaseUrl: "http://127.0.0.1:1", jwtSecret: SEGREDO, origens: [] });
  await ouvirLocal(provisorio, 0);
  const porta = (provisorio.server.address() as { port: number }).port;
  await provisorio.close();
  urlAuth = `http://127.0.0.1:${porta}`;
  auth = await criarAuthLocal({ db, supabaseUrl: urlAuth, jwtSecret: SEGREDO, origens: [] });
  await ouvirLocal(auth, porta);
  api = await criarApp({
    db,
    config: configDeTeste({ SUPABASE_URL: urlAuth, SUPABASE_JWT_SECRET: SEGREDO }),
    verificarToken: criarVerificadorSupabase({ supabaseUrl: urlAuth, jwtSecret: SEGREDO }),
    logger: false,
  });
  await api.ready();
});

afterAll(async () => {
  await api?.close();
  await auth?.close();
  await db?.fechar();
});

describe("emulador de Auth local com o cliente real do Supabase", () => {
  it("signInWithPassword devolve token que autentica /me como gestor", async () => {
    const { data, error } = await novoCliente().auth.signInWithPassword({
      email: "gestor@scoutvela.dev",
      password: "gestor123",
    });
    expect(error).toBeNull();
    expect(data.session?.user.email).toBe("gestor@scoutvela.dev");
    const r = await api.inject({
      method: "GET",
      url: "/me",
      headers: { authorization: `Bearer ${data.session!.access_token}` },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().usuario.papel).toBe("gestor");
  });

  it("senha errada ou e-mail desconhecido: invalid_credentials", async () => {
    for (const [email, password] of [
      ["gestor@scoutvela.dev", "errada"],
      ["ninguem@scoutvela.dev", "gestor123"],
    ] as const) {
      const { data, error } = await novoCliente().auth.signInWithPassword({ email, password });
      expect(data.session).toBeNull();
      expect(error?.code).toBe("invalid_credentials");
    }
  });

  it("refresh token funciona uma vez e falha na segunda", async () => {
    const cliente = novoCliente();
    const { data } = await cliente.auth.signInWithPassword({ email: "atleta@scoutvela.dev", password: "atleta123" });
    const refresh = data.session!.refresh_token;
    const primeira = await novoCliente().auth.refreshSession({ refresh_token: refresh });
    expect(primeira.error).toBeNull();
    expect(primeira.data.session?.refresh_token).not.toBe(refresh);
    const segunda = await novoCliente().auth.refreshSession({ refresh_token: refresh });
    expect(segunda.error?.code).toBe("refresh_token_not_found");
  });

  it("logout invalida o refresh token", async () => {
    const cliente = novoCliente();
    const { data } = await cliente.auth.signInWithPassword({ email: "ibvar@scoutvela.dev", password: "ibvar123" });
    const refresh = data.session!.refresh_token;
    expect((await cliente.auth.signOut()).error).toBeNull();
    const r = await novoCliente().auth.refreshSession({ refresh_token: refresh });
    expect(r.error?.code).toBe("refresh_token_not_found");
  });

  it("GET /user: token válido devolve o usuário; inválido, 401 bad_jwt", async () => {
    const { data } = await novoCliente().auth.signInWithPassword({ email: "gestor@scoutvela.dev", password: "gestor123" });
    const ok = await fetch(`${urlAuth}/auth/v1/user`, { headers: { authorization: `Bearer ${data.session!.access_token}` } });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { aud: string }).aud).toBe("authenticated");
    const ruim = await fetch(`${urlAuth}/auth/v1/user`, { headers: { authorization: "Bearer xxx" } });
    expect(ruim.status).toBe(401);
    expect(await ruim.json()).toEqual({ code: 401, error_code: "bad_jwt", msg: "invalid JWT" });
  });

  it("CORS só para as origens configuradas", async () => {
    const comOrigem = await criarAuthLocal({ db, supabaseUrl: urlAuth, jwtSecret: SEGREDO, origens: ["http://localhost:5173"] });
    const permitida = await comOrigem.inject({ method: "OPTIONS", url: "/auth/v1/token", headers: { origin: "http://localhost:5173", "access-control-request-method": "POST" } });
    expect(permitida.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    const negada = await comOrigem.inject({ method: "OPTIONS", url: "/auth/v1/token", headers: { origin: "http://evil.example", "access-control-request-method": "POST" } });
    expect(negada.headers["access-control-allow-origin"]).toBeUndefined();
    await comOrigem.close();
  });
});

describe("recusa fora de desenvolvimento", () => {
  it("emulador recusa APP_ENV=producao", async () => {
    await expect(
      criarAuthLocal({ db, supabaseUrl: urlAuth, jwtSecret: SEGREDO, origens: [], appEnv: "producao" }),
    ).rejects.toThrow(/APP_ENV=desenvolvimento/);
    const anterior = process.env.APP_ENV;
    process.env.APP_ENV = "producao";
    try {
      await expect(criarAuthLocal({ db, supabaseUrl: urlAuth, jwtSecret: SEGREDO, origens: [] })).rejects.toThrow();
    } finally {
      if (anterior === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = anterior;
    }
  });
});

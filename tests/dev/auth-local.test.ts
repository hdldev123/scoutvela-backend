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
import { criarAdminAuth } from "../../src/integracoes/supabase-admin.js";
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

describe("convite e redefinição de senha no emulador", () => {
  const FRONT = "http://localhost:8080";
  const CHAVE = "chave-de-servico-local-de-teste";
  let db2: Db;
  let auth2: FastifyInstance;
  let api2: FastifyInstance;
  let url2: string;
  let links: string[];

  beforeAll(async () => {
    db2 = await criarDbPglite();
    await migrar(db2);
    await semear(db2);
    await vincularContasLocais(db2);
    links = [];
    const opcoes = { jwtSecret: SEGREDO, origens: [FRONT], serviceRoleKey: CHAVE, log: (m: string) => links.push(m) };
    const provisorio = await criarAuthLocal({ db: db2, supabaseUrl: "http://127.0.0.1:1", ...opcoes });
    await ouvirLocal(provisorio, 0);
    const porta = (provisorio.server.address() as { port: number }).port;
    await provisorio.close();
    url2 = `http://127.0.0.1:${porta}`;
    auth2 = await criarAuthLocal({ db: db2, supabaseUrl: url2, ...opcoes });
    await ouvirLocal(auth2, porta);
    api2 = await criarApp({
      db: db2,
      config: configDeTeste({ SUPABASE_URL: url2, SUPABASE_JWT_SECRET: SEGREDO, SUPABASE_SERVICE_ROLE_KEY: CHAVE, FRONT_URL: FRONT }),
      verificarToken: criarVerificadorSupabase({ supabaseUrl: url2, jwtSecret: SEGREDO }),
      adminAuth: criarAdminAuth({ supabaseUrl: url2, serviceRoleKey: CHAVE }),
      logger: false,
    });
    await api2.ready();
  });

  afterAll(async () => {
    await api2?.close();
    await auth2?.close();
    await db2?.fechar();
  });

  const cliente = () =>
    createClient(url2, "chave-local-dev", {
      realtime: { transport: TransporteNulo as never },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  const ultimoLink = () => /(http:\/\/\S+)$/.exec(links.at(-1) ?? "")![1]!;
  const abrirLink = async (link: string) => {
    const r = await fetch(link, { redirect: "manual" });
    expect(r.status).toBe(302);
    const destino = new URL(r.headers.get("location")!);
    return { destino, frag: new URLSearchParams(destino.hash.slice(1)) };
  };
  const convidar = (email: string, key = CHAVE, redirect = `${FRONT}/redefinir-senha`) =>
    fetch(`${url2}/auth/v1/invite?redirect_to=${encodeURIComponent(redirect)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, apikey: key, "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  it("fluxo completo: gestor convida pela API, a pessoa abre o link, define a senha e entra", async () => {
    const gestor = (await cliente().auth.signInWithPassword({ email: "gestor@scoutvela.dev", password: "gestor123" })).data.session!;
    const r = await api2.inject({
      method: "POST",
      url: "/usuarios",
      headers: { authorization: `Bearer ${gestor.access_token}` },
      payload: { nome: "Nova Treinadora", email: "nova.treinadora@exemplo.com", papel: "treinador" },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().convite).toBe("enviado");
    expect(links).toHaveLength(1);
    expect(links[0]).toContain("nova.treinadora@exemplo.com");

    const { destino, frag } = await abrirLink(ultimoLink());
    expect(`${destino.origin}${destino.pathname}`).toBe(`${FRONT}/redefinir-senha`);
    expect(frag.get("type")).toBe("invite");
    expect(frag.get("token_type")).toBe("bearer");
    expect(frag.get("expires_in")).toBe("3600");

    const c = cliente();
    const sessao = await c.auth.setSession({ access_token: frag.get("access_token")!, refresh_token: frag.get("refresh_token")! });
    expect(sessao.error).toBeNull();
    expect((await c.auth.updateUser({ password: "senha-nova-123" })).error).toBeNull();

    const login = await cliente().auth.signInWithPassword({ email: "nova.treinadora@exemplo.com", password: "senha-nova-123" });
    expect(login.error).toBeNull();
    const me = await api2.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${login.data.session!.access_token}` } });
    expect(me.statusCode).toBe(200);
    expect(me.json().usuario).toMatchObject({ papel: "treinador", nome: "Nova Treinadora" });
    const claims = JSON.parse(Buffer.from(login.data.session!.access_token.split(".")[1]!, "base64url").toString()) as { aal: string };
    expect(claims.aal).toBe("aal1");

    // Com a senha definida, a conta existe: reenviar o convite cai em "conta já existe".
    const reenvio = await api2.inject({
      method: "POST",
      url: `/usuarios/${r.json().usuario.id}/convite`,
      headers: { authorization: `Bearer ${gestor.access_token}` },
    });
    expect(reenvio.statusCode).toBe(409);
    expect(reenvio.json().mensagem).toContain("Esqueci a senha");
  });

  it("o link é de uso único; link inválido volta ao front com erro no fragmento", async () => {
    expect((await convidar("ibvar2@exemplo.com")).status).toBe(400); // não cadastrado na API
    await db2.query("insert into usuarios (email, nome, papel) values ('uso.unico@exemplo.com', 'Uso Único', 'ibvar')");
    expect((await convidar("uso.unico@exemplo.com")).status).toBe(200);
    const link = ultimoLink();
    expect((await abrirLink(link)).frag.get("access_token")).toBeTruthy();
    const segunda = await abrirLink(link);
    expect(segunda.frag.get("access_token")).toBeNull();
    expect(segunda.frag.get("error_code")).toBe("otp_expired");
    const falso = await abrirLink(link.replace(/token=[^&]+/, "token=inventado"));
    expect(falso.frag.get("error")).toBe("access_denied");
  });

  it("convite exige a chave de servidor, e-mail ainda sem conta e redirect de origem liberada", async () => {
    expect((await convidar("gestor2@exemplo.com", "outra-chave")).status).toBe(401);
    const semAuth = await fetch(`${url2}/auth/v1/invite`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "x@x.dev" }),
    });
    expect(semAuth.status).toBe(401);
    const existente = await convidar("gestor@scoutvela.dev");
    expect(existente.status).toBe(422);
    expect(((await existente.json()) as { error_code: string }).error_code).toBe("email_exists");
    await db2.query("insert into usuarios (email, nome, papel) values ('redirect@exemplo.com', 'R', 'ibvar')");
    expect((await convidar("redirect@exemplo.com", CHAVE, "http://evil.example/x")).status).toBe(400);
    const verifica = await fetch(`${url2}/auth/v1/verify?token=x&type=invite&redirect_to=${encodeURIComponent("http://evil.example/")}`, {
      redirect: "manual",
    });
    expect(verifica.status).toBe(400);
  });

  it("redefinição: recover imprime o link, verify devolve sessão, a senha troca e a antiga deixa de valer", async () => {
    const antes = links.length;
    const c = cliente();
    expect((await c.auth.resetPasswordForEmail("atleta@scoutvela.dev", { redirectTo: `${FRONT}/redefinir-senha` })).error).toBeNull();
    expect(links).toHaveLength(antes + 1);
    const { frag } = await abrirLink(ultimoLink());
    expect(frag.get("type")).toBe("recovery");
    const c2 = cliente();
    await c2.auth.setSession({ access_token: frag.get("access_token")!, refresh_token: frag.get("refresh_token")! });
    expect((await c2.auth.updateUser({ password: "outra-senha-456" })).error).toBeNull();
    expect((await cliente().auth.signInWithPassword({ email: "atleta@scoutvela.dev", password: "atleta123" })).error?.code).toBe("invalid_credentials");
    expect((await cliente().auth.signInWithPassword({ email: "atleta@scoutvela.dev", password: "outra-senha-456" })).error).toBeNull();
  });

  it("recover de e-mail desconhecido responde igual e não gera link", async () => {
    const antes = links.length;
    const r = await cliente().auth.resetPasswordForEmail("ninguem@exemplo.com", { redirectTo: `${FRONT}/redefinir-senha` });
    expect(r.error).toBeNull();
    expect(links).toHaveLength(antes);
  });

  it("PUT /user: sem token 401; senha curta 422", async () => {
    const semToken = await fetch(`${url2}/auth/v1/user`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "123456789" }),
    });
    expect(semToken.status).toBe(401);
    const { data } = await cliente().auth.signInWithPassword({ email: "ibvar@scoutvela.dev", password: "ibvar123" });
    const curta = await fetch(`${url2}/auth/v1/user`, {
      method: "PUT",
      headers: { authorization: `Bearer ${data.session!.access_token}`, "content-type": "application/json" },
      body: JSON.stringify({ password: "123" }),
    });
    expect(curta.status).toBe(422);
  });
});

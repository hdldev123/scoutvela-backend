import { randomUUID } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { decodeJwt } from "jose";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarAuthLocal, ouvirLocal, vincularContasLocais } from "../../dev/auth-local.js";
import { base32Decodificar, totp } from "../../dev/totp.js";
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

describe("MFA TOTP no emulador", () => {
  async function entrar(email: string, password: string): Promise<SupabaseClient> {
    const c = novoCliente();
    const { error } = await c.auth.signInWithPassword({ email, password });
    expect(error).toBeNull();
    return c;
  }

  async function cadastrar(c: SupabaseClient, nome?: string) {
    const { data, error } = await c.auth.mfa.enroll({ factorType: "totp", ...(nome ? { friendlyName: nome } : {}) });
    expect(error).toBeNull();
    return { id: data!.id, segredo: base32Decodificar(data!.totp.secret), dados: data! };
  }

  async function verificar(c: SupabaseClient, id: string, codigo: string) {
    const ch = await c.auth.mfa.challenge({ factorId: id });
    expect(ch.error).toBeNull();
    return c.auth.mfa.verify({ factorId: id, challengeId: ch.data!.id, code: codigo });
  }

  it("enroll devolve QR em SVG sem cerquilha, segredo base32 de 20 bytes e uri otpauth", async () => {
    const c = await entrar("ibvar@scoutvela.dev", "ibvar123");
    const { id, segredo, dados } = await cadastrar(c);
    expect(dados.totp.qr_code.startsWith("data:image/svg+xml;utf-8,<svg")).toBe(true);
    expect(dados.totp.qr_code.includes("#")).toBe(false);
    expect(segredo).toHaveLength(20);
    expect(dados.totp.uri).toMatch(/^otpauth:\/\/totp\/Scout%20Vela%20\(local\):ibvar%40scoutvela\.dev\?secret=/);
    expect(dados.totp.uri).toContain("issuer=Scout%20Vela%20(local)");
    // Fator ainda não verificado: não aparece em totp, aparece em all como unverified.
    const lista = await c.auth.mfa.listFactors();
    expect(lista.data!.totp).toHaveLength(0);
    expect(lista.data!.all.find((f) => f.id === id)?.status).toBe("unverified");
    expect((await c.auth.mfa.unenroll({ factorId: id })).error).toBeNull();
  });

  it("recusa nome repetido e exige Bearer", async () => {
    const c = await entrar("treinadora@scoutvela.dev", "treino123");
    const { id } = await cadastrar(c, "Celular");
    const repetido = await c.auth.mfa.enroll({ factorType: "totp", friendlyName: "Celular" });
    expect(repetido.error?.code).toBe("mfa_factor_name_conflict");
    expect((await c.auth.mfa.unenroll({ factorId: id })).error).toBeNull();
    const r = await fetch(`${urlAuth}/auth/v1/factors`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ factor_type: "totp" }),
    });
    expect(r.status).toBe(401);
  });

  it("challenge + verify: sessão aal2 com amr totp, nível aal2 e fator verificado", async () => {
    const c = await entrar("gestor@scoutvela.dev", "gestor123");
    const { id, segredo } = await cadastrar(c);
    const v = await verificar(c, id, totp(segredo, Date.now()));
    expect(v.error).toBeNull();
    const claims = decodeJwt(v.data!.access_token);
    expect(claims.aal).toBe("aal2");
    expect((claims.amr as Array<{ method: string }>).map((a) => a.method)).toEqual(["password", "totp"]);
    const nivel = await c.auth.mfa.getAuthenticatorAssuranceLevel();
    expect(nivel.data?.currentLevel).toBe("aal2");
    const lista = await c.auth.mfa.listFactors();
    expect(lista.data!.totp.map((f) => f.id)).toEqual([id]);
    expect(lista.data!.totp[0]!.status).toBe("verified");

    // Refresh de sessão aal2 continua aal2.
    const r = await c.auth.refreshSession();
    expect(r.error).toBeNull();
    const renovado = decodeJwt(r.data.session!.access_token);
    expect(renovado.aal).toBe("aal2");
    expect(renovado.session_id).toBe(claims.session_id);

    // Remover fator verificado: aal1 não pode; aal2 pode.
    const outra = await entrar("gestor@scoutvela.dev", "gestor123");
    expect((await outra.auth.mfa.unenroll({ factorId: id })).error?.code).toBe("insufficient_aal");
    expect((await c.auth.mfa.unenroll({ factorId: id })).error).toBeNull();
    expect((await c.auth.mfa.listFactors()).data!.totp).toHaveLength(0);
  });

  it("código errado falha sem gastar o desafio; reuso do mesmo código é recusado", async () => {
    const c = await entrar("atleta@scoutvela.dev", "atleta123");
    const { id, segredo } = await cadastrar(c);
    const errado = totp(segredo, Date.now() + 5 * 30_000);
    const ch = await c.auth.mfa.challenge({ factorId: id });
    const falha = await c.auth.mfa.verify({ factorId: id, challengeId: ch.data!.id, code: errado });
    expect(falha.error?.code).toBe("mfa_verification_failed");
    const certo = totp(segredo, Date.now());
    expect((await c.auth.mfa.verify({ factorId: id, challengeId: ch.data!.id, code: certo })).error).toBeNull();
    // O desafio foi consumido e o código já foi usado.
    const reuso = await verificar(c, id, certo);
    expect(reuso.error?.code).toBe("mfa_verification_failed");
    const velho = await c.auth.mfa.verify({ factorId: id, challengeId: ch.data!.id, code: certo });
    expect(velho.error?.code).toBe("mfa_challenge_not_found");
    expect((await c.auth.mfa.unenroll({ factorId: id })).error).toBeNull();
  });

  it("outro usuário não alcança o fator (404)", async () => {
    const a = await entrar("gestor@scoutvela.dev", "gestor123");
    const b = await entrar("ibvar@scoutvela.dev", "ibvar123");
    const { id, segredo } = await cadastrar(a);
    expect((await b.auth.mfa.challenge({ factorId: id })).error?.code).toBe("mfa_factor_not_found");
    expect(
      (await b.auth.mfa.verify({ factorId: id, challengeId: randomUUID(), code: totp(segredo, Date.now()) })).error?.code,
    ).toBe("mfa_factor_not_found");
    expect((await b.auth.mfa.unenroll({ factorId: id })).error?.code).toBe("mfa_factor_not_found");
    expect((await a.auth.mfa.unenroll({ factorId: id })).error).toBeNull();
  });

  it("recusa fator que não é totp e desafio vencido", async () => {
    let agora = new Date("2026-01-01T12:00:00Z");
    const provisorio = await criarAuthLocal({ db, supabaseUrl: "http://127.0.0.1:1", jwtSecret: SEGREDO, origens: [] });
    await ouvirLocal(provisorio, 0);
    const porta = (provisorio.server.address() as { port: number }).port;
    await provisorio.close();
    const url = `http://127.0.0.1:${porta}`;
    const rel = await criarAuthLocal({ db, supabaseUrl: url, jwtSecret: SEGREDO, origens: [], agora: () => agora });
    await ouvirLocal(rel, porta);
    try {
      const c = createClient(url, "chave-local-dev", {
        realtime: { transport: TransporteNulo as never },
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      });
      await c.auth.signInWithPassword({ email: "gestor@scoutvela.dev", password: "gestor123" });
      const e = await c.auth.mfa.enroll({ factorType: "totp" });
      const segredo = base32Decodificar(e.data!.totp.secret);
      const ch = await c.auth.mfa.challenge({ factorId: e.data!.id });
      agora = new Date(agora.getTime() + 6 * 60_000);
      const v = await c.auth.mfa.verify({ factorId: e.data!.id, challengeId: ch.data!.id, code: totp(segredo, agora.getTime()) });
      expect(v.error?.code).toBe("mfa_challenge_expired");
      const token = (await c.auth.getSession()).data.session!.access_token;
      const r = await fetch(`${url}/auth/v1/factors`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ factor_type: "phone" }),
      });
      expect(r.status).toBe(422);
    } finally {
      await rel.close();
    }
  });
});

describe("API com EXIGIR_MFA e o emulador", () => {
  it("gestor aal1 recebe 403 mfa_obrigatorio; depois do verify, 200", async () => {
    const apiMfa = await criarApp({
      db,
      config: configDeTeste({ SUPABASE_URL: urlAuth, SUPABASE_JWT_SECRET: SEGREDO, EXIGIR_MFA: true }),
      verificarToken: criarVerificadorSupabase({ supabaseUrl: urlAuth, jwtSecret: SEGREDO }),
      logger: false,
    });
    try {
      const c = novoCliente();
      const { data } = await c.auth.signInWithPassword({ email: "gestor@scoutvela.dev", password: "gestor123" });
      const antes = await apiMfa.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${data.session!.access_token}` } });
      expect(antes.statusCode).toBe(403);
      expect(JSON.stringify(antes.json())).toContain("mfa_obrigatorio");

      const e = await c.auth.mfa.enroll({ factorType: "totp" });
      const ch = await c.auth.mfa.challenge({ factorId: e.data!.id });
      const v = await c.auth.mfa.verify({
        factorId: e.data!.id,
        challengeId: ch.data!.id,
        code: totp(base32Decodificar(e.data!.totp.secret), Date.now()),
      });
      expect(v.error).toBeNull();
      const depois = await apiMfa.inject({ method: "GET", url: "/me", headers: { authorization: `Bearer ${v.data!.access_token}` } });
      expect(depois.statusCode).toBe(200);
      expect(depois.json().usuario.papel).toBe("gestor");
      await c.auth.mfa.unenroll({ factorId: e.data!.id });
    } finally {
      await apiMfa.close();
    }
  });
});

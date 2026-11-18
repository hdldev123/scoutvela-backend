import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import { renderSVG } from "uqr";
import type { Db } from "../src/db/db.js";
import { CONTAS_DEMO, type ContaDemo } from "../seed/contas-demo.js";
import { base32Codificar, novoSegredoTotp, verificarTotp } from "./totp.js";

/**
 * Emulador mínimo do Supabase Auth (GoTrue) SÓ PARA DESENVOLVIMENTO: deixa o
 * front usar o @supabase/supabase-js real sem projeto Supabase. Nunca importe
 * este arquivo de src/. Não loga senha, token nem corpo de requisição.
 */

const scryptAsync = promisify(scrypt) as (
  senha: string,
  sal: Buffer,
  tamanho: number,
) => Promise<Buffer>;
const VALIDADE_SEGUNDOS = 3600;
const VALIDADE_DESAFIO_MS = 5 * 60 * 1000;
const MAX_FATORES = 10;
const ISSUER_PADRAO = "Scout Vela (local)";

export interface OpcoesAuthLocal {
  db: Db;
  supabaseUrl: string;
  jwtSecret: string;
  origens: string[];
  agora?: () => Date;
  /** Contas aceitas; padrão CONTAS_DEMO. */
  contas?: ContaDemo[];
  /** Padrão: process.env.APP_ENV, e "desenvolvimento" quando ausente (igual à config da API). */
  appEnv?: string;
  /** Chave de servidor local aceita em /auth/v1/invite (a API a usa como SUPABASE_SERVICE_ROLE_KEY). Sem ela, convite é negado. */
  serviceRoleKey?: string;
  /** Onde imprimir os links de convite e de redefinição (não há e-mail no modo local). Padrão: console.log. */
  log?: (mensagem: string) => void;
}

interface SenhaComHash {
  sal: Buffer;
  hash: Buffer;
}

interface UsuarioAuth {
  auth_user_id: string;
  email: string;
  criado_em: Date;
}

interface LinkEmail {
  authUserId: string;
  email: string;
  tipo: "invite" | "recovery";
  expiraEm: number;
}

type Aal = "aal1" | "aal2";

interface Amr {
  method: string;
  timestamp: number;
}

interface SessaoRefresh {
  authUserId: string;
  sessionId: string;
  aal: Aal;
  amr: Amr[];
}

/** Fator MFA (TOTP) de um usuário. O segredo nunca sai do emulador, exceto na resposta do enroll. */
interface FatorMfa {
  id: string;
  friendly_name: string;
  factor_type: "totp";
  status: "verified" | "unverified";
  segredo: Buffer;
  criado: Date;
  atualizado: Date;
  /** Último passo TOTP aceito (anti-replay: o mesmo passo não vale duas vezes). */
  ultimoPassoUsado: number | null;
}

interface DesafioMfa {
  id: string;
  factorId: string;
  authUserId: string;
  expiraEm: number;
}

async function hashDaSenha(senha: string): Promise<SenhaComHash> {
  const sal = randomBytes(16);
  return { sal, hash: await scryptAsync(senha.normalize("NFKC"), sal, 32) };
}

async function senhaConfere(senha: string, ref: SenhaComHash): Promise<boolean> {
  const candidato = await scryptAsync(senha.normalize("NFKC"), ref.sal, 32);
  return timingSafeEqual(candidato, ref.hash);
}

const hashDoToken = (token: string): string => createHash("sha256").update(token).digest("hex");

function erro(resp: FastifyReply, status: number, errorCode: string, msg: string): FastifyReply {
  return resp.code(status).send({ code: status, error_code: errorCode, msg });
}

/** Escuta somente em 127.0.0.1 (o emulador nunca deve ficar exposto na rede). */
export async function ouvirLocal(app: FastifyInstance, porta: number): Promise<string> {
  return app.listen({ host: "127.0.0.1", port: porta });
}

export async function criarAuthLocal(opcoes: OpcoesAuthLocal): Promise<FastifyInstance> {
  const ambiente = opcoes.appEnv ?? process.env.APP_ENV ?? "desenvolvimento";
  if (ambiente !== "desenvolvimento") {
    throw new Error("O emulador de Auth local só pode rodar com APP_ENV=desenvolvimento.");
  }
  if (opcoes.jwtSecret.length < 32)
    throw new Error("O segredo JWT local precisa ter ao menos 32 caracteres.");

  const { db } = opcoes;
  const agora = opcoes.agora ?? (() => new Date());
  const emissor = `${opcoes.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const chave = new TextEncoder().encode(opcoes.jwtSecret);

  // Hash scrypt calculado na inicialização: a senha em texto puro não fica guardada para comparação.
  const contas = new Map<string, SenhaComHash>();
  for (const c of opcoes.contas ?? CONTAS_DEMO)
    contas.set(c.email.toLowerCase(), await hashDaSenha(c.senha));
  const imprimir = opcoes.log ?? ((m: string) => console.log(m));
  const hashChaveServico = opcoes.serviceRoleKey ? hashDoToken(opcoes.serviceRoleKey) : null;
  // Links de convite/redefinição (uso único, 1 h), indexados pelo SHA-256 do token.
  const linksEmail = new Map<string, LinkEmail>();
  // E-mails convidados nesta execução: id de login emitido (a conta ainda pode não ter senha).
  const convidados = new Map<string, string>();
  const hashFalso = await hashDaSenha(randomBytes(12).toString("hex"));

  // Refresh tokens ficam só em memória, indexados pelo SHA-256 (uso único).
  const refreshTokens = new Map<string, SessaoRefresh>();

  // Fatores e desafios MFA ficam só em memória (por auth_user_id): se perdem ao reiniciar, como os refresh tokens.
  const fatores = new Map<string, FatorMfa[]>();
  const desafios = new Map<string, DesafioMfa>();

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(cors, {
    origin: opcoes.origens,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "authorization",
      "apikey",
      "content-type",
      "x-client-info",
      "x-supabase-api-version",
    ],
  });

  // O cliente envia content-type JSON mesmo sem corpo (logout): corpo vazio vira {}.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, corpo, feito) => {
    if (corpo === "") return feito(null, {});
    try {
      feito(null, JSON.parse(corpo as string));
    } catch {
      feito(new Error("JSON inválido"), undefined);
    }
  });

  app.setErrorHandler((_e, _req, resp) => erro(resp, 400, "validation_failed", "Invalid request"));

  function objetoUser(u: UsuarioAuth) {
    const criado = u.criado_em.toISOString();
    return {
      id: u.auth_user_id,
      aud: "authenticated",
      role: "authenticated",
      email: u.email,
      email_confirmed_at: criado,
      app_metadata: { provider: "email", providers: ["email"] },
      user_metadata: {},
      created_at: criado,
      updated_at: criado,
      factors: (fatores.get(u.auth_user_id) ?? []).map((f) => ({
        id: f.id,
        friendly_name: f.friendly_name,
        factor_type: f.factor_type,
        status: f.status,
        created_at: f.criado.toISOString(),
        updated_at: f.atualizado.toISOString(),
      })),
    };
  }

  async function buscarUsuario(
    filtro: "email" | "auth_user_id",
    valor: string,
  ): Promise<UsuarioAuth | null> {
    const { rows } = await db.query<UsuarioAuth>(
      `select auth_user_id::text as auth_user_id, email, criado_em
         from usuarios where ${filtro} = $1 and ativo and auth_user_id is not null`,
      [valor],
    );
    return rows[0] ?? null;
  }

  function novoRefresh(sessao: SessaoRefresh): string {
    const token = randomBytes(24).toString("base64url");
    refreshTokens.set(hashDoToken(token), sessao);
    return token;
  }

  async function criarSessao(u: UsuarioAuth, sessionId: string, aal: Aal, amr: Amr[]) {
    const emitidoEm = Math.floor(agora().getTime() / 1000);
    const expiraEm = emitidoEm + VALIDADE_SEGUNDOS;
    const accessToken = await new SignJWT({
      email: u.email,
      role: "authenticated",
      session_id: sessionId,
      aal,
      amr,
      is_anonymous: false,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setIssuer(emissor)
      .setAudience("authenticated")
      .setSubject(u.auth_user_id)
      .setIssuedAt(emitidoEm)
      .setExpirationTime(expiraEm)
      .sign(chave);
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: VALIDADE_SEGUNDOS,
      expires_at: expiraEm,
      refresh_token: novoRefresh({ authUserId: u.auth_user_id, sessionId, aal, amr }),
      user: objetoUser(u),
    };
  }

  /** Valida o Bearer (assinatura, emissor, audiência, validade) e devolve o auth_user_id e o e-mail do token. */
  async function claimsDoBearer(cabecalho: string | undefined): Promise<{
    sub: string;
    email: string | null;
    aal: Aal;
    sessionId: string;
    amr: Amr[];
  } | null> {
    const m = /^Bearer (\S+)$/.exec(cabecalho ?? "");
    if (!m) return null;
    try {
      const { payload } = await jwtVerify(m[1]!, chave, {
        issuer: emissor,
        audience: "authenticated",
        algorithms: ["HS256"],
        currentDate: agora(),
      });
      if (typeof payload.sub !== "string" || payload.sub === "") return null;
      const amr = Array.isArray(payload.amr)
        ? (payload.amr as unknown[]).filter(
            (a): a is Amr =>
              typeof a === "object" &&
              a !== null &&
              typeof (a as Amr).method === "string" &&
              typeof (a as Amr).timestamp === "number",
          )
        : [];
      return {
        sub: payload.sub,
        email: typeof payload.email === "string" ? payload.email : null,
        aal: payload.aal === "aal2" ? "aal2" : "aal1",
        sessionId: typeof payload.session_id === "string" ? payload.session_id : randomUUID(),
        amr,
      };
    } catch {
      return null;
    }
  }
  async function sujeitoDoBearer(cabecalho: string | undefined): Promise<string | null> {
    return (await claimsDoBearer(cabecalho))?.sub ?? null;
  }

  const ehChaveServico = (cabecalho: string | undefined): boolean => {
    const m = /^Bearer (\S+)$/.exec(cabecalho ?? "");
    return hashChaveServico !== null && m !== null && hashDoToken(m[1]!) === hashChaveServico;
  };

  /** Destino do link: precisa ser de uma origem liberada (evita redirecionamento aberto). */
  function destinoPermitido(redirectTo: string | undefined): string | null {
    if (!redirectTo) return opcoes.origens[0] ? `${opcoes.origens[0]}/` : null;
    try {
      const u = new URL(redirectTo);
      return opcoes.origens.includes(u.origin) ? u.toString() : null;
    } catch {
      return null;
    }
  }

  function gerarLink(base: string, dados: Omit<LinkEmail, "expiraEm">, destino: string): string {
    const token = randomBytes(24).toString("base64url");
    linksEmail.set(hashDoToken(token), {
      ...dados,
      expiraEm: agora().getTime() + VALIDADE_SEGUNDOS * 1000,
    });
    const q = new URLSearchParams({ token, type: dados.tipo, redirect_to: destino });
    return `${base}/auth/v1/verify?${q.toString()}`;
  }
  const segundosAgora = (): number => Math.floor(agora().getTime() / 1000);
  const urlBase = (host: string | undefined): string =>
    host ? `http://${host}` : emissor.replace(/\/auth\/v1$/, "");

  const credenciaisInvalidas = (resp: FastifyReply) =>
    erro(resp, 400, "invalid_credentials", "Invalid login credentials");

  app.post("/auth/v1/token", async (req, resp) => {
    const { grant_type: tipo } = (req.query ?? {}) as { grant_type?: string };
    const corpo = (req.body ?? {}) as Record<string, unknown>;

    if (tipo === "password") {
      const email = typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
      const senha = typeof corpo.password === "string" ? corpo.password : "";
      const ref = contas.get(email);
      // Sempre calcula o scrypt (conta desconhecida usa hash falso) para não revelar quais e-mails existem.
      const confere = await senhaConfere(senha, ref ?? hashFalso);
      if (!ref || !confere) return credenciaisInvalidas(resp);
      const usuario = await buscarUsuario("email", email);
      if (!usuario) return credenciaisInvalidas(resp);
      return resp
        .code(200)
        .send(
          await criarSessao(usuario, randomUUID(), "aal1", [
            { method: "password", timestamp: segundosAgora() },
          ]),
        );
    }

    if (tipo === "refresh_token") {
      const token = typeof corpo.refresh_token === "string" ? corpo.refresh_token : "";
      const chaveToken = hashDoToken(token);
      const sessao = refreshTokens.get(chaveToken);
      refreshTokens.delete(chaveToken); // uso único
      const usuario = sessao ? await buscarUsuario("auth_user_id", sessao.authUserId) : null;
      if (!sessao || !usuario) {
        return erro(
          resp,
          400,
          "refresh_token_not_found",
          "Invalid Refresh Token: Refresh Token Not Found",
        );
      }
      return resp
        .code(200)
        .send(await criarSessao(usuario, sessao.sessionId, sessao.aal, sessao.amr));
    }

    return erro(resp, 400, "validation_failed", "unsupported_grant_type");
  });

  app.get("/auth/v1/user", async (req, resp) => {
    const sub = await sujeitoDoBearer(req.headers.authorization);
    const usuario = sub ? await buscarUsuario("auth_user_id", sub) : null;
    if (!usuario) return erro(resp, 401, "bad_jwt", "invalid JWT");
    return resp.code(200).send(objetoUser(usuario));
  });

  app.post("/auth/v1/logout", async (req, resp) => {
    const sub = await sujeitoDoBearer(req.headers.authorization);
    if (!sub) return erro(resp, 401, "bad_jwt", "invalid JWT");
    for (const [k, s] of refreshTokens) if (s.authUserId === sub) refreshTokens.delete(k);
    return resp.code(204).send();
  });

  // Convite de conta (API admin): exige a chave de servidor local. Cria a conta sem senha e imprime o link.
  app.post("/auth/v1/invite", async (req, resp) => {
    if (!ehChaveServico(req.headers.authorization))
      return erro(resp, 401, "not_admin", "User not allowed");
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
    const destino = destinoPermitido((req.query as { redirect_to?: string }).redirect_to);
    if (!email || !destino) return erro(resp, 400, "validation_failed", "Invalid request");
    if (contas.has(email)) {
      return erro(
        resp,
        422,
        "email_exists",
        "A user with this email address has already been registered",
      );
    }
    const { rows } = await db.query<{ auth_user_id: string | null }>(
      "select auth_user_id::text as auth_user_id from usuarios where email = $1 and ativo",
      [email],
    );
    if (!rows[0])
      return erro(resp, 400, "validation_failed", "Usuário não cadastrado na API (modo local)");
    const authUserId = rows[0].auth_user_id ?? convidados.get(email) ?? randomUUID();
    convidados.set(email, authUserId);
    imprimir(
      `[auth-local] Convite para ${email}: ${gerarLink(urlBase(req.headers.host), { authUserId, email, tipo: "invite" }, destino)}`,
    );
    const criado = agora().toISOString();
    return resp.code(200).send({
      id: authUserId,
      aud: "authenticated",
      role: "authenticated",
      email,
      invited_at: criado,
      created_at: criado,
      updated_at: criado,
    });
  });

  // Remoção de conta (API admin): apaga a conta, os fatores MFA e as sessões. Idempotente (a API
  // chama depois de anonimizar o usuário no banco, então o e-mail pode já não estar mais lá).
  app.delete("/auth/v1/admin/users/:id", async (req, resp) => {
    if (!ehChaveServico(req.headers.authorization))
      return erro(resp, 401, "not_admin", "User not allowed");
    const id = (req.params as { id: string }).id;
    const { rows } = await db.query<{ email: string }>(
      "select email from usuarios where auth_user_id::text = $1",
      [id],
    );
    if (rows[0]) contas.delete(rows[0].email.toLowerCase());
    for (const [e, v] of convidados) if (v === id) convidados.delete(e);
    fatores.delete(id);
    for (const [k, d] of desafios) if (d.authUserId === id) desafios.delete(k);
    for (const [k, s] of refreshTokens) if (s.authUserId === id) refreshTokens.delete(k);
    return resp.code(200).send({});
  });

  // Redefinição de senha: resposta igual exista ou não a conta (não revela e-mails).
  app.post("/auth/v1/recover", async (req, resp) => {
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const email = typeof corpo.email === "string" ? corpo.email.trim().toLowerCase() : "";
    const destino = destinoPermitido((req.query as { redirect_to?: string }).redirect_to);
    if (!email || !destino) return erro(resp, 400, "validation_failed", "Invalid request");
    const { rows } = await db.query<{ auth_user_id: string | null }>(
      "select auth_user_id::text as auth_user_id from usuarios where email = $1 and ativo",
      [email],
    );
    const authUserId = rows[0] ? (rows[0].auth_user_id ?? convidados.get(email) ?? null) : null;
    if (authUserId) {
      const link = gerarLink(
        urlBase(req.headers.host),
        { authUserId, email, tipo: "recovery" },
        destino,
      );
      imprimir(`[auth-local] Redefinição de senha para ${email}: ${link}`);
    }
    return resp.code(200).send({});
  });

  // Abre o link do e-mail: valida o token (uso único) e volta ao front com a sessão no fragmento.
  app.get("/auth/v1/verify", async (req, resp) => {
    const q = req.query as { token?: string; type?: string; redirect_to?: string };
    const destino = destinoPermitido(q.redirect_to);
    if (!destino) return erro(resp, 400, "validation_failed", "redirect_to não permitido");
    const chaveLink = hashDoToken(q.token ?? "");
    const link = linksEmail.get(chaveLink);
    linksEmail.delete(chaveLink);
    const rows = link
      ? (
          await db.query<{ criado_em: Date }>(
            "select criado_em from usuarios where email = $1 and ativo",
            [link.email],
          )
        ).rows
      : [];
    if (!link || !rows[0] || link.tipo !== q.type || link.expiraEm < agora().getTime()) {
      const falha = new URLSearchParams({
        error: "access_denied",
        error_code: "otp_expired",
        error_description: "Email link is invalid or has expired",
      });
      return resp.redirect(`${destino}#${falha.toString()}`, 302);
    }
    // Como no Supabase, a conta passa a existir no Auth: amarra o login ao cadastro se ainda não estiver.
    await db.query(
      "update usuarios set auth_user_id = $1 where email = $2 and auth_user_id is null",
      [link.authUserId, link.email],
    );
    const sessao = await criarSessao(
      { auth_user_id: link.authUserId, email: link.email, criado_em: rows[0].criado_em },
      randomUUID(),
      "aal1",
      [{ method: "otp", timestamp: segundosAgora() }],
    );
    const frag = new URLSearchParams({
      access_token: sessao.access_token,
      refresh_token: sessao.refresh_token,
      expires_in: String(VALIDADE_SEGUNDOS),
      token_type: "bearer",
      type: link.tipo,
    });
    return resp.redirect(`${destino}#${frag.toString()}`, 302);
  });

  // Troca a senha da sessão (usada após convite ou redefinição).
  app.put("/auth/v1/user", async (req, resp) => {
    const sub = await sujeitoDoBearer(req.headers.authorization);
    const usuario = sub ? await buscarUsuario("auth_user_id", sub) : null;
    if (!usuario) return erro(resp, 401, "bad_jwt", "invalid JWT");
    const senha = ((req.body ?? {}) as Record<string, unknown>).password;
    if (typeof senha !== "string" || senha.length < 6) {
      return erro(resp, 422, "weak_password", "Password should be at least 6 characters.");
    }
    contas.set(usuario.email.toLowerCase(), await hashDaSenha(senha));
    return resp.code(200).send(objetoUser(usuario));
  });

  // --- MFA (TOTP) ---

  async function usuarioAutenticado(req: { headers: { authorization?: string } }) {
    const claims = await claimsDoBearer(req.headers.authorization);
    const usuario = claims ? await buscarUsuario("auth_user_id", claims.sub) : null;
    return claims && usuario ? { claims, usuario } : null;
  }

  function acharFator(authUserId: string, id: string): FatorMfa | undefined {
    return (fatores.get(authUserId) ?? []).find((f) => f.id === id);
  }

  app.post("/auth/v1/factors", async (req, resp) => {
    const ctx = await usuarioAutenticado(req);
    if (!ctx) return erro(resp, 401, "bad_jwt", "invalid JWT");
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    if (corpo.factor_type !== "totp")
      return erro(resp, 422, "validation_failed", "Only totp factors are supported");
    const { usuario } = ctx;
    const existentes = fatores.get(usuario.auth_user_id) ?? [];
    if (existentes.length >= MAX_FATORES) {
      return erro(
        resp,
        422,
        "too_many_enrolled_mfa_factors",
        "Maximum number of enrolled factors reached",
      );
    }
    const issuer =
      typeof corpo.issuer === "string" && corpo.issuer.trim() !== ""
        ? corpo.issuer.trim().slice(0, 100)
        : ISSUER_PADRAO;
    const nome =
      typeof corpo.friendly_name === "string" && corpo.friendly_name.trim() !== ""
        ? corpo.friendly_name.trim().slice(0, 100)
        : null;
    if (nome !== null && existentes.some((f) => f.friendly_name === nome)) {
      return erro(
        resp,
        422,
        "mfa_factor_name_conflict",
        "A factor with the friendly name already exists",
      );
    }
    const id = randomUUID();
    const segredo = novoSegredoTotp();
    const agoraDate = agora();
    const fator: FatorMfa = {
      id,
      friendly_name: nome ?? `Fator ${id.slice(0, 8)}`,
      factor_type: "totp",
      status: "unverified",
      segredo,
      criado: agoraDate,
      atualizado: agoraDate,
      ultimoPassoUsado: null,
    };
    fatores.set(usuario.auth_user_id, [...existentes, fator]);
    const b32 = base32Codificar(segredo);
    const uri =
      `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(usuario.email)}` +
      `?secret=${b32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
    // O cliente monta "data:image/svg+xml;utf-8," + qr_code sem codificar: o SVG não pode ter "#" (cores nomeadas).
    const qr = renderSVG(uri, { whiteColor: "white", blackColor: "black" });
    return resp.code(200).send({
      id,
      type: "totp",
      friendly_name: fator.friendly_name,
      totp: { qr_code: qr, secret: b32, uri },
    });
  });

  app.post("/auth/v1/factors/:id/challenge", async (req, resp) => {
    const ctx = await usuarioAutenticado(req);
    if (!ctx) return erro(resp, 401, "bad_jwt", "invalid JWT");
    const fator = acharFator(ctx.usuario.auth_user_id, (req.params as { id: string }).id);
    if (!fator) return erro(resp, 404, "mfa_factor_not_found", "MFA factor not found");
    const expiraEm = agora().getTime() + VALIDADE_DESAFIO_MS;
    const desafio: DesafioMfa = {
      id: randomUUID(),
      factorId: fator.id,
      authUserId: ctx.usuario.auth_user_id,
      expiraEm,
    };
    desafios.set(desafio.id, desafio);
    return resp
      .code(200)
      .send({ id: desafio.id, type: "totp", expires_at: Math.floor(expiraEm / 1000) });
  });

  // Divergência consciente do GoTrue: desafio inexistente responde 404 mfa_challenge_not_found (o GoTrue usa 422 em alguns casos).
  app.post("/auth/v1/factors/:id/verify", async (req, resp) => {
    const ctx = await usuarioAutenticado(req);
    if (!ctx) return erro(resp, 401, "bad_jwt", "invalid JWT");
    const { usuario, claims } = ctx;
    const fator = acharFator(usuario.auth_user_id, (req.params as { id: string }).id);
    if (!fator) return erro(resp, 404, "mfa_factor_not_found", "MFA factor not found");
    const corpo = (req.body ?? {}) as Record<string, unknown>;
    const idDesafio = typeof corpo.challenge_id === "string" ? corpo.challenge_id : "";
    const codigo = typeof corpo.code === "string" ? corpo.code : "";
    const desafio = desafios.get(idDesafio);
    if (!desafio || desafio.factorId !== fator.id || desafio.authUserId !== usuario.auth_user_id) {
      return erro(resp, 404, "mfa_challenge_not_found", "MFA challenge not found");
    }
    if (desafio.expiraEm < agora().getTime()) {
      desafios.delete(desafio.id);
      return erro(
        resp,
        422,
        "mfa_challenge_expired",
        "MFA challenge has expired, verify against another challenge or create a new challenge.",
      );
    }
    const passo = verificarTotp(fator.segredo, codigo, agora().getTime());
    // Mesmo passo (ou anterior) já usado: recusa, para o código não valer duas vezes.
    if (passo === null || (fator.ultimoPassoUsado !== null && passo <= fator.ultimoPassoUsado)) {
      return erro(resp, 422, "mfa_verification_failed", "Invalid TOTP code entered");
    }
    fator.ultimoPassoUsado = passo;
    fator.status = "verified";
    fator.atualizado = agora();
    desafios.delete(desafio.id);
    const ts = segundosAgora();
    const base = claims.amr.length > 0 ? claims.amr : [{ method: "password", timestamp: ts }];
    const sessao = await criarSessao(usuario, claims.sessionId, "aal2", [
      ...base.filter((a) => a.method !== "totp"),
      { method: "totp", timestamp: ts },
    ]);
    return resp.code(200).send(sessao);
  });

  app.delete("/auth/v1/factors/:id", async (req, resp) => {
    const ctx = await usuarioAutenticado(req);
    if (!ctx) return erro(resp, 401, "bad_jwt", "invalid JWT");
    const { usuario, claims } = ctx;
    const fator = acharFator(usuario.auth_user_id, (req.params as { id: string }).id);
    if (!fator) return erro(resp, 404, "mfa_factor_not_found", "MFA factor not found");
    // Como no GoTrue: remover fator verificado exige sessão aal2.
    if (fator.status === "verified" && claims.aal !== "aal2") {
      return erro(resp, 403, "insufficient_aal", "AAL2 required to unenroll verified factor");
    }
    fatores.set(
      usuario.auth_user_id,
      (fatores.get(usuario.auth_user_id) ?? []).filter((f) => f.id !== fator.id),
    );
    for (const [k, d] of desafios) if (d.factorId === fator.id) desafios.delete(k);
    return resp.code(200).send({ id: fator.id });
  });

  app.get("/auth/v1/health", () => ({ status: "ok", name: "auth-local" }));

  return app;
}

/** Preenche usuarios.auth_user_id (UUID novo) das contas de teste que ainda não têm. Só no banco local. */
export async function vincularContasLocais(
  db: Db,
  contas: ContaDemo[] = CONTAS_DEMO,
): Promise<string[]> {
  const vinculadas: string[] = [];
  for (const c of contas) {
    const r = await db.query(
      "update usuarios set auth_user_id = $1 where email = $2 and auth_user_id is null returning id",
      [randomUUID(), c.email.toLowerCase()],
    );
    if (r.rows.length > 0) vinculadas.push(c.email);
  }
  return vinculadas;
}

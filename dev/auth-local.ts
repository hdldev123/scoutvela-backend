import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import { SignJWT, jwtVerify } from "jose";
import type { Db } from "../src/db/db.js";
import { CONTAS_DEMO, type ContaDemo } from "../seed/contas-demo.js";

/**
 * Emulador mínimo do Supabase Auth (GoTrue) SÓ PARA DESENVOLVIMENTO: deixa o
 * front usar o @supabase/supabase-js real sem projeto Supabase. Nunca importe
 * este arquivo de src/. Não loga senha, token nem corpo de requisição.
 */

const scryptAsync = promisify(scrypt) as (senha: string, sal: Buffer, tamanho: number) => Promise<Buffer>;
const VALIDADE_SEGUNDOS = 3600;

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

interface SessaoRefresh {
  authUserId: string;
  sessionId: string;
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
  if (opcoes.jwtSecret.length < 32) throw new Error("O segredo JWT local precisa ter ao menos 32 caracteres.");

  const { db } = opcoes;
  const agora = opcoes.agora ?? (() => new Date());
  const emissor = `${opcoes.supabaseUrl.replace(/\/+$/, "")}/auth/v1`;
  const chave = new TextEncoder().encode(opcoes.jwtSecret);

  // Hash scrypt calculado na inicialização: a senha em texto puro não fica guardada para comparação.
  const contas = new Map<string, SenhaComHash>();
  for (const c of opcoes.contas ?? CONTAS_DEMO) contas.set(c.email.toLowerCase(), await hashDaSenha(c.senha));
  const hashFalso = await hashDaSenha(randomBytes(12).toString("hex"));

  // Refresh tokens ficam só em memória, indexados pelo SHA-256 (uso único).
  const refreshTokens = new Map<string, SessaoRefresh>();

  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  await app.register(cors, {
    origin: opcoes.origens,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["authorization", "apikey", "content-type", "x-client-info", "x-supabase-api-version"],
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
    };
  }

  async function buscarUsuario(filtro: "email" | "auth_user_id", valor: string): Promise<UsuarioAuth | null> {
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

  async function criarSessao(u: UsuarioAuth, sessionId: string) {
    const emitidoEm = Math.floor(agora().getTime() / 1000);
    const expiraEm = emitidoEm + VALIDADE_SEGUNDOS;
    const accessToken = await new SignJWT({
      email: u.email,
      role: "authenticated",
      session_id: sessionId,
      aal: "aal1",
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
      refresh_token: novoRefresh({ authUserId: u.auth_user_id, sessionId }),
      user: objetoUser(u),
    };
  }

  /** Valida o Bearer (assinatura, emissor, audiência, validade) e devolve o auth_user_id. */
  async function sujeitoDoBearer(cabecalho: string | undefined): Promise<string | null> {
    const m = /^Bearer (\S+)$/.exec(cabecalho ?? "");
    if (!m) return null;
    try {
      const { payload } = await jwtVerify(m[1]!, chave, {
        issuer: emissor,
        audience: "authenticated",
        algorithms: ["HS256"],
        currentDate: agora(),
      });
      return typeof payload.sub === "string" && payload.sub !== "" ? payload.sub : null;
    } catch {
      return null;
    }
  }

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
      return resp.code(200).send(await criarSessao(usuario, randomUUID()));
    }

    if (tipo === "refresh_token") {
      const token = typeof corpo.refresh_token === "string" ? corpo.refresh_token : "";
      const chaveToken = hashDoToken(token);
      const sessao = refreshTokens.get(chaveToken);
      refreshTokens.delete(chaveToken); // uso único
      const usuario = sessao ? await buscarUsuario("auth_user_id", sessao.authUserId) : null;
      if (!sessao || !usuario) {
        return erro(resp, 400, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found");
      }
      return resp.code(200).send(await criarSessao(usuario, sessao.sessionId));
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

  app.get("/auth/v1/health", async () => ({ status: "ok", name: "auth-local" }));

  return app;
}

/** Preenche usuarios.auth_user_id (UUID novo) das contas de teste que ainda não têm. Só no banco local. */
export async function vincularContasLocais(db: Db, contas: ContaDemo[] = CONTAS_DEMO): Promise<string[]> {
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

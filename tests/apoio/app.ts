import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { criarApp } from "../../src/app.js";
import { criarVerificadorSupabase } from "../../src/auth/jwt.js";
import { lerConfig, type Config } from "../../src/config.js";
import type { Db } from "../../src/db/db.js";
import type { ProvedorEmail } from "../../src/email/index.js";
import { ContaJaExiste, type AdminAuth } from "../../src/integracoes/supabase-admin.js";
import type { Papel } from "../../src/domain/tipos.js";
import { criarArmazenamentoFake } from "./armazenamento.js";
import type { ArmazenamentoEvidencias } from "../../src/storage/index.js";

export const SUPABASE_URL_TESTE = "http://supabase.teste";
export const SEGREDO_JWT_TESTE = "segredo-de-teste-com-pelo-menos-32-caracteres!!";
export const ORIGEM_PERMITIDA_TESTE = "http://localhost:5173";

/** Config de teste: os padrões vêm do próprio esquema (lerConfig), então variáveis novas não quebram os testes. */
export function configDeTeste(parcial: Partial<Config> = {}): Config {
  return {
    ...lerConfig({
      APP_ENV: "desenvolvimento",
      HOST: "127.0.0.1",
      PORT: "3333",
      DATABASE_URL: "nao-usado",
      SUPABASE_URL: SUPABASE_URL_TESTE,
      SUPABASE_JWT_SECRET: SEGREDO_JWT_TESTE,
      CORS_ORIGINS: ORIGEM_PERMITIDA_TESTE,
    }),
    PORT: 0,
    ...parcial,
  };
}

export interface OpcoesAppDeTeste {
  config?: Partial<Config>;
  agora?: () => Date;
  limiteRequisicoes?: { max: number; janelaMs: number };
  /** Padrão: armazenamento em memória (nunca grava em disco). */
  armazenamento?: ArmazenamentoEvidencias;
  adminAuth?: AdminAuth | null;
  email?: ProvedorEmail;
}

/** App completo sobre o banco de teste, com verificador HS256 real. */
export async function criarAppDeTeste(
  db: Db,
  opcoes: OpcoesAppDeTeste = {},
): Promise<FastifyInstance> {
  const config = configDeTeste(opcoes.config);
  const app = await criarApp({
    db,
    config,
    verificarToken: criarVerificadorSupabase({
      supabaseUrl: config.SUPABASE_URL,
      jwtSecret: config.SUPABASE_JWT_SECRET,
    }),
    ...(opcoes.agora ? { agora: opcoes.agora } : {}),
    ...(opcoes.limiteRequisicoes ? { limiteRequisicoes: opcoes.limiteRequisicoes } : {}),
    armazenamento: opcoes.armazenamento ?? criarArmazenamentoFake(),
    ...(opcoes.adminAuth !== undefined ? { adminAuth: opcoes.adminAuth } : {}),
    ...(opcoes.email ? { email: opcoes.email } : {}),
    logger: false,
  });
  await app.ready();
  return app;
}

export interface OpcoesToken {
  segredo?: string;
  issuer?: string;
  audience?: string;
  /** Expiração: instante absoluto (Date) ou texto do jose (ex.: "1h"). */
  expiraEm?: Date | string;
  email?: string;
  /** Nível de garantia da sessão (claim aal). Padrão: ausente. */
  aal?: "aal1" | "aal2";
}

/** Assina um JWT no formato do Supabase Auth, só para testes. */
export async function tokenPara(authUserId: string, opcoes: OpcoesToken = {}): Promise<string> {
  const exp = opcoes.expiraEm ?? "1h";
  return new SignJWT({
    ...(opcoes.email ? { email: opcoes.email } : {}),
    ...(opcoes.aal ? { aal: opcoes.aal } : {}),
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(authUserId)
    .setIssuer(opcoes.issuer ?? `${SUPABASE_URL_TESTE}/auth/v1`)
    .setAudience(opcoes.audience ?? "authenticated")
    .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
    .setExpirationTime(exp instanceof Date ? Math.floor(exp.getTime() / 1000) : exp)
    .sign(new TextEncoder().encode(opcoes.segredo ?? SEGREDO_JWT_TESTE));
}

export function cabecalhoAuth(token: string): { authorization: string } {
  return { authorization: `Bearer ${token}` };
}

/** Cria classe e atleta mínimos (o banco de teste não tem seed). Devolve o id do atleta. */
export async function criarAtletaDeTeste(db: Db, nome = "Atleta Teste"): Promise<string> {
  await db.query(
    `insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
     values ('classe_teste', 'Classe Teste', 'Evento Teste', 'ind', 60, 70, 80, 9999)
     on conflict (id) do nothing`,
  );
  const r = await db.query<{ id: string }>(
    `insert into atletas (velaid_codigo, nome, genero, data_nascimento, classe_id)
     values ($1, $2, 'F', '2000-01-01', 'classe_teste') returning id`,
    [`VELA-${crypto.randomUUID().slice(0, 8)}`, nome],
  );
  return r.rows[0]!.id;
}

export interface UsuarioDeTeste {
  id: string;
  authUserId: string;
  atletaId: string | null;
}

/** Insere um usuário com papel. Papel atleta cria o atleta vinculado automaticamente. */
export async function criarUsuarioDeTeste(
  db: Db,
  opcoes: { papel: Papel; nome?: string; authUserId?: string; ativo?: boolean; atletaId?: string },
): Promise<UsuarioDeTeste> {
  const authUserId = opcoes.authUserId ?? crypto.randomUUID();
  const nome = opcoes.nome ?? `Usuário ${opcoes.papel}`;
  const atletaId =
    opcoes.atletaId ?? (opcoes.papel === "atleta" ? await criarAtletaDeTeste(db, nome) : null);
  const r = await db.query<{ id: string }>(
    `insert into usuarios (auth_user_id, email, nome, papel, atleta_id, ativo)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      authUserId,
      `${opcoes.papel}-${authUserId.slice(0, 8)}@teste.dev`,
      nome,
      opcoes.papel,
      atletaId,
      opcoes.ativo ?? true,
    ],
  );
  return { id: r.rows[0]!.id, authUserId, atletaId };
}

export interface AdminAuthFalso extends AdminAuth {
  convites: { email: string; redirectTo: string; authUserId: string }[];
  /** E-mails que já têm conta no Auth (convidar lança ContaJaExiste). */
  contasExistentes: Set<string>;
  /** Quando preenchido, convidar falha com este erro genérico. */
  falhar: boolean;
  /** ids de conta removidos com sucesso. */
  removidas: string[];
  /** Quando true, removerConta falha. */
  falharRemocao: boolean;
}

/** AdminAuth em memória, só para testes. */
export function criarAdminAuthFalso(): AdminAuthFalso {
  const falso: AdminAuthFalso = {
    convites: [],
    contasExistentes: new Set(),
    falhar: false,
    removidas: [],
    falharRemocao: false,
    async removerConta(authUserId) {
      if (falso.falharRemocao) throw new Error("falha simulada");
      falso.removidas.push(authUserId);
    },
    async convidar(email, redirectTo) {
      if (falso.falhar) throw new Error("falha simulada");
      if (falso.contasExistentes.has(email)) throw new ContaJaExiste();
      const authUserId = crypto.randomUUID();
      falso.convites.push({ email, redirectTo, authUserId });
      return { authUserId };
    },
  };
  return falso;
}

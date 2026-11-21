import { createRemoteJWKSet, jwtVerify } from "jose";

export interface ClaimsVerificados {
  sub: string;
  email?: string;
  /**
   * E-mail confirmado, quando o token informa: `user_metadata.email_verified` do Supabase Auth
   * (ou `email_verified` no topo). Ausente = o token não diz; `false` = o e-mail NÃO foi confirmado.
   */
  emailVerificado?: boolean;
  /** Nível de garantia da sessão: aal2 = passou pelo segundo fator. Ausente = aal1. */
  aal?: "aal1" | "aal2";
}

export type VerificadorToken = (token: string) => Promise<ClaimsVerificados>;

/**
 * Verifica o JWT de sessão do Supabase Auth.
 * Com `jwtSecret` (projeto com chave legada) valida HS256; sem ele, valida pela
 * chave pública do projeto (JWKS), usada pelos projetos novos.
 */
export function criarVerificadorSupabase(opcoes: {
  supabaseUrl: string;
  jwtSecret?: string | undefined;
}): VerificadorToken {
  const base = opcoes.supabaseUrl.replace(/\/+$/, "");
  const issuer = `${base}/auth/v1`;
  const audience = "authenticated";

  const chave = opcoes.jwtSecret ? new TextEncoder().encode(opcoes.jwtSecret) : null;
  const jwks = chave ? null : createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));

  return async (token) => {
    const { payload } = chave
      ? await jwtVerify(token, chave, { issuer, audience, algorithms: ["HS256"] })
      : await jwtVerify(token, jwks!, {
          issuer,
          audience,
          algorithms: ["ES256", "RS256", "EdDSA"],
        });
    if (typeof payload.sub !== "string" || payload.sub === "") throw new Error("Token sem sub");
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const aal = payload.aal === "aal2" ? "aal2" : "aal1";
    const meta = payload.user_metadata;
    const declarado =
      typeof payload.email_verified === "boolean"
        ? payload.email_verified
        : meta && typeof meta === "object" && "email_verified" in meta
          ? (meta as { email_verified?: unknown }).email_verified
          : undefined;
    return {
      sub: payload.sub,
      ...(email === undefined ? {} : { email }),
      ...(typeof declarado === "boolean" ? { emailVerificado: declarado } : {}),
      aal,
    };
  };
}

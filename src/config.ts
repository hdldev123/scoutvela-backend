import { existsSync } from "node:fs";
import { z } from "zod";

/** Em desenvolvimento lê o .env local. No Render as variáveis vêm do painel. */
export function carregarEnvLocal(arquivo = ".env"): void {
  if (existsSync(arquivo)) process.loadEnvFile(arquivo);
}

const esquemaConfig = z.object({
  APP_ENV: z.enum(["desenvolvimento", "homologacao", "producao"]).default("desenvolvimento"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3333),
  DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
  /** Certificado CA do Postgres do Supabase (PEM). Sem ele, conexão sem TLS (só local). */
  DATABASE_CA_CERT: z.string().optional(),
  SUPABASE_URL: z.url("SUPABASE_URL precisa ser uma URL"),
  /** Só para projetos Supabase com chave JWT legada (HS256). Sem ela, valida pelo JWKS do projeto. */
  SUPABASE_JWT_SECRET: z.string().optional(),
  /** Domínios do front liberados no CORS, separados por vírgula. */
  CORS_ORIGINS: z
    .string()
    .default("http://localhost:8080,http://localhost:5173")
    .transform((v) =>
      v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
});

export type Config = z.infer<typeof esquemaConfig>;

export function lerConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const r = esquemaConfig.safeParse(env);
  if (!r.success) {
    const erros = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ");
    throw new Error(`Configuração inválida:\n  ${erros}`);
  }
  return r.data;
}

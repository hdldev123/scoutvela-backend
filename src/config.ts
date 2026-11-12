import { existsSync } from "node:fs";
import { z } from "zod";

/** Em desenvolvimento lê o .env local. No Render as variáveis vêm do painel. */
export function carregarEnvLocal(arquivo = ".env"): void {
  if (existsSync(arquivo)) process.loadEnvFile(arquivo);
}

const booleano = z
  .enum(["true", "false"])
  .default("false")
  .transform((v) => v === "true");

const esquemaConfig = z
  .object({
    APP_ENV: z.enum(["desenvolvimento", "homologacao", "producao"]).default("desenvolvimento"),
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(3333),
    DATABASE_URL: z.string().min(1, "DATABASE_URL é obrigatória"),
    /** Certificado CA do Postgres do Supabase (PEM). Sem ele, conexão sem TLS (só local). */
    DATABASE_CA_CERT: z.string().optional(),
    SUPABASE_URL: z.url("SUPABASE_URL precisa ser uma URL"),
    /** Só para projetos Supabase com chave JWT legada (HS256). Sem ela, valida pelo JWKS do projeto. */
    SUPABASE_JWT_SECRET: z.string().optional(),
    /**
     * Chave de servidor do Supabase: convites de conta e Storage das evidências.
     * Só no Render (nunca no front). Sem ela, convite e Storage do Supabase ficam indisponíveis.
     */
    SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
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
    /** Endereço do front, usado nos links dos e-mails (convite, termo, lembretes, redefinição de senha). */
    FRONT_URL: z.url("FRONT_URL precisa ser uma URL").default("http://localhost:8080"),
    /** Exige segundo fator (aal2) para gestor e IBVAR. Ligado em homologação e produção. */
    EXIGIR_MFA: booleano,
    /** log: só registra o envio (desenvolvimento e testes). smtp: envia de verdade. */
    EMAIL_PROVEDOR: z.enum(["log", "smtp"]).default("log"),
    EMAIL_REMETENTE: z.string().default("Scout Vela <nao-responda@scoutvela.dev>"),
    SMTP_HOST: z.string().optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USUARIO: z.string().optional(),
    SMTP_SENHA: z.string().optional(),
    /** local: disco (só desenvolvimento). supabase: bucket privado no Supabase Storage. */
    STORAGE_PROVEDOR: z.enum(["local", "supabase"]).default("local"),
    STORAGE_BUCKET: z.string().min(1).default("evidencias"),
    STORAGE_DIR_LOCAL: z.string().min(1).default(".dados-locais/evidencias"),
  })
  .superRefine((c, ctx) => {
    if (c.APP_ENV === "desenvolvimento") return;
    // O disco do Render é efêmero: fora do desenvolvimento, evidência vai para o Supabase Storage.
    if (c.STORAGE_PROVEDOR !== "supabase") {
      ctx.addIssue({
        code: "custom",
        path: ["STORAGE_PROVEDOR"],
        message: "use supabase fora do desenvolvimento",
      });
    }
    if (c.STORAGE_PROVEDOR === "supabase" && !c.SUPABASE_SERVICE_ROLE_KEY) {
      ctx.addIssue({
        code: "custom",
        path: ["SUPABASE_SERVICE_ROLE_KEY"],
        message: "obrigatória com STORAGE_PROVEDOR=supabase",
      });
    }
    if (c.EMAIL_PROVEDOR === "smtp" && !c.SMTP_HOST) {
      ctx.addIssue({
        code: "custom",
        path: ["SMTP_HOST"],
        message: "obrigatório com EMAIL_PROVEDOR=smtp",
      });
    }
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

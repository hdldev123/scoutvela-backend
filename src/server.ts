import { criarApp } from "./app.js";
import { criarVerificadorSupabase } from "./auth/jwt.js";
import { carregarEnvLocal, lerConfig } from "./config.js";
import { criarDbPg, type Db } from "./db/db.js";
import { criarProvedorEmail, loggerConsole } from "./email/index.js";
import { criarArmazenamentoDaConfig } from "./storage/index.js";

carregarEnvLocal();
const config = lerConfig();
const db = await criarDbDaConfig();

async function criarDbDaConfig(): Promise<Db> {
  const url = config.DATABASE_URL;
  if (!url.startsWith("pglite:")) return criarDbPg({ url, caCert: config.DATABASE_CA_CERT });
  // Banco local em disco, só para desenvolvimento (npm run dev:local usa isso).
  if (config.APP_ENV !== "desenvolvimento") {
    throw new Error("DATABASE_URL=pglite: só é permitido com APP_ENV=desenvolvimento.");
  }
  const { criarDbPglite } = await import("./db/pglite.js");
  return criarDbPglite(url.slice("pglite:".length) || undefined);
}
const app = await criarApp({
  db,
  config,
  email: criarProvedorEmail(config, loggerConsole),
  armazenamento: criarArmazenamentoDaConfig(config),
  verificarToken: criarVerificadorSupabase({
    supabaseUrl: config.SUPABASE_URL,
    jwtSecret: config.SUPABASE_JWT_SECRET,
  }),
});

let encerrando = false;
async function encerrar(sinal: string): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  app.log.info({ sinal }, "encerrando");
  try {
    await app.close();
    await db.fechar();
    process.exit(0);
  } catch (e) {
    app.log.error({ err: e }, "falha ao encerrar");
    process.exit(1);
  }
}
process.on("SIGTERM", () => void encerrar("SIGTERM"));
process.on("SIGINT", () => void encerrar("SIGINT"));

await app.listen({ host: config.HOST, port: config.PORT });

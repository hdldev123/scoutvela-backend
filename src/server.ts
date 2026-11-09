import { criarApp } from "./app.js";
import { criarVerificadorSupabase } from "./auth/jwt.js";
import { carregarEnvLocal, lerConfig } from "./config.js";
import { criarDbPg } from "./db/db.js";

carregarEnvLocal();
const config = lerConfig();
const db = criarDbPg({ url: config.DATABASE_URL, caCert: config.DATABASE_CA_CERT });
const app = await criarApp({
  db,
  config,
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

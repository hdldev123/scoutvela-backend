import { carregarEnvLocal, lerConfig } from "../config.js";
import { criarDbPg } from "../db/db.js";
import { criarProvedorEmail, loggerConsole } from "../email/index.js";
import { executarLembretes } from "./lembretes.js";

carregarEnvLocal();
const config = lerConfig();
const db = criarDbPg({ url: config.DATABASE_URL, caCert: config.DATABASE_CA_CERT });
let codigo = 0;
try {
  const r = await executarLembretes({
    db,
    email: criarProvedorEmail(config, loggerConsole),
    agora: new Date(),
    frontUrl: config.FRONT_URL,
    log: loggerConsole,
  });
  loggerConsole.info({ ...r }, "job de lembretes finalizado");
} catch (e) {
  console.error("job de lembretes falhou:", e instanceof Error ? e.name : "erro");
  codigo = 1;
} finally {
  await db.fechar();
}
process.exit(codigo);

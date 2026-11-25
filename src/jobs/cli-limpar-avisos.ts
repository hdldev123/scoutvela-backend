import { carregarEnvLocal, lerConfig } from "../config.js";
import { criarDbPg } from "../db/db.js";
import { loggerConsole } from "../email/index.js";
import { limparAvisosAntigos } from "./limpar-avisos.js";

carregarEnvLocal();
const config = lerConfig();
const db = criarDbPg({ url: config.DATABASE_URL, caCert: config.DATABASE_CA_CERT });
let codigo = 0;
try {
  await limparAvisosAntigos({ db, agora: new Date(), log: loggerConsole });
} catch (e) {
  console.error("job de limpeza de avisos falhou:", e instanceof Error ? e.name : "erro");
  codigo = 1;
} finally {
  await db.fechar();
}
process.exit(codigo);

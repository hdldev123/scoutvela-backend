import { carregarEnvLocal, lerConfig } from "../config.js";
import { criarDbPg } from "../db/db.js";
import { loggerConsole } from "../email/index.js";
import { criarArmazenamentoDaConfig } from "../storage/index.js";
import { limparAnexosNaoVinculados } from "./limpar-anexos.js";

carregarEnvLocal();
const config = lerConfig();
const db = criarDbPg({ url: config.DATABASE_URL, caCert: config.DATABASE_CA_CERT });
let codigo = 0;
try {
  const r = await limparAnexosNaoVinculados({
    db,
    armazenamento: criarArmazenamentoDaConfig(config),
    agora: new Date(),
    log: loggerConsole,
  });
  if (r.falhas > 0) codigo = 1;
} catch (e) {
  console.error("job de limpeza de anexos falhou:", e instanceof Error ? e.name : "erro");
  codigo = 1;
} finally {
  await db.fechar();
}
process.exit(codigo);

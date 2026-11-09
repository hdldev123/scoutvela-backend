import { carregarEnvLocal } from "../src/config.js";
import { criarDbPg } from "../src/db/db.js";
import { semear } from "./semear.js";

carregarEnvLocal();
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL é obrigatória.");
  process.exit(1);
}

const db = criarDbPg({ url, caCert: process.env.DATABASE_CA_CERT });
try {
  await semear(db);
  console.log("Seed concluído: 14 atletas fictícios, 5 usuários e 3 ciclos.");
} catch (e) {
  console.error(e instanceof Error ? e.message : "Falha no seed");
  process.exitCode = 1;
} finally {
  await db.fechar();
}

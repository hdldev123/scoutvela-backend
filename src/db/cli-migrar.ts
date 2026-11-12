import { carregarEnvLocal } from "../config.js";
import { criarDbPg } from "./db.js";
import { migrar } from "./migrar.js";

carregarEnvLocal();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL é obrigatória");

const db = criarDbPg({ url, caCert: process.env.DATABASE_CA_CERT });
try {
  const novas = await migrar(db);
  console.log(
    novas.length ? `Migrations aplicadas: ${novas.join(", ")}` : "Banco já está atualizado.",
  );
} finally {
  await db.fechar();
}

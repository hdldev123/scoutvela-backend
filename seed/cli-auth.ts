import { carregarEnvLocal } from "../src/config.js";
import { criarDbPg } from "../src/db/db.js";
import { vincularContasDemo } from "./auth.js";

carregarEnvLocal();
const url = process.env.DATABASE_URL;
const supabaseUrl = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !supabaseUrl || !serviceRoleKey) {
  console.error("Defina DATABASE_URL, SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY.");
  process.exit(1);
}

const db = criarDbPg({ url, caCert: process.env.DATABASE_CA_CERT });
try {
  const emails = await vincularContasDemo({ db, supabaseUrl, serviceRoleKey });
  console.log(`Contas de teste vinculadas: ${emails.join(", ")}`);
} catch (e) {
  console.error(e instanceof Error ? e.message : "Falha ao vincular contas");
  process.exitCode = 1;
} finally {
  await db.fechar();
}

import { parseArgs } from "node:util";
import { carregarEnvLocal } from "../config.js";
import { criarDbPg } from "../db/db.js";
import { criarAdminAuth } from "../integracoes/supabase-admin.js";
import { criarPrimeiroGestor } from "./primeiro-gestor.js";

// Uso: npm run gestor:criar -- --email gestor@instituicao.org --nome "Nome Sobrenome"
carregarEnvLocal();
const { values } = parseArgs({
  options: { email: { type: "string" }, nome: { type: "string" } },
});
const { DATABASE_URL, DATABASE_CA_CERT, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, FRONT_URL } =
  process.env;
if (!DATABASE_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !FRONT_URL) {
  console.error("Defina DATABASE_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e FRONT_URL.");
  process.exit(1);
}
if (!values.email || !values.nome) {
  console.error('Uso: npm run gestor:criar -- --email <e-mail> --nome "<nome>"');
  process.exit(1);
}

const db = criarDbPg({ url: DATABASE_URL, caCert: DATABASE_CA_CERT });
try {
  await criarPrimeiroGestor(
    db,
    criarAdminAuth({ supabaseUrl: SUPABASE_URL, serviceRoleKey: SUPABASE_SERVICE_ROLE_KEY }),
    {
      email: values.email,
      nome: values.nome,
      redirectTo: `${FRONT_URL.replace(/\/+$/, "")}/redefinir-senha`,
    },
  );
  console.log("Gestor criado. O convite foi enviado; a senha é definida pelo link do e-mail.");
} catch (e) {
  console.error(e instanceof Error ? e.message : "Falha ao criar o gestor.");
  process.exitCode = 1;
} finally {
  await db.fechar();
}

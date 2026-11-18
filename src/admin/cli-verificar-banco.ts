import { carregarEnvLocal } from "../config.js";
import { criarDbPg } from "../db/db.js";
import { listarMigrations } from "../db/migrar.js";
import {
  objetosPublicos,
  verificarBanco,
  verificarChavePublica,
  type Verificacao,
} from "./verificar-banco.js";

// Uso: npm run db:verificar (lê o .env). Sai com código 1 se algo falhar.
carregarEnvLocal();
const { DATABASE_URL, DATABASE_CA_CERT, SUPABASE_URL, SUPABASE_ANON_KEY } = process.env;
if (!DATABASE_URL) {
  console.error("Defina DATABASE_URL.");
  process.exit(1);
}

const db = criarDbPg({ url: DATABASE_URL, caCert: DATABASE_CA_CERT });
try {
  const resultado: Verificacao[] = await verificarBanco(db, listarMigrations());
  if (SUPABASE_URL && SUPABASE_ANON_KEY) {
    const anon = await verificarChavePublica({
      supabaseUrl: SUPABASE_URL,
      chavePublica: SUPABASE_ANON_KEY,
      objetos: await objetosPublicos(db),
    });
    const falhas = anon.filter((v) => !v.ok);
    resultado.push(
      ...(falhas.length
        ? falhas
        : [{ nome: "anon", ok: true, detalhe: `${anon.length} tabelas/views sem leitura` }]),
    );
  } else {
    console.log("- anon: pulado (defina SUPABASE_URL e SUPABASE_ANON_KEY)");
  }
  for (const v of resultado) console.log(`${v.ok ? "ok  " : "FALHA"} ${v.nome}: ${v.detalhe}`);
  if (resultado.some((v) => !v.ok)) process.exitCode = 1;
} catch (e) {
  console.error(e instanceof Error ? e.message : "Falha ao verificar o banco.");
  process.exitCode = 1;
} finally {
  await db.fechar();
}

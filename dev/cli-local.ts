import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { criarApp } from "../src/app.js";
import { criarVerificadorSupabase } from "../src/auth/jwt.js";
import { lerConfig } from "../src/config.js";
import { criarAdminAuth } from "../src/integracoes/supabase-admin.js";
import { migrar } from "../src/db/migrar.js";
import { criarDbPglite } from "../src/db/pglite.js";
import { CONTAS_DEMO } from "../seed/contas-demo.js";
import { semear } from "../seed/semear.js";
import { criarAuthLocal, ouvirLocal, vincularContasLocais } from "./auth-local.js";

/** Modo local: PGlite em disco + emulador de Supabase Auth + API, sem Supabase e sem Docker. */

// Este modo só existe em desenvolvimento.
process.env.APP_ENV = "desenvolvimento";

const PORTA_API = 3333;
const PORTA_AUTH = 54321;
const URL_AUTH = `http://127.0.0.1:${PORTA_AUTH}`;
const ORIGENS = ["http://localhost:8080", "http://127.0.0.1:8080", "http://localhost:5173"];

// DADOS_LOCAIS_DIR permite um banco separado (o E2E do front usa um próprio e recria a cada execução).
const pasta = process.env.DADOS_LOCAIS_DIR
  ? resolve(process.env.DADOS_LOCAIS_DIR)
  : join(process.cwd(), ".dados-locais");
const pastaBanco = join(pasta, "banco");
const arquivoSegredo = join(pasta, "segredo-jwt");

mkdirSync(pasta, { recursive: true });
if (process.argv.includes("--recriar")) rmSync(pastaBanco, { recursive: true, force: true });

function segredoLocal(): string {
  if (existsSync(arquivoSegredo)) {
    const atual = readFileSync(arquivoSegredo, "utf8").trim();
    if (atual.length >= 32) return atual;
  }
  const novo = randomBytes(48).toString("hex");
  writeFileSync(arquivoSegredo, novo, { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(arquivoSegredo, 0o600);
  } catch {
    // Windows: a pasta já fica no perfil do usuário.
  }
  return novo;
}
const jwtSecret = segredoLocal();

const db = await criarDbPglite(pastaBanco);
const novas = await migrar(db);
if (novas.length > 0) console.log(`Migrations aplicadas: ${novas.length}`);

const { rows } = await db.query<{ n: string }>("select count(*)::text as n from atletas");
if (Number(rows[0]!.n) === 0) {
  await semear(db);
  console.log("Seed aplicado: 14 atletas fictícios, 5 usuários e 3 ciclos.");
}
await vincularContasLocais(db);

// Chave de servidor só deste processo (nova a cada execução): o emulador a exige em /auth/v1/invite.
const serviceRoleKey = randomBytes(24).toString("hex");

// --mfa: a API passa a exigir aal2 de gestor e IBVAR (os fatores TOTP ficam em memória no emulador).
const exigirMfa = process.argv.includes("--mfa");

const config = lerConfig({
  APP_ENV: "desenvolvimento",
  HOST: "127.0.0.1",
  PORT: String(PORTA_API),
  DATABASE_URL: "pglite:.dados-locais/banco",
  SUPABASE_URL: URL_AUTH,
  SUPABASE_JWT_SECRET: jwtSecret,
  CORS_ORIGINS: ORIGENS.join(","),
  SUPABASE_SERVICE_ROLE_KEY: serviceRoleKey,
  EXIGIR_MFA: exigirMfa ? "true" : "false",
  FRONT_URL: ORIGENS[0]!,
});

const auth = await criarAuthLocal({ db, supabaseUrl: URL_AUTH, jwtSecret, origens: ORIGENS, serviceRoleKey });
const app = await criarApp({
  db,
  config,
  adminAuth: criarAdminAuth({ supabaseUrl: URL_AUTH, serviceRoleKey }),
  verificarToken: criarVerificadorSupabase({ supabaseUrl: URL_AUTH, jwtSecret }),
});

let encerrando = false;
async function encerrar(): Promise<void> {
  if (encerrando) return;
  encerrando = true;
  try {
    await app.close();
    await auth.close();
    await db.fechar();
    process.exit(0);
  } catch {
    process.exit(1);
  }
}
process.on("SIGINT", () => void encerrar());
process.on("SIGTERM", () => void encerrar());

await ouvirLocal(auth, PORTA_AUTH);
await app.listen({ host: "127.0.0.1", port: PORTA_API });

console.log(`
Scout Vela em modo local (dados fictícios, só para desenvolvimento)
  API:            http://127.0.0.1:${PORTA_API}  (docs em /docs)
  Auth emulado:   ${URL_AUTH}

Variáveis do front (vela-front/.env.local):
  VITE_API_URL=http://127.0.0.1:${PORTA_API}
  VITE_SUPABASE_URL=${URL_AUTH}
  VITE_SUPABASE_ANON_KEY=chave-local-dev

MFA: ${exigirMfa ? "exigido para gestor e IBVAR (--mfa). O QR aparece na tela de verificação do front; os fatores somem ao reiniciar." : "desligado (use npm run dev:local -- --mfa para exigir)."}

Convites e redefinição de senha: o "e-mail" não é enviado; o link aparece neste terminal
(linhas [auth-local]). Abra o link no navegador para definir a senha.

Contas de teste:
${CONTAS_DEMO.map((c) => `  ${c.email}  /  ${c.senha}`).join("\n")}

Ctrl+C para encerrar.`);

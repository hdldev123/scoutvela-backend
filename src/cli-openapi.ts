import { writeFileSync } from "node:fs";
import { stringify } from "yaml";
import { criarApp } from "./app.js";
import type { Db } from "./db/db.js";

// Só gera a especificação: nenhuma rota é executada, então o banco nunca é tocado.
const falha = async (): Promise<never> => {
  throw new Error("cli-openapi não acessa o banco");
};
const semBanco: Db = { query: falha, exec: falha, transacao: falha, fechar: falha };

const app = await criarApp({
  db: semBanco,
  config: {
    APP_ENV: "desenvolvimento",
    HOST: "127.0.0.1",
    PORT: 0,
    DATABASE_URL: "nao-usado",
    SUPABASE_URL: "http://supabase.invalid",
    CORS_ORIGINS: [],
  },
  verificarToken: async () => {
    throw new Error("cli-openapi não verifica tokens");
  },
  logger: false,
});
await app.ready();
writeFileSync("openapi.yaml", stringify(app.swagger()));
await app.close();
console.log("openapi.yaml gerado.");

import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("src/server.ts com DATABASE_URL=pglite:", () => {
  it("recusa APP_ENV=producao", () => {
    const r = spawnSync(process.execPath, ["--import", "tsx", "src/server.ts"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 25_000,
      env: {
        ...process.env,
        APP_ENV: "producao",
        DATABASE_URL: "pglite:./.dados-locais/nao-deve-criar",
        SUPABASE_URL: "http://127.0.0.1:54321",
        PORT: "3999",
        STORAGE_PROVEDOR: "supabase",
        SUPABASE_SERVICE_ROLE_KEY: "nao-usada",
      },
    });
    expect(r.status).not.toBe(0);
    expect(`${r.stderr}`).toMatch(/pglite: só é permitido com APP_ENV=desenvolvimento/);
  });
});

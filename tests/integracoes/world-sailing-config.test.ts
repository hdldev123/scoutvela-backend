import { describe, expect, it } from "vitest";
import { lerConfig } from "../../src/config.js";

const base = {
  DATABASE_URL: "nao-usado",
  SUPABASE_URL: "http://supabase.teste",
};
const fora = {
  ...base,
  STORAGE_PROVEDOR: "supabase",
  SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste",
};

describe("configuração da World Sailing (D19)", () => {
  it("padrão: simulado em desenvolvimento e homologação, desligado em produção", () => {
    expect(lerConfig({ ...base, APP_ENV: "desenvolvimento" }).WORLD_SAILING_MODO).toBe("simulado");
    expect(lerConfig({ ...fora, APP_ENV: "homologacao" }).WORLD_SAILING_MODO).toBe("simulado");
    expect(lerConfig({ ...fora, APP_ENV: "producao" }).WORLD_SAILING_MODO).toBe("desligado");
  });

  it("aceita real e desligado; recusa o simulador em produção e modo desconhecido", () => {
    expect(
      lerConfig({ ...base, APP_ENV: "desenvolvimento", WORLD_SAILING_MODO: "real" })
        .WORLD_SAILING_MODO,
    ).toBe("real");
    expect(
      lerConfig({ ...fora, APP_ENV: "producao", WORLD_SAILING_MODO: "real" }).WORLD_SAILING_MODO,
    ).toBe("real");
    expect(() =>
      lerConfig({ ...fora, APP_ENV: "producao", WORLD_SAILING_MODO: "simulado" }),
    ).toThrow(/simulador/);
    expect(() => lerConfig({ ...base, WORLD_SAILING_MODO: "qualquer" })).toThrow();
  });

  it("a URL da API tem padrão e só aceita https://", () => {
    expect(lerConfig(base).WORLD_SAILING_API_URL).toBe("https://datafeed.sailing.org/stats/api");
    expect(() =>
      lerConfig({ ...base, WORLD_SAILING_API_URL: "http://exemplo.invalid/api" }),
    ).toThrow(/https/);
  });
});

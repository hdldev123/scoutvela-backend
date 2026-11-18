import { describe, expect, it } from "vitest";
import { configDeTeste } from "./apoio/app.js";
import { criarProvedorEmail } from "../src/email/index.js";

const log = { info: () => {} };

describe("escolha do provedor de e-mail", () => {
  it("log por padrão: não envia nada e não falha", async () => {
    const p = criarProvedorEmail(configDeTeste(), log);
    await expect(p.enviar({ para: "a@b.dev", assunto: "x", texto: "y" })).resolves.toBeUndefined();
  });

  it("smtp sem host recusa criar o provedor", () => {
    expect(() => criarProvedorEmail(configDeTeste({ EMAIL_PROVEDOR: "smtp" }), log)).toThrow(
      /SMTP_HOST/,
    );
  });

  it("smtp com host cria o provedor sem abrir conexão", () => {
    const p = criarProvedorEmail(
      configDeTeste({ EMAIL_PROVEDOR: "smtp", SMTP_HOST: "smtp.invalido.teste" }),
      log,
    );
    expect(typeof p.enviar).toBe("function");
  });
});

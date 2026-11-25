import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto, type Piloto } from "../apoio/piloto.js";

/**
 * Auditoria de segurança (25/11/2026): provas dos achados de baixa severidade da API.
 * A2: a query string (ex.: `?busca=<nome do atleta>`) não pode ir para o log de acesso.
 * A3: resposta com dado pessoal não pode ficar no cache do navegador nem de proxy.
 */
describe("segurança: logs e cache da API", () => {
  let p: Piloto;
  const linhas: string[] = [];

  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"), {
      destinoLog: { write: (l: string) => void linhas.push(l) },
    });
  });
  afterAll(() => p.encerrar());

  it("A2: o log de acesso não grava a query string (nome buscado é dado pessoal)", async () => {
    const r = await p.app.inject({
      method: "GET",
      url: "/atletas?busca=Helena%20Vasques",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    expect(r.statusCode).toBe(200);
    const log = linhas.join("\n");
    expect(log).toContain("/atletas");
    expect(log).not.toContain("Helena");
    expect(log).not.toContain("busca=");
  });

  it("A3: respostas da API saem com Cache-Control: no-store", async () => {
    for (const url of ["/me", "/atletas", "/health"]) {
      const r = await p.app.inject({
        method: "GET",
        url,
        headers: await p.como(EMAILS_DEMO.gestor),
      });
      expect(r.headers["cache-control"], url).toContain("no-store");
    }
  });
});

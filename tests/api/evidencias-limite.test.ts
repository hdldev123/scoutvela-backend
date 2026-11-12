import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import {
  cabecalhoAuth,
  criarAppDeTeste,
  criarAtletaDeTeste,
  criarUsuarioDeTeste,
  tokenPara,
} from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("evidências: limite de envios por usuário", () => {
  let db: Db;
  let app: FastifyInstance;
  let atletaId: string;
  let cabecalhoA: { authorization: string };
  let cabecalhoB: { authorization: string };

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db);
    atletaId = await criarAtletaDeTeste(db);
    const a = await criarUsuarioDeTeste(db, { papel: "gestor" });
    const b = await criarUsuarioDeTeste(db, { papel: "gestor" });
    cabecalhoA = cabecalhoAuth(await tokenPara(a.authUserId));
    cabecalhoB = cabecalhoAuth(await tokenPara(b.authUserId));
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  // Corpo válido no esquema, mas com assinatura errada: o handler responde 400 (a tentativa conta).
  const enviar = (headers?: { authorization: string }) =>
    app.inject({
      method: "POST",
      url: `/atletas/${atletaId}/evidencias`,
      ...(headers ? { headers } : {}),
      payload: {
        nomeArquivo: "x.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: Buffer.from("nao e pdf").toString("base64"),
      },
    });

  it("sem token: 401, sem gastar a cota nem virar 429", async () => {
    for (let i = 0; i < 25; i++) expect((await enviar()).statusCode).toBe(401);
    expect((await enviar(cabecalhoA)).statusCode).toBe(400);
  });

  it("21ª requisição do mesmo usuário recebe 429 limite_excedido; outro usuário do mesmo IP passa", async () => {
    // A primeira tentativa do teste anterior já contou: faltam 19 para chegar a 20.
    for (let i = 0; i < 19; i++) expect((await enviar(cabecalhoA)).statusCode).toBe(400);
    const bloqueada = await enviar(cabecalhoA);
    expect(bloqueada.statusCode).toBe(429);
    expect(bloqueada.json()).toEqual({
      erro: "limite_excedido",
      mensagem: "Muitas requisições. Aguarde um pouco e tente de novo.",
    });
    expect((await enviar(cabecalhoB)).statusCode).toBe(400);
  });
});

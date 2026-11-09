import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import type { Papel } from "../../src/domain/tipos.js";
import { cabecalhoAuth, criarAppDeTeste, criarUsuarioDeTeste, tokenPara } from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("GET /me", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db);
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const casos: { papel: Papel; telas: string[]; telaInicial: string }[] = [
    {
      papel: "gestor",
      telas: ["ranking", "avaliar", "cadastro", "ciclos", "revisoes", "investimento", "usuarios", "parametros", "auditoria"],
      telaInicial: "ranking",
    },
    { papel: "treinador", telas: ["ranking", "avaliar", "revisoes"], telaInicial: "ranking" },
    { papel: "atleta", telas: ["painel", "ficha"], telaInicial: "painel" },
    { papel: "ibvar", telas: ["investimento", "ranking"], telaInicial: "investimento" },
  ];

  it.each(casos)("devolve telas e tela inicial do papel $papel", async ({ papel, telas, telaInicial }) => {
    const u = await criarUsuarioDeTeste(db, { papel, nome: `Pessoa ${papel}` });
    const r = await app.inject({
      method: "GET",
      url: "/me",
      headers: cabecalhoAuth(await tokenPara(u.authUserId)),
    });
    expect(r.statusCode).toBe(200);
    const corpo = r.json();
    expect(corpo.usuario).toMatchObject({ id: u.id, nome: `Pessoa ${papel}`, papel });
    expect(corpo.telas).toEqual(telas);
    expect(corpo.telaInicial).toBe(telaInicial);
    if (papel === "atleta") {
      expect(corpo.atleta).toEqual({ id: u.atletaId, nome: "Pessoa atleta" });
    } else {
      expect(corpo.atleta).toBeNull();
    }
  });
});

import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarApp } from "../../src/app.js";
import { criarVerificadorSupabase } from "../../src/auth/jwt.js";
import type { Db } from "../../src/db/db.js";
import { criarArmazenamentoFake, type ArmazenamentoFake } from "../apoio/armazenamento.js";
import {
  cabecalhoAuth,
  configDeTeste,
  criarAtletaDeTeste,
  criarUsuarioDeTeste,
  tokenPara,
} from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

/** Db que falha ao gravar em evidencias_anexos (dentro da transação). */
function comFalhaNoInsert(db: Db): Db {
  const embrulhar = (alvo: Db): Db => ({
    query: (sql, params) =>
      /insert into evidencias_anexos/.test(sql)
        ? Promise.reject(Object.assign(new Error("falha simulada"), { code: "XX000" }))
        : alvo.query(sql, params),
    exec: (sql) => alvo.exec(sql),
    transacao: (fn) => alvo.transacao((tx) => fn(embrulhar(tx))),
    fechar: () => alvo.fechar(),
  });
  return embrulhar(db);
}

describe("evidências: rollback do arquivo quando o banco falha", () => {
  let db: Db;
  let app: FastifyInstance;
  let armazenamento: ArmazenamentoFake;
  let atletaId: string;
  let cabecalho: { authorization: string };
  const logs: unknown[][] = [];

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    armazenamento = criarArmazenamentoFake();
    atletaId = await criarAtletaDeTeste(db, "Nome Sigiloso Do Atleta");
    const gestor = await criarUsuarioDeTeste(db, { papel: "gestor" });
    const config = configDeTeste();
    app = await criarApp({
      db: comFalhaNoInsert(db),
      config,
      verificarToken: criarVerificadorSupabase({
        supabaseUrl: config.SUPABASE_URL,
        jwtSecret: config.SUPABASE_JWT_SECRET,
      }),
      armazenamento,
      logger: false,
    });
    // Captura o que a rota registra em req.log.
    app.addHook("onRequest", async (req) => {
      const registro = (...args: unknown[]) => void logs.push(args);
      (req as unknown as { log: unknown }).log = {
        error: registro,
        warn: registro,
        info: registro,
        debug: registro,
        trace: registro,
        fatal: registro,
        child: () => (req as unknown as { log: unknown }).log,
      };
    });
    await app.ready();
    cabecalho = cabecalhoAuth(await tokenPara(gestor.authUserId));
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const enviar = () =>
    app.inject({
      method: "POST",
      url: `/atletas/${atletaId}/evidencias`,
      headers: cabecalho,
      payload: {
        nomeArquivo: "relatorio-confidencial.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: PDF.toString("base64"),
      },
    });

  it("banco falha no insert: o arquivo é removido e a resposta é o erro interno original", async () => {
    armazenamento.falharRemocao = false;
    const r = await enviar();
    expect(r.statusCode).toBe(500);
    expect(r.json().erro).toBe("erro_interno");
    expect(armazenamento.arquivos.size).toBe(0);
    expect(
      (await db.query<{ n: string }>("select count(*)::text as n from evidencias_anexos")).rows[0]!
        .n,
    ).toBe("0");
  });

  it("banco e remoção falham: ainda o erro original, e o log não tem caminho nem nomes", async () => {
    armazenamento.falharRemocao = true;
    logs.length = 0;
    const r = await enviar();
    expect(r.statusCode).toBe(500);
    expect(r.json().erro).toBe("erro_interno");
    // Sem a remoção, o arquivo fica no Storage; o log avisa que há órfão.
    expect(armazenamento.arquivos.size).toBe(1);
    const caminho = [...armazenamento.arquivos.keys()][0]!;

    const orfa = logs.find((a) => (a[0] as { evento?: string })?.evento === "evidencia_orfa");
    expect(orfa).toBeDefined();
    expect(orfa![0]).toEqual({ evento: "evidencia_orfa", erro: "Error" });
    expect(orfa![1]).toBe("falha ao remover arquivo órfão");

    const texto = JSON.stringify(logs);
    expect(texto).not.toContain(caminho);
    expect(texto).not.toContain(caminho.split("/")[1]!);
    expect(texto).not.toContain(atletaId);
    expect(texto).not.toContain("relatorio-confidencial");
    expect(texto).not.toContain("Nome Sigiloso");
    expect(texto).not.toContain("storage fora do ar");
  });
});

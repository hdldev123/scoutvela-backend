import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db/db.js";
import { lerConfig } from "../../src/config.js";
import { configDeTeste, criarAppDeTeste } from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

const UUID = "11111111-1111-4111-8111-111111111111";

describe("upload: sessão e limite por IP antes de ler o corpo", () => {
  let db: Db;
  let app: FastifyInstance;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    app = await criarAppDeTeste(db, { limiteRequisicoes: { max: 5, janelaMs: 60_000 } });
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  it("sem token, corpo maior que o limite da rota vira 401 (o corpo nem é lido)", async () => {
    // Antes: o corpo era lido primeiro e a resposta era 400 (corpo grande demais).
    const grande = JSON.stringify({
      tipoMime: "image/jpeg",
      conteudoBase64: "/9j/" + "A".repeat(4 * 1024 * 1024),
    });
    const r = await app.inject({
      method: "POST",
      url: "/me/foto",
      headers: { "content-type": "application/json" },
      payload: grande,
    });
    expect(r.statusCode).toBe(401);
  });

  it("sem token, várias requisições do mesmo IP chegam a 429 em /me/foto e em evidências", async () => {
    const fotos: number[] = [];
    for (let i = 0; i < 8; i++) {
      fotos.push(
        (
          await app.inject({
            method: "POST",
            url: "/me/foto",
            payload: { tipoMime: "image/jpeg", conteudoBase64: "/9j/AAAA" },
          })
        ).statusCode,
      );
    }
    expect(fotos).toContain(429);
    expect(fotos[0]).toBe(401);

    const ev: number[] = [];
    for (let i = 0; i < 8; i++) {
      ev.push(
        (
          await app.inject({
            method: "POST",
            url: `/atletas/${UUID}/evidencias`,
            payload: {
              nomeArquivo: "a.pdf",
              tipoMime: "application/pdf",
              conteudoBase64: "JVBERi0x",
            },
          })
        ).statusCode,
      );
    }
    expect(ev).toContain(429);
  });
});

describe("TRUST_PROXY_HOPS: o X-Forwarded-For forjado não burla o limite por IP", () => {
  it("sem proxy confiável (padrão em desenvolvimento), IPs forjados no cabeçalho contam como um só", async () => {
    const db = await criarBancoDeTeste();
    const app = await criarAppDeTeste(db, { limiteRequisicoes: { max: 3, janelaMs: 60_000 } });
    const st: number[] = [];
    for (let i = 0; i < 6; i++) {
      st.push(
        (
          await app.inject({
            method: "GET",
            url: "/ranking",
            headers: { "x-forwarded-for": `10.0.0.${i}` },
            remoteAddress: "203.0.113.9",
          })
        ).statusCode,
      );
    }
    expect(st.slice(0, 3)).toEqual([401, 401, 401]);
    expect(st.slice(3)).toEqual([429, 429, 429]);
    await app.close();
    await db.fechar();
  });

  it("com 1 salto (Render), vale o último IP do cabeçalho; os anteriores forjados são ignorados", async () => {
    const db = await criarBancoDeTeste();
    const app = await criarAppDeTeste(db, {
      config: { TRUST_PROXY_HOPS: 1 },
      limiteRequisicoes: { max: 3, janelaMs: 60_000 },
    });
    const st: number[] = [];
    for (let i = 0; i < 6; i++) {
      st.push(
        (
          await app.inject({
            method: "GET",
            url: "/ranking",
            // O cliente forja o começo da lista; o proxy confiável acrescenta o IP real no fim.
            headers: { "x-forwarded-for": `10.0.0.${i}, 198.51.100.7` },
            remoteAddress: "127.0.0.1",
          })
        ).statusCode,
      );
    }
    expect(st.slice(3)).toEqual([429, 429, 429]);
    await app.close();
    await db.fechar();
  });

  it("o padrão da config é 0 em desenvolvimento e 1 em homologação e produção", () => {
    expect(configDeTeste().TRUST_PROXY_HOPS).toBe(0);
    const base = {
      DATABASE_URL: "x",
      SUPABASE_URL: "http://supabase.teste",
      STORAGE_PROVEDOR: "supabase",
      SUPABASE_SERVICE_ROLE_KEY: "k",
    };
    expect(lerConfig({ ...base, APP_ENV: "producao" }).TRUST_PROXY_HOPS).toBe(1);
    expect(lerConfig({ ...base, APP_ENV: "homologacao" }).TRUST_PROXY_HOPS).toBe(1);
    expect(
      lerConfig({ ...base, APP_ENV: "producao", TRUST_PROXY_HOPS: "2" }).TRUST_PROXY_HOPS,
    ).toBe(2);
  });
});

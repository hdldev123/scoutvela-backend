import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  objetosPublicos,
  verificarBanco,
  verificarChavePublica,
} from "../../src/admin/verificar-banco.js";
import type { Db } from "../../src/db/db.js";
import { listarMigrations } from "../../src/db/migrar.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

let db: Db;
beforeAll(async () => {
  db = await criarBancoDeTeste();
});
afterAll(async () => {
  await db.fechar();
});

describe("verificarBanco", () => {
  it("banco migrado: migrations e RLS ok; sem schema storage o bucket falha", async () => {
    const r = await verificarBanco(db, listarMigrations());
    expect(r.find((v) => v.nome === "migrations")).toMatchObject({ ok: true });
    expect(r.find((v) => v.nome === "rls")).toMatchObject({ ok: true });
    expect(r.find((v) => v.nome === "bucket")).toMatchObject({
      ok: false,
      detalhe: expect.stringContaining("storage ausente"),
    });
  });

  it("aponta migration pendente", async () => {
    const r = await verificarBanco(db, [...listarMigrations(), "9999_nova.sql"]);
    expect(r.find((v) => v.nome === "migrations")).toEqual({
      nome: "migrations",
      ok: false,
      detalhe: "pendentes: 9999_nova.sql",
    });
  });

  it("lista tabelas e views do schema public", async () => {
    const objetos = await objetosPublicos(db);
    expect(objetos).toEqual(expect.arrayContaining(["usuarios", "atletas", "sugestao_pendente"]));
  });
});

describe("verificarChavePublica", () => {
  function fetchPorObjeto(respostas: Record<string, { status: number; corpo?: unknown }>) {
    const urls: string[] = [];
    const headers: RequestInit["headers"][] = [];
    const f = (async (url: string | URL | Request, init?: RequestInit) => {
      urls.push(url as string);
      headers.push(init?.headers ?? {});
      const nome = /\/rest\/v1\/([^?]+)/.exec(url as string)![1]!;
      const { status, corpo } = respostas[nome]!;
      return new Response(corpo === undefined ? null : JSON.stringify(corpo), { status });
    }) as typeof fetch;
    return { f, urls, headers };
  }

  it("vazio ou recusado passa; dado lido ou erro do servidor falha", async () => {
    const { f, urls, headers } = fetchPorObjeto({
      vazia: { status: 200, corpo: [] },
      recusada: { status: 401, corpo: { message: "permission denied" } },
      vazou: { status: 200, corpo: [{ id: 1 }] },
      quebrada: { status: 500 },
    });
    const r = await verificarChavePublica({
      supabaseUrl: "https://x.supabase.co/",
      chavePublica: "chave-publica",
      objetos: ["vazia", "recusada", "vazou", "quebrada"],
      fetch: f,
    });
    expect(r.map((v) => [v.nome, v.ok])).toEqual([
      ["anon:vazia", true],
      ["anon:recusada", true],
      ["anon:vazou", false],
      ["anon:quebrada", false],
    ]);
    expect(urls[0]).toBe("https://x.supabase.co/rest/v1/vazia?select=*&limit=1");
    expect(headers[0]).toEqual({ apikey: "chave-publica" });
  });
});

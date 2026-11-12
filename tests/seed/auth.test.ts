import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { vincularContasDemo } from "../../seed/auth.js";
import { CONTAS_DEMO } from "../../seed/contas-demo.js";
import { semear } from "../../seed/semear.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

let db: Db;
beforeAll(async () => {
  db = await criarBancoDeTeste();
  await semear(db);
});
afterAll(async () => {
  await db.fechar();
});

const idDe = (email: string) =>
  `00000000-0000-4000-8000-${createHash("md5").update(email).digest("hex").slice(0, 12)}`;
const CHAVE = "chave-service-role-de-teste";

interface Chamada {
  metodo: string;
  url: string;
  auth: string | null;
  corpo: Record<string, unknown> | null;
}

function fetchFalso(existentes: string[]) {
  const chamadas: Chamada[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = url as string;
    const metodo = init?.method ?? "GET";
    const h = new Headers(init?.headers);
    const corpo = init?.body ? (JSON.parse(init.body as string) as Record<string, unknown>) : null;
    chamadas.push({ metodo, url: u, auth: h.get("authorization"), corpo });
    const json = (status: number, obj: unknown) =>
      new Response(JSON.stringify(obj), {
        status,
        headers: { "Content-Type": "application/json" },
      });
    if (metodo === "POST") {
      const email = corpo!.email as string;
      if (existentes.includes(email))
        return json(422, {
          error_code: "email_exists",
          msg: "A user with this email address has already been registered",
        });
      return json(200, { id: idDe(email), email });
    }
    if (metodo === "GET")
      return json(200, { users: existentes.map((e) => ({ id: idDe(e), email: e })) });
    return json(200, { id: u.split("/").pop() });
  }) as typeof fetch;
  return { f, chamadas };
}

describe("vincularContasDemo", () => {
  it("cria as contas e grava auth_user_id; trata usuário já existente", async () => {
    const existente = "ibvar@scoutvela.dev";
    const { f, chamadas } = fetchFalso([existente]);
    const vinculadas = await vincularContasDemo({
      db,
      supabaseUrl: "http://supabase.teste/",
      serviceRoleKey: CHAVE,
      fetch: f,
    });
    expect(vinculadas).toEqual(CONTAS_DEMO.map((c) => c.email));

    const { rows } = await db.query<{ email: string; auth_user_id: string | null }>(
      "select email, auth_user_id from usuarios where email = any($1) order by email",
      [CONTAS_DEMO.map((c) => c.email)],
    );
    expect(rows).toHaveLength(4);
    for (const r of rows) expect(r.auth_user_id).toBe(idDe(r.email));
    const marcos = await db.query<{ auth_user_id: string | null }>(
      "select auth_user_id from usuarios where email = 'marcos.pires@scoutvela.dev'",
    );
    expect(marcos.rows[0]!.auth_user_id).toBeNull();

    expect(chamadas.every((c) => c.auth === `Bearer ${CHAVE}`)).toBe(true);
    expect(
      chamadas.every((c) => c.url.startsWith("http://supabase.teste/auth/v1/admin/users")),
    ).toBe(true);
    const put = chamadas.find((c) => c.metodo === "PUT")!;
    expect(put.url).toBe(`http://supabase.teste/auth/v1/admin/users/${idDe(existente)}`);
    expect(put.corpo).toMatchObject({ password: "ibvar123" });
    const post = chamadas.find((c) => c.metodo === "POST")!;
    expect(post.corpo).toEqual({
      email: "gestor@scoutvela.dev",
      password: "gestor123",
      email_confirm: true,
    });
  });

  it("erro do Supabase não vaza senha nem chave", async () => {
    const f = (async () => new Response("erro interno", { status: 500 })) as typeof fetch;
    const erro = await vincularContasDemo({
      db,
      supabaseUrl: "http://supabase.teste",
      serviceRoleKey: CHAVE,
      fetch: f,
    }).catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).not.toContain(CHAVE);
    expect((erro as Error).message).not.toMatch(/123/);
  });

  it("recusa produção", async () => {
    const antes = process.env.APP_ENV;
    process.env.APP_ENV = "producao";
    try {
      await expect(
        vincularContasDemo({
          db,
          supabaseUrl: "http://x",
          serviceRoleKey: CHAVE,
          fetch: fetchFalso([]).f,
        }),
      ).rejects.toThrow(/produção/);
    } finally {
      if (antes === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = antes;
    }
  });
});

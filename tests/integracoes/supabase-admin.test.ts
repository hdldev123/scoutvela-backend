import { describe, expect, it } from "vitest";
import { ContaJaExiste, criarAdminAuth } from "../../src/integracoes/supabase-admin.js";

function comResposta(status: number, corpo: unknown) {
  const chamadas: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    chamadas.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(corpo), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, chamadas };
}

describe("cliente admin do Supabase Auth", () => {
  it("convida: POST /auth/v1/invite com a chave de servidor e redirect_to; devolve o id", async () => {
    const { f, chamadas } = comResposta(200, {
      id: "11111111-1111-4111-8111-111111111111",
      email: "a@b.dev",
    });
    const admin = criarAdminAuth({
      supabaseUrl: "https://x.supabase.co/",
      serviceRoleKey: "chave-servico",
      fetch: f,
    });
    const r = await admin.convidar("a@b.dev", "https://app.dev/redefinir-senha");
    expect(r).toEqual({ authUserId: "11111111-1111-4111-8111-111111111111" });
    const c = chamadas[0]!;
    expect(c.url).toBe(
      "https://x.supabase.co/auth/v1/invite?redirect_to=https%3A%2F%2Fapp.dev%2Fredefinir-senha",
    );
    expect(c.init.method).toBe("POST");
    const h = c.init.headers as Record<string, string>;
    expect(h.apikey).toBe("chave-servico");
    expect(h.Authorization).toBe("Bearer chave-servico");
    expect(JSON.parse(c.init.body as string)).toEqual({ email: "a@b.dev" });
  });

  it("e-mail já registrado (422 email_exists) vira ContaJaExiste", async () => {
    const { f } = comResposta(422, {
      code: 422,
      error_code: "email_exists",
      msg: "A user with this email address has already been registered",
    });
    const admin = criarAdminAuth({
      supabaseUrl: "https://x.supabase.co",
      serviceRoleKey: "k",
      fetch: f,
    });
    await expect(admin.convidar("a@b.dev", "https://app.dev/r")).rejects.toBeInstanceOf(
      ContaJaExiste,
    );
  });

  it("outras falhas lançam erro genérico sem e-mail nem chave na mensagem", async () => {
    const { f } = comResposta(500, { msg: "boom a@b.dev" });
    const admin = criarAdminAuth({
      supabaseUrl: "https://x.supabase.co",
      serviceRoleKey: "chave-secreta",
      fetch: f,
    });
    const erro = await admin.convidar("a@b.dev", "https://app.dev/r").catch((e: Error) => e);
    expect(erro).toBeInstanceOf(Error);
    expect(erro).not.toBeInstanceOf(ContaJaExiste);
    expect((erro as Error).message).toBe("Supabase Auth: falha ao convidar (HTTP 500)");
  });

  it("resposta sem id é erro", async () => {
    const { f } = comResposta(200, {});
    const admin = criarAdminAuth({
      supabaseUrl: "https://x.supabase.co",
      serviceRoleKey: "k",
      fetch: f,
    });
    await expect(admin.convidar("a@b.dev", "https://app.dev/r")).rejects.toThrow(/sem id/);
  });
});

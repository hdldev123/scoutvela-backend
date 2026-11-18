import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ErroArmazenamento,
  criarArmazenamentoLocal,
  criarArmazenamentoSupabase,
} from "../../src/storage/index.js";

const CAMINHO = "11111111-1111-4111-8111-111111111111/22222222-2222-4222-8222-222222222222.pdf";

describe("armazenamento Supabase", () => {
  it("envia com a chave de servidor, sem upsert, e monta o link assinado absoluto", async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const fetchFalso = (async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return url.includes("/sign/")
        ? new Response(
            JSON.stringify({ signedURL: `/object/sign/evidencias/${CAMINHO}?token=t` }),
            { status: 200 },
          )
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const s = criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co/",
      chaveServico: "chave",
      bucket: "evidencias",
      fetchImpl: fetchFalso,
      agora: () => new Date("2026-11-06T12:00:00Z"),
    });
    await s.salvar(CAMINHO, new Uint8Array([1, 2]), "application/pdf");
    expect(chamadas[0]!.url).toBe(
      `https://proj.supabase.co/storage/v1/object/evidencias/${CAMINHO}`,
    );
    expect(chamadas[0]!.init.method).toBe("POST");
    expect(chamadas[0]!.init.headers).toMatchObject({
      Authorization: "Bearer chave",
      "x-upsert": "false",
      "Content-Type": "application/pdf",
    });

    const link = await s.linkTemporario(CAMINHO, "application/pdf", "x.pdf");
    expect(chamadas[1]!.url).toBe(
      `https://proj.supabase.co/storage/v1/object/sign/evidencias/${CAMINHO}`,
    );
    expect(JSON.parse(chamadas[1]!.init.body as string)).toEqual({ expiresIn: 300 });
    expect(link).toEqual({
      url: `https://proj.supabase.co/storage/v1/object/sign/evidencias/${CAMINHO}?token=t`,
      expiraEm: "2026-11-06T12:05:00.000Z",
    });
  });

  it("falha do Storage vira erro e caminho fora do padrão é recusado", async () => {
    const s = criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co",
      chaveServico: "k",
      bucket: "evidencias",
      fetchImpl: async () => new Response("erro", { status: 500 }),
    });
    await expect(s.salvar(CAMINHO, new Uint8Array([1]), "application/pdf")).rejects.toThrow();
    await expect(s.salvar("../fora.pdf", new Uint8Array([1]), "application/pdf")).rejects.toThrow();
  });
});

describe("armazenamento Supabase: remover", () => {
  const criar = (fetchImpl: typeof fetch) =>
    criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co/",
      chaveServico: "chave",
      bucket: "evidencias",
      fetchImpl,
    });

  it("chama DELETE no bucket com a lista de prefixos e a chave de servidor", async () => {
    const chamadas: { url: string; init: RequestInit }[] = [];
    const s = criar((async (url: string, init: RequestInit) => {
      chamadas.push({ url, init });
      return new Response("[]", { status: 200 });
    }) as unknown as typeof fetch);
    await s.remover(CAMINHO);
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]!.url).toBe("https://proj.supabase.co/storage/v1/object/evidencias");
    expect(chamadas[0]!.init.method).toBe("DELETE");
    expect(chamadas[0]!.init.headers).toMatchObject({
      Authorization: "Bearer chave",
      apikey: "chave",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(chamadas[0]!.init.body as string)).toEqual({ prefixes: [CAMINHO] });
  });

  it("erro HTTP vira ErroArmazenamento sem o caminho na mensagem; caminho inválido é recusado", async () => {
    const s = criar(async () => new Response("erro", { status: 500 }));
    const erro = await s.remover(CAMINHO).catch((e: unknown) => e);
    expect(erro).toBeInstanceOf(ErroArmazenamento);
    expect((erro as Error).message).toContain("500");
    expect((erro as Error).message).not.toContain(CAMINHO);
    await expect(s.remover("../fora.pdf")).rejects.toThrow(ErroArmazenamento);
  });
});

describe("armazenamento local", () => {
  let dir: string | undefined;
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it("grava no disco, não sobrescreve e devolve data URL", async () => {
    dir = await mkdtemp(join(tmpdir(), "evid-"));
    const s = criarArmazenamentoLocal(dir);
    await s.salvar(CAMINHO, new Uint8Array([0x25, 0x50, 0x44, 0x46]), "application/pdf");
    await expect(s.salvar(CAMINHO, new Uint8Array([1]), "application/pdf")).rejects.toThrow();
    const link = await s.linkTemporario(CAMINHO, "application/pdf", "x.pdf");
    expect(link.url).toBe("data:application/pdf;base64,JVBERg==");
    await expect(s.salvar("../x.pdf", new Uint8Array([1]), "application/pdf")).rejects.toThrow();
  });

  it("remove o arquivo, é idempotente e recusa caminho inválido", async () => {
    dir = dir ?? (await mkdtemp(join(tmpdir(), "evid-")));
    const s = criarArmazenamentoLocal(dir);
    const outro = "33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444.png";
    await s.salvar(outro, new Uint8Array([1]), "image/png");
    await s.remover(outro);
    await expect(s.linkTemporario(outro, "image/png", "x.png")).rejects.toThrow();
    await expect(s.remover(outro)).resolves.toBeUndefined();
    await expect(s.remover("../x.pdf")).rejects.toThrow(ErroArmazenamento);
  });
});

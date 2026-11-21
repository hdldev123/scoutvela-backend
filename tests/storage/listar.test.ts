import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ErroArmazenamento,
  criarArmazenamentoLocal,
  criarArmazenamentoSupabase,
} from "../../src/storage/index.js";

const ATLETA = "11111111-1111-4111-8111-111111111111";
const USUARIO = "33333333-3333-4333-8333-333333333333";
const arq = (n: number, ext = "pdf") => `${n}`.repeat(8) + `-2222-4222-8222-222222222222.${ext}`;

describe("armazenamento Supabase: listar", () => {
  it("lista pelo prefixo, pagina de 100 em 100 e ignora pastas", async () => {
    const chamadas: { url: string; corpo: unknown }[] = [];
    const s = criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co/",
      chaveServico: "chave",
      bucket: "evidencias",
      fetchImpl: (async (url: string, init: RequestInit) => {
        const corpo = JSON.parse(init.body as string) as { offset: number };
        chamadas.push({ url, corpo });
        const total = 130;
        const itens = Array.from(
          { length: Math.max(0, Math.min(100, total - corpo.offset)) },
          (_, i) => ({ name: arq(1 + ((corpo.offset + i) % 9)), id: `id-${corpo.offset + i}` }),
        );
        if (corpo.offset === 100) itens.push({ name: "subpasta", id: null as unknown as string });
        return new Response(JSON.stringify(itens), { status: 200 });
      }) as unknown as typeof fetch,
    });
    const caminhos = await s.listar(`${ATLETA}/`);
    expect(chamadas.map((c) => c.url)).toEqual(
      Array(2).fill("https://proj.supabase.co/storage/v1/object/list/evidencias"),
    );
    expect(chamadas.map((c) => c.corpo)).toEqual([
      { prefix: ATLETA, limit: 100, offset: 0 },
      { prefix: ATLETA, limit: 100, offset: 100 },
    ]);
    expect(caminhos).toHaveLength(130);
    expect(caminhos.every((c) => c.startsWith(`${ATLETA}/`))).toBe(true);
  });

  it("prefixo de fotos, erro de HTTP e prefixo inválido", async () => {
    let corpoEnviado: unknown;
    const ok = criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co",
      chaveServico: "k",
      bucket: "b",
      fetchImpl: (async (_u: string, init: RequestInit) => {
        corpoEnviado = JSON.parse(init.body as string);
        return new Response("[]", { status: 200 });
      }) as unknown as typeof fetch,
    });
    expect(await ok.listar(`fotos/${USUARIO}/`)).toEqual([]);
    expect(corpoEnviado).toEqual({ prefix: `fotos/${USUARIO}`, limit: 100, offset: 0 });
    await expect(ok.listar("../")).rejects.toThrow(ErroArmazenamento);
    await expect(ok.listar(ATLETA)).rejects.toThrow(ErroArmazenamento);

    const quebrado = criarArmazenamentoSupabase({
      supabaseUrl: "https://proj.supabase.co",
      chaveServico: "k",
      bucket: "b",
      fetchImpl: async () => new Response("erro", { status: 500 }),
    });
    await expect(quebrado.listar(`${ATLETA}/`)).rejects.toThrow(ErroArmazenamento);
  });
});

describe("armazenamento local: listar", () => {
  it("lista os arquivos da pasta; pasta que não existe dá lista vazia", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vela-listar-"));
    try {
      const s = criarArmazenamentoLocal(dir);
      await s.salvar(`${ATLETA}/${arq(2)}`, new Uint8Array([1]), "application/pdf");
      await s.salvar(`${ATLETA}/${arq(3)}`, new Uint8Array([1]), "application/pdf");
      await s.salvar(`fotos/${USUARIO}/${arq(4, "jpg")}`, new Uint8Array([1]), "image/jpeg");
      expect((await s.listar(`${ATLETA}/`)).sort()).toEqual(
        [`${ATLETA}/${arq(2)}`, `${ATLETA}/${arq(3)}`].sort(),
      );
      expect(await s.listar(`fotos/${USUARIO}/`)).toEqual([`fotos/${USUARIO}/${arq(4, "jpg")}`]);
      expect(await s.listar(`${USUARIO}/`)).toEqual([]);
      await expect(s.listar("../../")).rejects.toThrow(ErroArmazenamento);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

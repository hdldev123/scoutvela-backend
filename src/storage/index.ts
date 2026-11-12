import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { Config } from "../config.js";

export interface LinkTemporario {
  url: string;
  /** Instante ISO em que o link deixa de valer. */
  expiraEm: string;
}

/** Guarda os arquivos das evidências. O caminho é sempre `${atletaId}/${uuid}.${ext}`. */
export interface ArmazenamentoEvidencias {
  salvar(caminho: string, bytes: Uint8Array, tipoMime: string): Promise<void>;
  linkTemporario(caminho: string, tipoMime: string, nomeArquivo: string): Promise<LinkTemporario>;
  /** Apaga o arquivo. Idempotente: arquivo que não existe não é erro. */
  remover(caminho: string): Promise<void>;
}

export const VALIDADE_LINK_SEGUNDOS = 300;

/** Falha do provedor de armazenamento (a rota traduz para 503, sem vazar detalhes). */
export class ErroArmazenamento extends Error {}

/** Caminho relativo seguro: sem "..", sem barra inicial, sem caracteres estranhos. */
function caminhoSeguro(caminho: string): string {
  if (!/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png)$/.test(caminho)) {
    throw new ErroArmazenamento("Caminho de evidência inválido.");
  }
  return caminho;
}

/** Disco local: só desenvolvimento. O link é uma data URL com o conteúdo. */
export function criarArmazenamentoLocal(dir: string): ArmazenamentoEvidencias {
  const raiz = resolve(dir);
  const arquivo = (caminho: string) => {
    const alvo = resolve(join(raiz, normalize(caminhoSeguro(caminho))));
    if (!alvo.startsWith(raiz + sep)) throw new ErroArmazenamento("Caminho de evidência inválido.");
    return alvo;
  };
  return {
    async salvar(caminho, bytes) {
      const alvo = arquivo(caminho);
      await mkdir(dirname(alvo), { recursive: true });
      await writeFile(alvo, bytes, { flag: "wx" });
    },
    async linkTemporario(caminho, tipoMime) {
      const bytes = await readFile(arquivo(caminho));
      return {
        url: `data:${tipoMime};base64,${bytes.toString("base64")}`,
        expiraEm: new Date(Date.now() + VALIDADE_LINK_SEGUNDOS * 1000).toISOString(),
      };
    },
    async remover(caminho) {
      try {
        await unlink(arquivo(caminho));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    },
  };
}

interface OpcoesSupabase {
  supabaseUrl: string;
  chaveServico: string;
  bucket: string;
  fetchImpl?: typeof fetch;
  agora?: () => Date;
}

/** Supabase Storage, bucket privado, com a chave de servidor (só no Render). */
export function criarArmazenamentoSupabase(o: OpcoesSupabase): ArmazenamentoEvidencias {
  const base = o.supabaseUrl.replace(/\/+$/, "");
  const f = o.fetchImpl ?? fetch;
  const agora = o.agora ?? (() => new Date());
  const cabecalho = { Authorization: `Bearer ${o.chaveServico}`, apikey: o.chaveServico };
  const caminhoUrl = (c: string) => caminhoSeguro(c).split("/").map(encodeURIComponent).join("/");

  return {
    async salvar(caminho, bytes, tipoMime) {
      const r = await f(
        `${base}/storage/v1/object/${encodeURIComponent(o.bucket)}/${caminhoUrl(caminho)}`,
        {
          method: "POST",
          headers: { ...cabecalho, "Content-Type": tipoMime, "x-upsert": "false" },
          body: bytes as unknown as ArrayBuffer,
        },
      );
      if (!r.ok) throw new ErroArmazenamento(`Storage recusou o envio (HTTP ${r.status}).`);
    },
    async remover(caminho) {
      // Objeto inexistente volta como 200 com lista vazia: também não é erro.
      const r = await f(`${base}/storage/v1/object/${encodeURIComponent(o.bucket)}`, {
        method: "DELETE",
        headers: { ...cabecalho, "Content-Type": "application/json" },
        body: JSON.stringify({ prefixes: [caminhoSeguro(caminho)] }),
      });
      if (!r.ok) throw new ErroArmazenamento(`Storage recusou a remoção (HTTP ${r.status}).`);
    },
    async linkTemporario(caminho) {
      const r = await f(
        `${base}/storage/v1/object/sign/${encodeURIComponent(o.bucket)}/${caminhoUrl(caminho)}`,
        {
          method: "POST",
          headers: { ...cabecalho, "Content-Type": "application/json" },
          body: JSON.stringify({ expiresIn: VALIDADE_LINK_SEGUNDOS }),
        },
      );
      if (!r.ok) throw new ErroArmazenamento(`Storage recusou o link (HTTP ${r.status}).`);
      const corpo = (await r.json()) as { signedURL?: string };
      if (!corpo.signedURL) throw new ErroArmazenamento("Resposta do Storage sem link.");
      // signedURL vem relativo a /storage/v1 (ex.: "/object/sign/bucket/x?token=...").
      const rel = corpo.signedURL.startsWith("/") ? corpo.signedURL : `/${corpo.signedURL}`;
      const url = /^https?:\/\//.test(corpo.signedURL)
        ? corpo.signedURL
        : `${base}/storage/v1${rel.startsWith("/storage/v1") ? rel.slice("/storage/v1".length) : rel}`;
      return {
        url,
        expiraEm: new Date(agora().getTime() + VALIDADE_LINK_SEGUNDOS * 1000).toISOString(),
      };
    },
  };
}

export function criarArmazenamentoDaConfig(config: Config): ArmazenamentoEvidencias {
  if (config.STORAGE_PROVEDOR === "supabase") {
    if (!config.SUPABASE_SERVICE_ROLE_KEY)
      throw new Error("SUPABASE_SERVICE_ROLE_KEY é obrigatória com STORAGE_PROVEDOR=supabase.");
    return criarArmazenamentoSupabase({
      supabaseUrl: config.SUPABASE_URL,
      chaveServico: config.SUPABASE_SERVICE_ROLE_KEY,
      bucket: config.STORAGE_BUCKET,
    });
  }
  return criarArmazenamentoLocal(config.STORAGE_DIR_LOCAL);
}

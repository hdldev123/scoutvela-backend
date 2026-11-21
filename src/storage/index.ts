import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join, normalize, resolve, sep } from "node:path";
import type { Config } from "../config.js";

export interface LinkTemporario {
  url: string;
  /** Instante ISO em que o link deixa de valer. */
  expiraEm: string;
}

/** Caminhos: evidência `${atletaId}/${uuid}.${ext}`, foto de perfil `fotos/${usuarioId}/${uuid}.${ext}`. */
export interface ArmazenamentoEvidencias {
  salvar(caminho: string, bytes: Uint8Array, tipoMime: string): Promise<void>;
  linkTemporario(caminho: string, tipoMime: string, nomeArquivo: string): Promise<LinkTemporario>;
  /** Links de vários arquivos de uma vez; o Map é indexado pelo caminho. Item que não pôde ser assinado fica de fora. */
  linksTemporarios(
    itens: { caminho: string; tipoMime: string }[],
  ): Promise<Map<string, LinkTemporario>>;
  /** Apaga o arquivo. Idempotente: arquivo que não existe não é erro. */
  remover(caminho: string): Promise<void>;
  /**
   * Caminhos completos dos arquivos sob o prefixo (`${atletaId}/` ou `fotos/${usuarioId}/`).
   * Prefixo sem arquivos devolve lista vazia. Usado na anonimização para achar o que sobrou.
   */
  listar(prefixo: string): Promise<string[]>;
}

export const VALIDADE_LINK_SEGUNDOS = 300;

/** Falha do provedor de armazenamento (a rota traduz para 503, sem vazar detalhes). */
export class ErroArmazenamento extends Error {}

/** Caminho relativo seguro: sem "..", sem barra inicial, sem caracteres estranhos. */
function caminhoSeguro(caminho: string): string {
  if (
    !/^[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|png)$/.test(caminho) &&
    !/^fotos\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|png)$/.test(caminho)
  ) {
    throw new ErroArmazenamento("Caminho de arquivo inválido.");
  }
  return caminho;
}

/** Prefixo de pasta válido: `${uuid}/` ou `fotos/${uuid}/`. */
function prefixoSeguro(prefixo: string): string {
  if (!/^(fotos\/)?[0-9a-f-]{36}\/$/.test(prefixo)) {
    throw new ErroArmazenamento("Prefixo de arquivo inválido.");
  }
  return prefixo;
}

/** Disco local: só desenvolvimento. O link é uma data URL com o conteúdo. */
export function criarArmazenamentoLocal(dir: string): ArmazenamentoEvidencias {
  const raiz = resolve(dir);
  const arquivo = (caminho: string) => {
    const alvo = resolve(join(raiz, normalize(caminhoSeguro(caminho))));
    if (!alvo.startsWith(raiz + sep)) throw new ErroArmazenamento("Caminho de arquivo inválido.");
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
    async linksTemporarios(itens) {
      const links = new Map<string, LinkTemporario>();
      for (const { caminho, tipoMime } of itens) {
        links.set(caminho, await this.linkTemporario(caminho, tipoMime, "arquivo"));
      }
      return links;
    },
    async listar(prefixo) {
      const pasta = resolve(join(raiz, normalize(prefixoSeguro(prefixo))));
      if (!pasta.startsWith(raiz + sep))
        throw new ErroArmazenamento("Prefixo de arquivo inválido.");
      try {
        const nomes = await readdir(pasta, { withFileTypes: true });
        return nomes.filter((n) => n.isFile()).map((n) => `${prefixo}${n.name}`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw e;
      }
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
  // signedURL vem relativo a /storage/v1 (ex.: "/object/sign/bucket/x?token=...").
  const urlAssinada = (signedURL: string): LinkTemporario => {
    const rel = signedURL.startsWith("/") ? signedURL : `/${signedURL}`;
    const url = /^https?:\/\//.test(signedURL)
      ? signedURL
      : `${base}/storage/v1${rel.startsWith("/storage/v1") ? rel.slice("/storage/v1".length) : rel}`;
    return {
      url,
      expiraEm: new Date(agora().getTime() + VALIDADE_LINK_SEGUNDOS * 1000).toISOString(),
    };
  };

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
    async listar(prefixo) {
      const pasta = prefixoSeguro(prefixo);
      const caminhos: string[] = [];
      const porPagina = 100;
      for (let offset = 0; ; offset += porPagina) {
        const r = await f(`${base}/storage/v1/object/list/${encodeURIComponent(o.bucket)}`, {
          method: "POST",
          headers: { ...cabecalho, "Content-Type": "application/json" },
          body: JSON.stringify({ prefix: pasta.replace(/\/$/, ""), limit: porPagina, offset }),
        });
        if (!r.ok) throw new ErroArmazenamento(`Storage recusou a listagem (HTTP ${r.status}).`);
        const itens = (await r.json()) as { name?: string; id?: string | null }[];
        if (!Array.isArray(itens)) throw new ErroArmazenamento("Resposta do Storage inválida.");
        // Pasta aparece sem id; só arquivos interessam.
        for (const i of itens) if (i.name && i.id) caminhos.push(`${pasta}${i.name}`);
        if (itens.length < porPagina) return caminhos;
      }
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
      return urlAssinada(corpo.signedURL);
    },
    async linksTemporarios(itens) {
      const links = new Map<string, LinkTemporario>();
      if (itens.length === 0) return links;
      const caminhos = [...new Set(itens.map((i) => caminhoSeguro(i.caminho)))];
      const r = await f(`${base}/storage/v1/object/sign/${encodeURIComponent(o.bucket)}`, {
        method: "POST",
        headers: { ...cabecalho, "Content-Type": "application/json" },
        body: JSON.stringify({ expiresIn: VALIDADE_LINK_SEGUNDOS, paths: caminhos }),
      });
      if (!r.ok) throw new ErroArmazenamento(`Storage recusou os links (HTTP ${r.status}).`);
      const corpo = (await r.json()) as {
        path?: string;
        signedURL?: string | null;
        error?: unknown;
      }[];
      if (!Array.isArray(corpo)) throw new ErroArmazenamento("Resposta do Storage inválida.");
      const pedidos = new Set(caminhos);
      for (const item of corpo) {
        if (item.error || !item.signedURL || !item.path || !pedidos.has(item.path)) continue;
        links.set(item.path, urlAssinada(item.signedURL));
      }
      return links;
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

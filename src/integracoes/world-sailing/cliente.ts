import { z } from "zod";
import type { PerfilWorldSailing, RankingWs, ResultadoWs } from "../../domain/world-sailing.js";
import { ErroWorldSailing } from "./tipos.js";
import type { FonteWorldSailing, OpcoesBusca } from "./tipos.js";

/**
 * Cliente da API pública do datafeed da World Sailing (JSON:API, sem login, sem documentação oficial:
 * ver docs/world-sailing.md). A resposta traz muito mais do que podemos guardar: o parse pega só os
 * campos que pontuam ou decidem e descarta o resto na fronteira. Nunca se registra o conteúdo.
 */

export const URL_PADRAO_WORLD_SAILING = "https://datafeed.sailing.org/stats/api";
export const PREFIXO_FOTO_WORLD_SAILING = "https://assets.sailing.org/";
const TEMPO_LIMITE_MS = 8_000;
const TAMANHO_MAXIMO_RESPOSTA = 5 * 1024 * 1024;
const MAXIMO_RESULTADOS = 2_000;
const MAXIMO_RANKING = 5_000;
const USER_AGENT = "ScoutVela/1.0";

const nome = z.object({ name: z.string() }).nullish();
const texto = z.string().nullish();

const esquemaVelejador = z.object({
  id: z.string().min(1),
  worldSailingId: z.string().min(1),
  firstName: texto,
  lastName: texto,
  gender: nome,
  dateOfBirth: texto,
  biography: texto,
  // Peso e altura são autodeclarados: qualquer coisa fora do esperado vira nulo, sem derrubar o perfil.
  height: z.unknown(),
  weight: z.unknown(),
  updatedAt: z.unknown(),
  images: z.array(z.unknown()).nullish(),
  crews: z.array(z.unknown()).nullish(),
});

const esquemaCrew = z.object({
  id: z.union([z.string(), z.number()]),
  position: z.union([z.string(), z.number()]).nullish(),
  event: z
    .object({
      boatClass: nome,
      regatta: z.object({ name: texto, startDate: texto, level: nome }).nullish(),
    })
    .nullish(),
});

const esquemaImagem = z.object({
  url: z.string(),
  tags: z.unknown().optional(),
});

const esquemaRanking = z.object({
  id: z.union([z.string(), z.number()]),
  rankPosition: z.union([z.string(), z.number()]).nullish(),
  rankPoints: z.union([z.string(), z.number()]).nullish(),
  rankingReference: z.object({ rankDate: texto, boatClass: nome, type: nome }).nullish(),
});

const esquemaLista = z.object({ data: z.array(z.unknown()) });

/** AAAA-MM-DD de "AAAA-MM-DD" ou "AAAA-MM-DD HH:MM:SS"; nulo se não for uma data real. */
export function dataDoTexto(valor: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T].*)?$/.exec((valor ?? "").trim());
  if (!m) return null;
  const [, a, mes, d] = m as unknown as [string, string, string, string];
  const data = new Date(Date.UTC(Number(a), Number(mes) - 1, Number(d)));
  if (
    data.getUTCFullYear() !== Number(a) ||
    data.getUTCMonth() !== Number(mes) - 1 ||
    data.getUTCDate() !== Number(d) ||
    Number(a) < 1900
  ) {
    return null;
  }
  return `${a}-${mes}-${d}`;
}

/** Colocação inteira positiva; texto não numérico, zero e negativo são ignorados. */
export function posicaoDoTexto(valor: string | number | null | undefined): number | null {
  const t = String(valor ?? "").trim();
  if (!/^\d{1,6}$/.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

const limpar = (t: string | null | undefined, max: number): string | null => {
  const s = (t ?? "").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

/** Foto só do domínio de imagens da World Sailing (https), nunca o placeholder de validação. */
export function fotoAceita(url: string | null | undefined): string | null {
  if (!url || !url.startsWith(PREFIXO_FOTO_WORLD_SAILING)) return null;
  if (url.length > 500 || /validation_placeholder/i.test(url)) return null;
  return url;
}

function temTag(tags: unknown, alvo: string): boolean {
  const itens = Array.isArray(tags) ? tags : [tags];
  return itens.some((t) => {
    const valor =
      typeof t === "string"
        ? t
        : t && typeof t === "object" && "name" in t
          ? String((t as { name: unknown }).name)
          : "";
    return valor.toLowerCase().includes(alvo);
  });
}

/** Número (ou texto numérico, com vírgula ou ponto) dentro da faixa, em uma casa; fora dela, nulo. */
export function medidaDoValor(valor: unknown, min: number, max: number): number | null {
  if (typeof valor !== "number" && typeof valor !== "string") return null;
  const t = typeof valor === "string" ? valor.trim().replace(",", ".") : valor;
  if (typeof t === "string" && !/^\d{1,4}(\.\d{1,6})?$/.test(t)) return null;
  const n = Math.round(Number(t) * 10) / 10;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}

function bioDoTexto(valor: string | null | undefined): string | null {
  // Texto simples: sem caracteres de controle (mantém quebras de linha), até 2.000 caracteres.
  const s = [...(valor ?? "")]
    .filter((c) => {
      const n = c.charCodeAt(0);
      return n === 10 || n === 13 || n === 9 || (n >= 32 && n !== 127);
    })
    .join("")
    .trim();
  return s ? s.slice(0, 2000) : null;
}

const GENEROS: Record<string, "F" | "M"> = { female: "F", male: "M" };

/**
 * Transforma as respostas da API no perfil normalizado. `null` se a resposta de perfil não traz o
 * velejador pedido (lista vazia ou outro ID). Resposta fora do formato: `resposta_invalida`.
 */
export function normalizarPerfil(
  wsId: string,
  respostaPerfil: unknown,
  respostaRanking: unknown,
): PerfilWorldSailing | null {
  const lista = esquemaLista.safeParse(respostaPerfil);
  if (!lista.success) throw new ErroWorldSailing("resposta_invalida");
  if (lista.data.data.length === 0) return null;
  const v = esquemaVelejador.safeParse(lista.data.data[0]);
  if (!v.success) throw new ErroWorldSailing("resposta_invalida");
  const velejador = v.data;
  // O filtro da API pode devolver outro velejador: só vale o ID pedido.
  if (velejador.worldSailingId.toUpperCase() !== wsId.toUpperCase()) return null;

  const resultados: ResultadoWs[] = [];
  for (const bruto of (velejador.crews ?? []).slice(0, MAXIMO_RESULTADOS)) {
    const c = esquemaCrew.safeParse(bruto);
    if (!c.success) continue;
    const regata = c.data.event?.regatta;
    const classe = limpar(c.data.event?.boatClass?.name, 80);
    const evento = limpar(regata?.name, 120);
    const data = dataDoTexto(regata?.startDate);
    const posicao = posicaoDoTexto(c.data.position);
    if (!classe || !evento || !data || posicao === null) continue;
    resultados.push({
      ref: String(c.data.id).slice(0, 80),
      evento,
      classe,
      nivelWs: limpar(regata?.level?.name, 120),
      data,
      posicao,
    });
  }

  const ranking: RankingWs[] = [];
  const listaRanking = esquemaLista.safeParse(respostaRanking);
  if (!listaRanking.success) throw new ErroWorldSailing("resposta_invalida");
  for (const bruto of listaRanking.data.data.slice(0, MAXIMO_RANKING)) {
    const r = esquemaRanking.safeParse(bruto);
    if (!r.success) continue;
    const ref = r.data.rankingReference;
    const classe = limpar(ref?.boatClass?.name, 120);
    const data = dataDoTexto(ref?.rankDate);
    const posicao = posicaoDoTexto(r.data.rankPosition);
    if (!classe || !data || posicao === null) continue;
    const pontos = r.data.rankPoints == null ? null : Number(r.data.rankPoints);
    ranking.push({
      ref: String(r.data.id).slice(0, 80),
      data,
      classe,
      tipo: limpar(ref?.type?.name, 120),
      posicao,
      pontos: pontos !== null && Number.isFinite(pontos) && Math.abs(pontos) < 1e9 ? pontos : null,
    });
  }

  let fotoUrl: string | null = null;
  for (const bruta of velejador.images ?? []) {
    const img = esquemaImagem.safeParse(bruta);
    if (img.success && temTag(img.data.tags, "headshot")) {
      fotoUrl = fotoAceita(img.data.url);
      if (fotoUrl) break;
    }
  }

  const nomeCompleto = limpar(`${velejador.firstName ?? ""} ${velejador.lastName ?? ""}`, 120);
  return {
    sailorId: velejador.id.slice(0, 80),
    wsId,
    nome: nomeCompleto,
    genero: GENEROS[(velejador.gender?.name ?? "").trim().toLowerCase()] ?? null,
    dataNascimento: dataDoTexto(velejador.dateOfBirth),
    fotoUrl,
    bio: bioDoTexto(velejador.biography),
    pesoKg: medidaDoValor(velejador.weight, 30, 160),
    alturaCm: medidaDoValor(velejador.height, 120, 230),
    atualizadoEm: typeof velejador.updatedAt === "string" ? dataDoTexto(velejador.updatedAt) : null,
    resultados,
    ranking,
  };
}

/** Lê o corpo até o limite de tamanho; passou do limite, `resposta_invalida`. */
async function lerJsonLimitado(res: Response): Promise<unknown> {
  const declarado = Number(res.headers.get("content-length"));
  if (Number.isFinite(declarado) && declarado > TAMANHO_MAXIMO_RESPOSTA) {
    await res.body?.cancel().catch(() => undefined);
    throw new ErroWorldSailing("resposta_invalida");
  }
  if (!res.body) throw new ErroWorldSailing("resposta_invalida");
  const leitor = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const partes: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    total += value.length;
    if (total > TAMANHO_MAXIMO_RESPOSTA) {
      await leitor.cancel().catch(() => undefined);
      throw new ErroWorldSailing("resposta_invalida");
    }
    partes.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(partes).toString("utf8"));
  } catch {
    throw new ErroWorldSailing("resposta_invalida");
  }
}

export interface OpcoesClienteReal {
  /** Base da API. Só `https://`. */
  urlBase?: string;
  /** Injetável para teste; o padrão é o `fetch` do Node. */
  fetch?: typeof fetch;
}

export function criarFonteReal(opcoes: OpcoesClienteReal = {}): FonteWorldSailing {
  const base = (opcoes.urlBase ?? URL_PADRAO_WORLD_SAILING).replace(/\/+$/, "");
  if (!base.startsWith("https://")) {
    throw new Error("WORLD_SAILING_API_URL precisa começar com https://");
  }
  const buscar = opcoes.fetch ?? fetch;

  async function chamar(
    caminho: string,
    parametros: Record<string, string>,
    sinal: AbortSignal | undefined,
  ): Promise<unknown> {
    const url = new URL(`${base}${caminho}`);
    for (const [k, v] of Object.entries(parametros)) url.searchParams.set(k, v);
    const limite = AbortSignal.timeout(TEMPO_LIMITE_MS);
    try {
      const res = await buscar(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/vnd.api+json, application/json", "user-agent": USER_AGENT },
        signal: sinal ? AbortSignal.any([limite, sinal]) : limite,
      });
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        throw new ErroWorldSailing(`http_${res.status}`);
      }
      return await lerJsonLimitado(res);
    } catch (e) {
      if (e instanceof ErroWorldSailing) throw e;
      const nomeErro = (e as { name?: unknown })?.name;
      if (nomeErro === "TimeoutError" || nomeErro === "AbortError") {
        throw new ErroWorldSailing("tempo_esgotado");
      }
      throw new ErroWorldSailing("rede");
    }
  }

  return {
    async buscarPerfil(wsId: string, opcoesBusca: OpcoesBusca = {}) {
      const perfil = await chamar(
        "/sailor",
        {
          "filter[worldSailingId]": wsId,
          include: "images,crews.event.regatta.level,crews.event.boatClass",
          paginate: "1",
        },
        opcoesBusca.sinal,
      );
      const lista = esquemaLista.safeParse(perfil);
      if (!lista.success) throw new ErroWorldSailing("resposta_invalida");
      const primeiro = esquemaVelejador.safeParse(lista.data.data[0]);
      if (!primeiro.success || primeiro.data.worldSailingId.toUpperCase() !== wsId.toUpperCase()) {
        // Sem velejador para buscar o ranking: o parse decide entre "não achou" e "inválida".
        return normalizarPerfil(wsId, perfil, { data: [] });
      }
      const ranking = await chamar(
        "/ranking",
        {
          "filter[sailor.id]": primeiro.data.id,
          "filter[rankingReference.status]": "final",
          include: "rankingReference.boatClass,rankingReference.type",
        },
        opcoesBusca.sinal,
      );
      return normalizarPerfil(wsId, perfil, ranking);
    },
  };
}

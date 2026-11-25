import { describe, expect, it } from "vitest";
import { criarFonteReal, normalizarPerfil } from "../../src/integracoes/world-sailing/cliente.js";
import {
  baixarFotoWorldSailing,
  enderecoDeFotoPermitido,
  FotoWorldSailingInvalida,
} from "../../src/integracoes/world-sailing/foto.js";
import {
  criarFetchSimulado,
  criarFonteSimulada,
} from "../../src/integracoes/world-sailing/simulador.js";
import {
  criarIntegracaoDaConfig,
  resolverIntegracao,
} from "../../src/integracoes/world-sailing/index.js";
import { ErroWorldSailing } from "../../src/integracoes/world-sailing/tipos.js";
import { jpegValido, pngValido } from "../apoio/imagens.js";
import { respostaPerfil, respostaRanking, SAILOR_UUID } from "../fixtures/world-sailing.js";

const json = (corpo: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(corpo), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("parse da resposta da World Sailing", () => {
  const perfil = normalizarPerfil("BRATESTE09", respostaPerfil(), respostaRanking())!;

  it("pega só o que pontua ou decide e descarta o resto", () => {
    expect(perfil).toMatchObject({
      sailorId: SAILOR_UUID,
      wsId: "BRATESTE09",
      nome: "Joana Brisa Fictícia",
      genero: "F",
      dataNascimento: "2002-02-28",
      bio: "Velejadora inventada para os testes.",
      fotoUrl: "https://assets.sailing.org/sailors/fake-headshot.jpg",
    });
    expect(JSON.stringify(perfil)).not.toMatch(/SEGREDO/);
  });

  it("resultados: posição em texto vira número; não numérica, zero e regata sem data saem", () => {
    expect(perfil.resultados.map((r) => [r.ref, r.posicao])).toEqual([
      ["c-1", 3],
      ["c-2", 12],
      ["c-3", 5],
      ["c-7", 2],
    ]);
    expect(perfil.resultados[0]).toEqual({
      ref: "c-1",
      evento: "Mundial Fictício",
      classe: "ILCA 6",
      nivelWs: "World Championships",
      data: "2025-08-04",
      posicao: 3,
    });
  });

  it("nível nulo fica nulo", () => {
    expect(perfil.resultados.find((r) => r.ref === "c-3")?.nivelWs).toBeNull();
  });

  it("ranking: descarta item sem classe; aceita pontos em texto, nulos e tipo nulo", () => {
    expect(perfil.ranking).toEqual([
      {
        ref: "k-1",
        data: "2026-06-30",
        classe: "ILCA 6",
        tipo: "Senior",
        posicao: 18,
        pontos: 412.5,
      },
      { ref: "k-2", data: "2025-12-31", classe: "ILCA 7", tipo: null, posicao: 61, pontos: null },
    ]);
  });

  it("o placeholder de validação e o domínio errado não viram foto", () => {
    const so = respostaPerfil({
      images: [
        { url: "https://assets.sailing.org/x/validation_placeholder.jpeg", tags: ["headshot"] },
        { url: "https://evil.example/foto.jpg", tags: ["headshot"] },
        { url: "http://assets.sailing.org/foto.jpg", tags: ["headshot"] },
      ],
    });
    expect(normalizarPerfil("BRATESTE09", so, { data: [] })!.fotoUrl).toBeNull();
  });

  it("gênero e nascimento ausentes ou inválidos viram nulos", () => {
    const p = normalizarPerfil(
      "BRATESTE09",
      respostaPerfil({ gender: null, dateOfBirth: "2002-13-45", biography: "  " }),
      { data: [] },
    )!;
    expect(p).toMatchObject({ genero: null, dataNascimento: null, bio: null });
  });

  it("ID diferente do pedido, ou lista vazia, é não encontrado (sem diferenciar maiúsculas)", () => {
    expect(normalizarPerfil("OUTRO0001", respostaPerfil(), { data: [] })).toBeNull();
    expect(normalizarPerfil("brateste09", respostaPerfil(), { data: [] })).not.toBeNull();
    expect(normalizarPerfil("BRATESTE09", { data: [] }, { data: [] })).toBeNull();
  });

  it("resposta fora do formato é resposta_invalida", () => {
    for (const ruim of [null, "texto", { dados: [] }, { data: [{ id: 1 }] }]) {
      expect(
        () => normalizarPerfil("BRATESTE09", ruim, { data: [] }),
        JSON.stringify(ruim),
      ).toThrow(ErroWorldSailing);
    }
    expect(() => normalizarPerfil("BRATESTE09", respostaPerfil(), { oi: 1 })).toThrow(
      ErroWorldSailing,
    );
  });
});

describe("fonte real (com fetch falso: nunca chama a rede)", () => {
  function fetchFalso(respostas: Array<Response | Error>) {
    const chamadas: { url: URL; init: RequestInit }[] = [];
    const f = ((entrada: URL | string, init: RequestInit) => {
      chamadas.push({ url: new URL(String(entrada)), init });
      const r = respostas.shift();
      if (!r) throw new Error("sem resposta combinada");
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    }) as unknown as typeof fetch;
    return { f, chamadas };
  }

  it("pede perfil e ranking com os filtros, sem seguir redirecionamento, com User-Agent genérico", async () => {
    const { f, chamadas } = fetchFalso([json(respostaPerfil()), json(respostaRanking())]);
    const perfil = await criarFonteReal({ fetch: f }).buscarPerfil("BRATESTE09");
    expect(perfil?.resultados).toHaveLength(4);
    expect(chamadas).toHaveLength(2);
    const [a, b] = chamadas;
    expect(a!.url.origin + a!.url.pathname).toBe("https://datafeed.sailing.org/stats/api/sailor");
    expect(a!.url.searchParams.get("filter[worldSailingId]")).toBe("BRATESTE09");
    expect(a!.url.searchParams.get("include")).toBe(
      "images,crews.event.regatta.level,crews.event.boatClass",
    );
    expect(b!.url.pathname).toBe("/stats/api/ranking");
    expect(b!.url.searchParams.get("filter[sailor.id]")).toBe(SAILOR_UUID);
    expect(b!.url.searchParams.get("filter[rankingReference.status]")).toBe("final");
    for (const c of chamadas) {
      expect(c.init.redirect).toBe("error");
      expect(c.init.signal).toBeInstanceOf(AbortSignal);
      expect((c.init.headers as Record<string, string>)["user-agent"]).toBe("ScoutVela/1.0");
    }
  });

  it("ID sem velejador: não busca o ranking e devolve nulo", async () => {
    const { f, chamadas } = fetchFalso([json({ data: [] })]);
    expect(await criarFonteReal({ fetch: f }).buscarPerfil("NAOEXISTE1")).toBeNull();
    expect(chamadas).toHaveLength(1);
  });

  it("erros tipados: http_<status>, tempo_esgotado, rede, resposta_invalida", async () => {
    const codigo = async (resposta: Response | Error) => {
      const { f } = fetchFalso([resposta]);
      try {
        await criarFonteReal({ fetch: f }).buscarPerfil("BRATESTE09");
        return "sem erro";
      } catch (e) {
        return e instanceof ErroWorldSailing ? e.codigo : "outro";
      }
    };
    expect(await codigo(new Response("x", { status: 503 }))).toBe("http_503");
    expect(await codigo(new Response("x", { status: 404 }))).toBe("http_404");
    expect(await codigo(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(
      "tempo_esgotado",
    );
    expect(await codigo(Object.assign(new Error("a"), { name: "AbortError" }))).toBe(
      "tempo_esgotado",
    );
    expect(await codigo(new TypeError("fetch failed"))).toBe("rede");
    expect(await codigo(new Response("não é json", { status: 200 }))).toBe("resposta_invalida");
    expect(await codigo(json({ nada: true }))).toBe("resposta_invalida");
  });

  it("limita o tamanho da resposta (5 MB)", async () => {
    const grande = new Response(new Uint8Array(5 * 1024 * 1024 + 10), { status: 200 });
    const { f } = fetchFalso([grande]);
    await expect(criarFonteReal({ fetch: f }).buscarPerfil("BRATESTE09")).rejects.toMatchObject({
      codigo: "resposta_invalida",
    });
    const declarado = new Response("{}", {
      status: 200,
      headers: { "content-length": String(6 * 1024 * 1024) },
    });
    const { f: f2 } = fetchFalso([declarado]);
    await expect(criarFonteReal({ fetch: f2 }).buscarPerfil("BRATESTE09")).rejects.toMatchObject({
      codigo: "resposta_invalida",
    });
  });

  it("só aceita base https://", () => {
    expect(() => criarFonteReal({ urlBase: "http://exemplo.invalid/api" })).toThrow(/https/);
  });
});

describe("simulador e fábrica", () => {
  it("BRATESTE01 tem resultados em vários níveis (um nulo e um World Cup) e ranking em 2 classes", async () => {
    const p = (await criarFonteSimulada().buscarPerfil("brateste01"))!;
    expect(p.resultados.length).toBeGreaterThanOrEqual(5);
    expect(p.resultados.some((r) => r.nivelWs === null)).toBe(true);
    expect(p.resultados.some((r) => r.nivelWs === "Sailing World Cup Series")).toBe(true);
    expect(new Set(p.ranking.map((k) => k.classe)).size).toBeGreaterThanOrEqual(2);
  });

  it("BRATESTE02 não tem resultados nem ranking; outros IDs não existem", async () => {
    const fonte = criarFonteSimulada();
    const p = (await fonte.buscarPerfil("BRATESTE02"))!;
    expect(p.resultados).toEqual([]);
    expect(p.ranking).toEqual([]);
    expect(await fonte.buscarPerfil("GBRHM15")).toBeNull();
  });

  it("o fetch simulado só serve fotos de assets.sailing.org (sem rede)", async () => {
    const f = criarFetchSimulado();
    expect((await f("https://assets.sailing.org/x.png")).status).toBe(200);
    expect((await f("https://outro.example/x.png")).status).toBe(404);
  });

  it("a fábrica escolhe a fonte pelo modo", () => {
    const base = { WORLD_SAILING_API_URL: "https://datafeed.sailing.org/stats/api" };
    expect(criarIntegracaoDaConfig({ ...base, WORLD_SAILING_MODO: "desligado" }).fonte).toBeNull();
    expect(criarIntegracaoDaConfig({ ...base, WORLD_SAILING_MODO: "simulado" }).modo).toBe(
      "simulado",
    );
    expect(criarIntegracaoDaConfig({ ...base, WORLD_SAILING_MODO: "real" }).fonte).not.toBeNull();
  });

  it("injetar fonte vale como simulado; fonte nula, como desligado", () => {
    const cfg = {
      WORLD_SAILING_MODO: "desligado" as const,
      WORLD_SAILING_API_URL: "https://datafeed.sailing.org/stats/api",
    };
    expect(resolverIntegracao(cfg, { fonte: criarFonteSimulada() }).modo).toBe("simulado");
    expect(
      resolverIntegracao({ ...cfg, WORLD_SAILING_MODO: "simulado" }, { fonte: null }).modo,
    ).toBe("desligado");
  });
});

describe("foto do perfil da World Sailing", () => {
  const FOTO = "https://assets.sailing.org/sailors/fake-headshot.jpg";

  it("só aceita https://assets.sailing.org/, sem usuário, senha nem porta", () => {
    expect(enderecoDeFotoPermitido(FOTO)).toBe(true);
    for (const ruim of [
      "http://assets.sailing.org/x.jpg",
      "https://assets.sailing.org.evil.example/x.jpg",
      "https://evil.example/assets.sailing.org/x.jpg",
      "https://usuario@assets.sailing.org/x.jpg",
      "https://assets.sailing.org:8443/x.jpg",
      "https://assets.sailing.org@evil.example/x.jpg",
      "ftp://assets.sailing.org/x.jpg",
      "isto não é url",
    ]) {
      expect(enderecoDeFotoPermitido(ruim), ruim).toBe(false);
    }
  });

  it("endereço fora da lista é recusado SEM chamar o fetch", async () => {
    let chamou = false;
    const f = (() => {
      chamou = true;
      return Promise.resolve(new Response("x"));
    }) as unknown as typeof fetch;
    await expect(baixarFotoWorldSailing("https://evil.example/x.jpg", f)).rejects.toBeInstanceOf(
      FotoWorldSailingInvalida,
    );
    expect(chamou).toBe(false);
  });

  it("baixa JPEG e PNG pela assinatura (não pelo cabeçalho), sem seguir redirecionamento", async () => {
    let init: RequestInit | undefined;
    const f = ((_: unknown, i: RequestInit) => {
      init = i;
      return Promise.resolve(new Response(new Uint8Array(jpegValido()), { status: 200 }));
    }) as unknown as typeof fetch;
    const r = await baixarFotoWorldSailing(FOTO, f);
    expect(r.tipoMime).toBe("image/jpeg");
    expect(init?.redirect).toBe("error");
    const png = (() =>
      Promise.resolve(
        new Response(new Uint8Array(pngValido()), { status: 200 }),
      )) as unknown as typeof fetch;
    expect((await baixarFotoWorldSailing(FOTO, png)).tipoMime).toBe("image/png");
  });

  it("recusa formato desconhecido (inclui WebP e HTML), acima de 5 MB e erro HTTP", async () => {
    const com = (r: Response) => (() => Promise.resolve(r)) as unknown as typeof fetch;
    const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);
    await expect(
      baixarFotoWorldSailing(FOTO, com(new Response(new Uint8Array(webp)))),
    ).rejects.toBeInstanceOf(FotoWorldSailingInvalida);
    await expect(
      baixarFotoWorldSailing(FOTO, com(new Response("<html>não é imagem</html>"))),
    ).rejects.toBeInstanceOf(FotoWorldSailingInvalida);
    await expect(
      baixarFotoWorldSailing(FOTO, com(new Response(new Uint8Array(5 * 1024 * 1024 + 1)))),
    ).rejects.toBeInstanceOf(FotoWorldSailingInvalida);
    await expect(
      baixarFotoWorldSailing(FOTO, com(new Response("x", { status: 404 }))),
    ).rejects.toMatchObject({ codigo: "http_404" });
  });
});

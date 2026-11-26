import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAppDeTeste, tokenPara } from "../apoio/app.js";
import { jpegValido, segmentoJpeg } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";
import { criarFonteSimulada } from "../../src/integracoes/world-sailing/simulador.js";
import { ErroWorldSailing } from "../../src/integracoes/world-sailing/tipos.js";
import type {
  FonteWorldSailing,
  PerfilWorldSailing,
} from "../../src/integracoes/world-sailing/tipos.js";

/**
 * D19: importação do perfil World Sailing pelo WS ID. A fonte é SIMULADA (dados fictícios) e o `fetch` da
 * foto é falso: nenhum teste chama a rede.
 */

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (segundos: number) => {
  agora = new Date(agora.getTime() + segundos * 1000);
};

type ModoFonte = "simulada" | "clone" | "falha" | "lenta";
let modoFonte: ModoFonte = "simulada";
let bioLonga = false;
/** Muda o perfil devolvido pela fonte "clone" (peso, altura e data de atualização do perfil). */
let ajusteDoPerfil: Partial<Pick<PerfilWorldSailing, "pesoKg" | "alturaCm" | "atualizadoEm">> = {};
const logs: string[] = [];
const buscas: string[] = [];

/** Fonte de teste: o simulador, um clone dele para qualquer ID, uma falha ou uma busca que não termina. */
const fonte: FonteWorldSailing = {
  async buscarPerfil(wsId, opcoes) {
    buscas.push(wsId);
    if (modoFonte === "falha") throw new ErroWorldSailing("http_503");
    if (modoFonte === "lenta") {
      return new Promise<PerfilWorldSailing | null>((_, rejeitar) => {
        opcoes?.sinal?.addEventListener("abort", () => rejeitar(new Error("abortado")));
      });
    }
    const base = await criarFonteSimulada().buscarPerfil("BRATESTE01");
    if (modoFonte === "simulada") return criarFonteSimulada().buscarPerfil(wsId);
    const clone = structuredClone(base)!;
    clone.wsId = wsId;
    clone.sailorId = `uuid-${wsId}`;
    if (bioLonga) clone.bio = "palavra ".repeat(120);
    Object.assign(clone, ajusteDoPerfil);
    return clone;
  },
};

const urlsDeFoto: string[] = [];
let respostaFoto: () => Promise<Response> = () =>
  Promise.resolve(
    new Response(
      new Uint8Array(
        jpegValido({
          extras: [segmentoJpeg(0xe1, Buffer.from("Exif\0\0SEGREDO-GPS-DO-ATLETA", "latin1"))],
        }),
      ),
      { status: 200 },
    ),
  );
const fetchFalso = ((entrada: URL | string) => {
  urlsDeFoto.push(String(entrada));
  return respostaFoto();
}) as unknown as typeof fetch;

describe("D19: World Sailing", () => {
  let p: Piloto;
  let treinadora: string;
  let treinadoraAuth: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora, {
      worldSailing: { fonte, fetch: fetchFalso, limiteCadastroMs: 300 },
      destinoLog: { write: (linha: string) => void logs.push(linha) },
    });
    treinadora = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
    treinadoraAuth = EMAILS_DEMO.treinadora;
  });
  afterAll(() => p.encerrar());

  type Quem = string | { authorization: string } | null;
  const chamar = async (
    quem: Quem,
    metodo: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    corpo?: unknown,
  ) => {
    const headers = quem === null ? {} : typeof quem === "string" ? await p.como(quem) : quem;
    const r = await p.app.inject({
      method: metodo,
      url,
      headers,
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const contar = async (sql: string, params: unknown[] = []) =>
    Number(
      (await p.db.query<{ n: string }>(`select count(*)::text as n from ${sql}`, params)).rows[0]!
        .n,
    );

  /** Cadastra pelo gestor e devolve o id, o e-mail e o cabeçalho do atleta. */
  async function cadastrar(wsId: string, extra: Record<string, unknown> = {}) {
    modoFonte = (extra.modo as ModoFonte | undefined) ?? "clone";
    const email = `${wsId.toLowerCase()}@exemplo.dev`;
    const r = await chamar(EMAILS_DEMO.gestor, "POST", "/atletas", {
      wsId,
      email,
      classeId: "ilca6",
      treinadorId: treinadora,
      confirmaMaioridade: true,
      ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== "modo")),
    });
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where email = $2", [authUserId, email]);
    return {
      r,
      id: r.corpo?.id as string,
      auth: cabecalhoAuth(await tokenPara(authUserId)),
    };
  }
  const completar = (auth: { authorization: string }, nome = "Atleta Importada") =>
    chamar(auth, "PUT", "/me/cadastro", {
      nome,
      genero: "F",
      dataNascimento: "2003-04-12",
    });

  describe("cadastro com BRATESTE01 (fonte simulada)", () => {
    let id: string;
    let auth: { authorization: string };
    let resultados: {
      id: string;
      evento: string;
      nivel: string;
      fonte: string;
      status: string;
      posicao: number;
      tamanhoFrota: number | null;
      internacional: boolean;
      motivo: string | null;
    }[];

    const ficha = async () => (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}`)).corpo;
    const nota = (
      f: { pilares: { indicadores: { id: string; nota: number | null }[] | null }[] },
      ind: string,
    ) => f.pilares.flatMap((x) => x.indicadores ?? []).find((i) => i.id === ind)?.nota;
    const g3 = (f: { gates: { itens: { gate: number; motivo: string }[] } }) =>
      f.gates.itens.find((g) => g.gate === 3)!.motivo;

    it("traz resultados e ranking no cadastro, que sai 201 com o resumo", async () => {
      const c = await cadastrar("BRATESTE01", { modo: "simulada" });
      id = c.id;
      auth = c.auth;
      expect(c.r.status).toBe(201);
      expect(c.r.corpo.worldSailing).toEqual({
        status: "ok",
        resultadosNovos: 5,
        rankingNovos: 4,
      });
      expect(
        await contar("resultados_regata where atleta_id = $1 and fonte = 'world_sailing'", [id]),
      ).toBe(5);
      expect(await contar("world_sailing_ranking where atleta_id = $1", [id])).toBe(4);
      expect(await contar("world_sailing_perfis where atleta_id = $1", [id])).toBe(1);
    });

    it("o primeiro acesso recebe a sugestão da World Sailing, com a origem", async () => {
      const me = await chamar(auth, "GET", "/me");
      expect(me.corpo.cadastroPendente).toEqual({
        wsId: "BRATESTE01",
        velaid: null,
        sugestao: { nome: "Marina Ventosa Lemos", genero: "F", dataNascimento: "2003-04-12" },
        origemSugestao: "world_sailing",
      });
      expect((await completar(auth, "Marina Ventosa Lemos")).status).toBe(200);
      await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/termo`, {
        versao: "Piloto 18+ · v1",
      });
    });

    it("os resultados valem direto (validado), com fonte, nível pela regra WS_NIVEIS e sem frota", async () => {
      const lista = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}/resultados`);
      expect(lista.status).toBe(200);
      resultados = lista.corpo.itens;
      expect(resultados).toHaveLength(5);
      expect(resultados.every((r) => r.fonte === "world_sailing" && r.status === "validado")).toBe(
        true,
      );
      expect(resultados.every((r) => r.tamanhoFrota === null && r.internacional)).toBe(true);
      const porEvento = Object.fromEntries(resultados.map((r) => [r.evento, r]));
      expect(porEvento["Campeonato Mundial Simulado (ILCA 6)"]).toMatchObject({
        nivel: "mundial",
        posicao: 7,
      });
      expect(porEvento["Mundial Juvenil Simulado (ILCA 6)"]).toMatchObject({ nivel: "mundial" });
      expect(porEvento["Campeonato Continental Simulado (ILCA 6)"]).toMatchObject({
        nivel: "continental",
      });
      // World Cup e evento sem nível ficam registrados, mas não pontuam.
      expect(porEvento["Copa do Mundo de Vela Simulada (ILCA 6)"]?.nivel).toBe(
        "internacional_aberto",
      );
      expect(porEvento["Troféu Simulado de Primavera (ILCA 6)"]?.nivel).toBe(
        "internacional_aberto",
      );
      const linha = await p.db.query<{
        link_oficial: string;
        ws_ref: string;
        registrado_por: string;
      }>(
        "select link_oficial, ws_ref, registrado_por from resultados_regata where atleta_id = $1 and fonte = 'world_sailing' limit 1",
        [id],
      );
      expect(linha.rows[0]!.link_oficial).toBe("https://www.sailing.org/sailor/?ref=BRATESTE01");
      expect(linha.rows[0]!.ws_ref).toMatch(/^sim-b01-/);
    });

    it("um resultado mundial muda a nota P12 (perf_mundial), e nível nulo não pontua", async () => {
      const f = await ficha();
      // Melhor colocação do mundial: 3º no Mundial Juvenil (nota 5); continental: 2º (nota 5).
      expect(nota(f, "perf_mundial")).toBe(5);
      expect(nota(f, "perf_continental")).toBe(5);
      expect(nota(f, "perf_nacional")).toBe(0);
    });

    it("invalidar tira o resultado da nota e dos gates; revalidar devolve", async () => {
      const antes = await ficha();
      const juvenil = resultados.find((r) => r.evento.startsWith("Mundial Juvenil"))!;
      const copa = resultados.find((r) => r.evento.startsWith("Copa do Mundo"))!;

      // Motivo é obrigatório; outro treinador não alcança o atleta.
      expect(
        (
          await chamar(treinadoraAuth, "PUT", `/resultados/${juvenil.id}/validacao`, {
            decisao: "recusar",
          })
        ).status,
      ).toBe(400);
      const auth2 = await tokenDoOutroTreinador();
      expect(
        (
          await chamar(auth2, "PUT", `/resultados/${juvenil.id}/validacao`, {
            decisao: "recusar",
            motivo: "x errado",
          })
        ).status,
      ).toBe(404);

      const inv = await chamar(treinadoraAuth, "PUT", `/resultados/${juvenil.id}/validacao`, {
        decisao: "recusar",
        motivo: "Colocação errada na World Sailing",
      });
      expect(inv.status).toBe(200);
      expect(inv.corpo).toMatchObject({
        fonte: "world_sailing",
        status: "recusado",
        motivo: "Colocação errada na World Sailing",
      });
      // Sem o 3º do juvenil, vale o 7º do Mundial (nota 4).
      expect(nota(await ficha(), "perf_mundial")).toBe(4);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}/resultados?status=recusado`)).corpo
          .itens,
      ).toHaveLength(1);

      // Invalidar de novo a mesma situação: 409. Revalidar um que nunca foi invalidado: 409.
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", `/resultados/${juvenil.id}/validacao`, {
            decisao: "recusar",
            motivo: "de novo",
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", `/resultados/${copa.id}/validacao`, {
            decisao: "validar",
          })
        ).status,
      ).toBe(409);

      const revalidado = await chamar(
        treinadoraAuth,
        "PUT",
        `/resultados/${juvenil.id}/validacao`,
        {
          decisao: "validar",
        },
      );
      expect(revalidado.corpo).toMatchObject({ status: "validado", motivo: null });
      expect(nota(await ficha(), "perf_mundial")).toBe(5);

      // Gates (G3 conta eventos internacionais na janela): a Copa invalidada sai da contagem.
      const g3Antes = g3(antes);
      await chamar(treinadoraAuth, "PUT", `/resultados/${copa.id}/validacao`, {
        decisao: "recusar",
        motivo: "Evento duplicado",
      });
      const g3Depois = g3(await ficha());
      const n = (m: string) => Number(/^(\d+)/.exec(m)?.[1] ?? "0");
      expect(n(g3Depois)).toBe(n(g3Antes) - 1);
      await chamar(treinadoraAuth, "PUT", `/resultados/${copa.id}/validacao`, {
        decisao: "validar",
      });
      expect(g3(await ficha())).toBe(g3Antes);
    });

    it("a auditoria registra a importação só com contagens (nada do conteúdo)", async () => {
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'importar_world_sailing' and entidade_id = $1",
        [id],
      );
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0]!.detalhes).toEqual({
        modo: "simulado",
        status: "ok",
        resultadosNovos: 5,
        rankingNovos: 4,
        automatica: false,
      });
      const decisoes = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'decidir_resultado' and entidade_id = $1",
        [id],
      );
      expect(JSON.stringify(decisoes.rows)).not.toMatch(/Colocação errada|Evento duplicado/);
    });

    it("GET mostra o link, a última busca e o ranking (mais recente primeiro)", async () => {
      const g = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}/world-sailing`);
      expect(g.status).toBe(200);
      expect(g.corpo).toMatchObject({
        perfilUrl: "https://www.sailing.org/sailor/?ref=BRATESTE01",
        importacaoAtiva: true,
        ultimaImportacao: { status: "ok" },
      });
      expect(g.corpo.ranking).toHaveLength(4);
      expect(g.corpo.ranking[0]).toEqual({
        data: "2026-06-30",
        classe: "ILCA 6",
        tipo: "Senior",
        posicao: 18,
        pontos: 412.5,
      });
      expect(new Set(g.corpo.ranking.map((k: { classe: string }) => k.classe)).size).toBe(2);
    });

    it("rate limit: nova busca em menos de 60 s dá 429; depois não duplica nada", async () => {
      const cedo = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/world-sailing`);
      expect(cedo.status).toBe(429);
      expect(cedo.corpo.erro).toBe("limite_excedido");

      avancar(61);
      modoFonte = "simulada";
      const r = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/world-sailing`);
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ status: "ok", resultadosNovos: 0, rankingNovos: 0 });
      expect(
        await contar("resultados_regata where atleta_id = $1 and fonte = 'world_sailing'", [id]),
      ).toBe(5);
      expect(await contar("world_sailing_ranking where atleta_id = $1", [id])).toBe(4);
      expect(await contar("world_sailing_importacoes where atleta_id = $1", [id])).toBe(2);
      // A invalidação sobrevive a uma nova busca: o resultado não volta como novo.
    });

    it("a nova busca não desfaz uma invalidação", async () => {
      const copa = resultados.find((r) => r.evento.startsWith("Copa do Mundo"))!;
      await chamar(EMAILS_DEMO.gestor, "PUT", `/resultados/${copa.id}/validacao`, {
        decisao: "recusar",
        motivo: "Evento duplicado",
      });
      avancar(61);
      await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/world-sailing`);
      const lista = await chamar(
        EMAILS_DEMO.gestor,
        "GET",
        `/atletas/${id}/resultados?status=recusado`,
      );
      expect(lista.corpo.itens).toHaveLength(1);
      await chamar(EMAILS_DEMO.gestor, "PUT", `/resultados/${copa.id}/validacao`, {
        decisao: "validar",
      });
    });

    it("matriz de acesso: IBVAR 403, outro treinador 404, atleta só o próprio e sem POST", async () => {
      const url = `/atletas/${id}/world-sailing`;
      expect((await chamar(EMAILS_DEMO.ibvar, "GET", url)).status).toBe(403);
      expect((await chamar(EMAILS_DEMO.ibvar, "POST", url)).status).toBe(403);

      const outro = await tokenDoOutroTreinador();
      expect((await chamar(outro, "GET", url)).status).toBe(404);
      expect((await chamar(outro, "POST", url)).status).toBe(404);

      // O treinador do atleta e o próprio atleta leem; só o treinador (e o gestor) buscam.
      expect((await chamar(treinadoraAuth, "GET", url)).status).toBe(200);
      expect((await chamar(auth, "GET", url)).status).toBe(200);
      expect((await chamar(auth, "POST", url)).status).toBe(403);
      // Outro atleta (Helena) não vê.
      expect((await chamar(EMAILS_DEMO.atleta, "GET", url)).status).toBe(404);
      expect((await chamar(EMAILS_DEMO.atleta, "POST", url)).status).toBe(403);
      expect((await chamar(null, "GET", url)).status).toBe(401);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${crypto.randomUUID()}/world-sailing`))
          .status,
      ).toBe(404);

      avancar(61);
      modoFonte = "simulada";
      expect((await chamar(treinadoraAuth, "POST", url)).status).toBe(200);
    });

    it("IBVAR não vê a World Sailing nos dados que já recebia (ranking só informação)", async () => {
      // Sem consentimento, o atleta nem aparece para o IBVAR.
      const r = await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${id}/resultados`);
      expect(r.status).toBe(403);
    });
  });

  describe("D20: peso e altura do perfil como sugestão de medida", () => {
    beforeEach(() => {
      ajusteDoPerfil = {};
    });

    interface LinhaMedida {
      id: string;
      peso_kg: string | null;
      altura_cm: string | null;
      medido_em: Date;
      evidencia: string;
      registrado_por: string;
    }
    const medidas = async (id: string) =>
      (
        await p.db.query<LinhaMedida>(
          `select id::text as id, peso_kg, altura_cm, medido_em, evidencia, registrado_por::text as registrado_por
             from medidas_corporais where atleta_id = $1 order by id`,
          [id],
        )
      ).rows;
    const sugestao = async (quem: Quem, id: string) =>
      (await chamar(quem, "GET", `/atletas/${id}/world-sailing`)).corpo.medidaSugerida;
    const decidir = (quem: Quem, id: string, decisao: string) =>
      chamar(quem, "POST", `/atletas/${id}/world-sailing/medida`, { decisao });
    const classFit = async (id: string) =>
      (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}`)).corpo.classFit;
    const buscarDeNovo = async (id: string) => {
      avancar(61);
      return chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${id}/world-sailing`);
    };

    async function novo(wsId: string) {
      const c = await cadastrar(wsId);
      await completar(c.auth, `Atleta ${wsId}`);
      await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${c.id}/termo`, {
        versao: "Piloto 18+ · v1",
      });
      return c;
    }
    const anonimizar = async (alvo: string) => {
      const gestorId = (
        await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
          EMAILS_DEMO.gestor,
        ])
      ).rows[0]!.id;
      const pedido = (
        await p.db.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
           values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
          [alvo, gestorId],
        )
      ).rows[0]!.id;
      return chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${alvo}/anonimizar`, {
        pedidoTitularId: pedido,
        confirmacao: "ANONIMIZAR",
      });
    };

    it("a importação guarda peso, altura e a data de atualização do perfil", async () => {
      const c = await novo("BRATESTE81");
      const l = (
        await p.db.query<Record<string, unknown>>(
          `select peso_kg, altura_cm, perfil_atualizado_em::text as atualizado, medida_decidida_em
             from world_sailing_perfis where atleta_id = $1`,
          [c.id],
        )
      ).rows[0]!;
      expect(l).toEqual({
        peso_kg: "71.5",
        altura_cm: "176.0",
        atualizado: "2026-10-15",
        medida_decidida_em: null,
      });
    });

    it("a sugestão aparece para gestor, treinador e atleta (este sem poder decidir); IBVAR recebe 403", async () => {
      const c = await novo("BRATESTE82");
      const esperado = { pesoKg: 71.5, alturaCm: 176, informadoEm: "2026-10-15" };
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toEqual({ ...esperado, podeDecidir: true });
      expect(await sugestao(treinadoraAuth, c.id)).toEqual({ ...esperado, podeDecidir: true });
      expect(await sugestao(c.auth, c.id)).toEqual({ ...esperado, podeDecidir: false });
      expect(
        (await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${c.id}/world-sailing`)).status,
      ).toBe(403);
      // Só sugestão: nada entra no Class Fit sozinho.
      expect(await classFit(c.id)).toBeNull();
    });

    it("usar cria a medida validada, e o Class Fit e a altura da ficha passam a valer", async () => {
      const c = await novo("BRATESTE83");
      const r = await decidir(treinadoraAuth, c.id, "usar");
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ decisao: "usar", medidaId: expect.any(Number) });
      const m = await medidas(c.id);
      expect(m).toHaveLength(1);
      expect(m[0]).toMatchObject({
        id: String(r.corpo.medidaId),
        peso_kg: "71.5",
        altura_cm: "176.0",
        evidencia: "Perfil World Sailing (autodeclarado), atualizado em 15/10/2026",
        registrado_por: treinadora,
      });
      expect(m[0]!.medido_em.toISOString()).toBe("2026-10-15T12:00:00.000Z");
      const cf = await classFit(c.id);
      expect(cf).toMatchObject({ pesoKg: 71.5, alturaCm: 176 });
      expect(cf.altura.cm).toBe(176);
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toBeNull();
      expect(await sugestao(c.auth, c.id)).toBeNull();
      // Auditoria só com ids e a decisão: nunca peso nem altura.
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'usar_medida_world_sailing' and entidade_id = $1",
        [c.id],
      );
      expect(aud.rows.map((x) => x.detalhes)).toEqual([
        { decisao: "usar", medidaId: r.corpo.medidaId },
      ]);
    });

    it("a medida do perfil respeita a ordem por medido_em (peso mais novo continua valendo)", async () => {
      const c = await novo("BRATESTE84");
      await p.db.query(
        `insert into medidas_corporais (atleta_id, peso_kg, medido_em, evidencia, registrado_por)
         values ($1, 80.2, '2026-11-01T12:00:00Z', 'Pesagem validada', $2)`,
        [c.id, treinadora],
      );
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(200);
      // O peso de 1/11 é mais novo que o do perfil (15/10); a altura só existe na medida do perfil.
      expect(await classFit(c.id)).toMatchObject({ pesoKg: 80.2, alturaCm: 176 });
    });

    it("dispensar tira a sugestão, não cria medida e audita sem valores", async () => {
      const c = await novo("BRATESTE85");
      const r = await decidir(EMAILS_DEMO.gestor, c.id, "dispensar");
      expect(r).toEqual({ status: 200, corpo: { decisao: "dispensar", medidaId: null } });
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toBeNull();
      expect(await medidas(c.id)).toHaveLength(0);
      expect(await classFit(c.id)).toBeNull();
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'dispensar_medida_world_sailing' and entidade_id = $1",
        [c.id],
      );
      expect(aud.rows.map((x) => x.detalhes)).toEqual([{ decisao: "dispensar", medidaId: null }]);
    });

    it("repetir a decisão dá 409", async () => {
      const c = await novo("BRATESTE86");
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(200);
      const outra = await decidir(EMAILS_DEMO.gestor, c.id, "usar");
      expect(outra.status).toBe(409);
      expect(outra.corpo.mensagem).toMatch(/medida sugerida/i);
      expect((await decidir(treinadoraAuth, c.id, "dispensar")).status).toBe(409);
      expect(await medidas(c.id)).toHaveLength(1);
    });

    it("decisão inválida dá 400; sem peso nem altura no perfil não há sugestão (409)", async () => {
      const c = await novo("BRATESTE87");
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "talvez")).status).toBe(400);
      await p.db.query(
        "update world_sailing_perfis set peso_kg = null, altura_cm = null where atleta_id = $1",
        [c.id],
      );
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toBeNull();
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(409);
    });

    it("nova importação com updatedAt diferente oferece de novo; com o mesmo, não", async () => {
      const c = await novo("BRATESTE88");
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "dispensar")).status).toBe(200);

      // Mesmo updatedAt: a decisão vale.
      expect((await buscarDeNovo(c.id)).status).toBe(200);
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toBeNull();

      // O velejador atualizou o perfil: oferece de novo, com os valores novos.
      ajusteDoPerfil = { atualizadoEm: "2026-11-03", pesoKg: 72.4 };
      expect((await buscarDeNovo(c.id)).status).toBe(200);
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toEqual({
        pesoKg: 72.4,
        alturaCm: 176,
        informadoEm: "2026-11-03",
        podeDecidir: true,
      });
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(200);
      expect(await classFit(c.id)).toMatchObject({ pesoKg: 72.4, alturaCm: 176 });
      expect(await medidas(c.id)).toHaveLength(1);

      // Mesma data de novo: não oferece.
      expect((await buscarDeNovo(c.id)).status).toBe(200);
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toBeNull();
    });

    it("sem data de atualização no perfil, a medida vale como de agora", async () => {
      ajusteDoPerfil = { atualizadoEm: null };
      const c = await novo("BRATESTE89");
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).toMatchObject({ informadoEm: null });
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(200);
      const m = (await medidas(c.id))[0]!;
      expect(m.evidencia).toBe("Perfil World Sailing (autodeclarado)");
      expect(m.medido_em.toISOString()).toBe(agora.toISOString());
    });

    it("atleta e IBVAR recebem 403 no POST; outro treinador e atleta inexistente, 404", async () => {
      const c = await novo("BRATESTE90");
      expect((await decidir(c.auth, c.id, "usar")).status).toBe(403);
      expect((await decidir(EMAILS_DEMO.ibvar, c.id, "usar")).status).toBe(403);
      expect((await decidir(EMAILS_DEMO.atleta, c.id, "usar")).status).toBe(403);
      expect((await decidir(await tokenDoOutroTreinador(), c.id, "usar")).status).toBe(404);
      expect((await decidir(null, c.id, "usar")).status).toBe(401);
      expect((await decidir(EMAILS_DEMO.gestor, crypto.randomUUID(), "usar")).status).toBe(404);
      expect(await sugestao(EMAILS_DEMO.gestor, c.id)).not.toBeNull();
      expect(await medidas(c.id)).toHaveLength(0);
    });

    it("atleta anonimizado recebe 409; a sugestão sai e a medida criada fica na série histórica", async () => {
      const c = await novo("BRATESTE91");
      expect((await decidir(EMAILS_DEMO.gestor, c.id, "usar")).status).toBe(200);
      const outro = await novo("BRATESTE92");
      for (const alvo of [c.id, outro.id]) {
        expect((await anonimizar(alvo)).status).toBe(200);
        expect(await contar("world_sailing_perfis where atleta_id = $1", [alvo])).toBe(0);
        expect((await decidir(EMAILS_DEMO.gestor, alvo, "usar")).status).toBe(409);
        expect((await decidir(EMAILS_DEMO.gestor, alvo, "dispensar")).status).toBe(409);
      }
      const m = await medidas(c.id);
      expect(m).toHaveLength(1);
      expect(m[0]!.evidencia).not.toMatch(/World Sailing/);
      expect(await medidas(outro.id)).toHaveLength(0);
    });

    it("o titular recebe o peso e a altura sugeridos na exportação", async () => {
      const c = await novo("BRATESTE93");
      const r = await chamar(c.auth, "GET", "/meus-dados");
      expect(r.status).toBe(200);
      expect(r.corpo.worldSailing.sugestao).toMatchObject({
        pesoKg: 71.5,
        alturaCm: 176,
        perfilAtualizadoEm: "2026-10-15",
        medidaDecididaEm: null,
      });
    });

    it("o log nunca mostra peso nem altura", async () => {
      const c = await novo("BRATESTE94");
      const antes = logs.length;
      await decidir(EMAILS_DEMO.gestor, c.id, "usar");
      await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${c.id}/world-sailing`);
      await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${c.id}`);
      expect(logs.length).toBeGreaterThan(antes);
      expect(logs.slice(antes).join("\n")).not.toMatch(/71\.5|pesoKg|alturaCm|"176/);
    });
  });

  describe("falhas nunca derrubam o cadastro", () => {
    it("falha da World Sailing: 201, status falhou e o código curto no histórico", async () => {
      const c = await cadastrar("BRATESTE21", { modo: "falha" });
      expect(c.r.status).toBe(201);
      expect(c.r.corpo.worldSailing).toEqual({
        status: "falhou",
        resultadosNovos: 0,
        rankingNovos: 0,
      });
      const h = await p.db.query<{ status: string; erro: string; modo: string }>(
        "select status, erro, modo from world_sailing_importacoes where atleta_id = $1",
        [c.id],
      );
      expect(h.rows).toEqual([{ status: "falhou", erro: "http_503", modo: "simulado" }]);
      expect(
        await contar("resultados_regata where atleta_id = $1 and fonte = 'world_sailing'", [c.id]),
      ).toBe(0);
      const g = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${c.id}/world-sailing`);
      expect(g.corpo.ultimaImportacao.status).toBe("falhou");
      expect(g.corpo.ranking).toEqual([]);
    });

    it("tempo esgotado: 201, falhou, tempo_esgotado", async () => {
      const t0 = Date.now();
      const c = await cadastrar("BRATESTE22", { modo: "lenta" });
      expect(Date.now() - t0).toBeLessThan(5000);
      expect(c.r.status).toBe(201);
      expect(c.r.corpo.worldSailing.status).toBe("falhou");
      const h = await p.db.query<{ erro: string }>(
        "select erro from world_sailing_importacoes where atleta_id = $1",
        [c.id],
      );
      expect(h.rows[0]!.erro).toBe("tempo_esgotado");
    });

    it("ID que não existe na World Sailing: 201 e nao_encontrado", async () => {
      const c = await cadastrar("GBRHM15", { modo: "simulada" });
      expect(c.r.status).toBe(201);
      expect(c.r.corpo.worldSailing).toEqual({
        status: "nao_encontrado",
        resultadosNovos: 0,
        rankingNovos: 0,
      });
      expect(await contar("world_sailing_perfis where atleta_id = $1", [c.id])).toBe(0);
      // Sem sugestão: o atleta preenche tudo sozinho.
      const me = await chamar(c.auth, "GET", "/me");
      expect(me.corpo.cadastroPendente.sugestao).toBeNull();
      expect(me.corpo.cadastroPendente.origemSugestao).toBeNull();
    });

    it("BRATESTE02 (sem resultados nem ranking): ok com zero novos e sugestão com gênero M", async () => {
      const c = await cadastrar("BRATESTE02", { modo: "simulada" });
      expect(c.r.corpo.worldSailing).toEqual({ status: "ok", resultadosNovos: 0, rankingNovos: 0 });
      const me = await chamar(c.auth, "GET", "/me");
      expect(me.corpo.cadastroPendente.sugestao).toEqual({
        nome: "Caio Maresia Duarte",
        genero: "M",
        dataNascimento: "2004-09-30",
      });
    });

    it("integração desligada: o cadastro responde desligado e a busca manual também", async () => {
      const app2 = await criarAppDeTeste(p.db, { agora: () => agora });
      try {
        const headers = await p.como(EMAILS_DEMO.gestor);
        const alvo = (
          await p.db.query<{ id: string }>("select id from atletas where ws_id = 'BRATESTE02'")
        ).rows[0]!.id;
        avancar(61);
        const post = await app2.inject({
          method: "POST",
          url: `/atletas/${alvo}/world-sailing`,
          headers,
        });
        expect(post.json()).toEqual({ status: "desligado", resultadosNovos: 0, rankingNovos: 0 });
        const get = await app2.inject({
          method: "GET",
          url: `/atletas/${alvo}/world-sailing`,
          headers,
        });
        expect(get.json().importacaoAtiva).toBe(false);
        const novo = await app2.inject({
          method: "POST",
          url: "/atletas",
          headers,
          payload: {
            wsId: "BRATESTE23",
            email: "brateste23@exemplo.dev",
            classeId: "ilca6",
            treinadorId: treinadora,
            confirmaMaioridade: true,
          },
        });
        expect(novo.statusCode).toBe(201);
        expect(novo.json().worldSailing.status).toBe("desligado");
      } finally {
        await app2.close();
      }
    });
  });

  describe("sugestão de cadastro: o VelaID vale antes da World Sailing", () => {
    it("com VelaID válido, a origem é velaid; sem ele, world_sailing", async () => {
      const a = await cadastrar("BRATESTE31", { velaid: "MG-T15" });
      const me = await chamar(a.auth, "GET", "/me");
      expect(me.corpo.cadastroPendente.origemSugestao).toBe("velaid");
      expect(me.corpo.cadastroPendente.sugestao.nome).toBe("Renata Bastos");

      const b = await cadastrar("BRATESTE32");
      const meB = await chamar(b.auth, "GET", "/me");
      expect(meB.corpo.cadastroPendente.origemSugestao).toBe("world_sailing");
      expect(meB.corpo.cadastroPendente.sugestao.nome).toBe("Marina Ventosa Lemos");
    });
  });

  describe("foto e bio sugeridas", () => {
    it("o atleta aceita foto e bio: o servidor baixa de assets.sailing.org, sem EXIF, e corta a bio em 500", async () => {
      bioLonga = true;
      const a = await cadastrar("BRATESTE41");
      bioLonga = false;
      await completar(a.auth);

      const perfil = await chamar(a.auth, "GET", "/me/perfil");
      expect(perfil.corpo.sugestaoWorldSailing.fotoUrl).toMatch(
        /^https:\/\/assets\.sailing\.org\//,
      );
      expect(perfil.corpo.sugestaoWorldSailing.bio.length).toBeLessThanOrEqual(500);

      urlsDeFoto.length = 0;
      const r = await chamar(a.auth, "POST", "/me/perfil/world-sailing", {
        usarFoto: true,
        usarBio: true,
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ usouFoto: true, usouBio: true });
      expect(r.corpo.fotoUrl).toMatch(/^https:\/\/storage\.teste\/assinado\/fotos\//);
      expect(r.corpo.bio.length).toBeLessThanOrEqual(500);
      expect(r.corpo.bio.endsWith("palavra")).toBe(true);
      expect(urlsDeFoto).toHaveLength(1);
      expect(urlsDeFoto[0]).toMatch(/^https:\/\/assets\.sailing\.org\//);

      // A foto guardada não carrega o EXIF.
      const caminho = (
        await p.db.query<{ foto_caminho: string }>(
          "select foto_caminho from usuarios where atleta_id = $1",
          [a.id],
        )
      ).rows[0]!.foto_caminho;
      const guardada = Buffer.from(p.armazenamento.arquivos.get(caminho)!.bytes);
      expect(guardada.includes("SEGREDO-GPS")).toBe(false);
      expect(guardada.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));

      // Decidiu: some a sugestão e uma segunda decisão dá 409.
      expect((await chamar(a.auth, "GET", "/me/perfil")).corpo.sugestaoWorldSailing).toBeNull();
      expect(
        (
          await chamar(a.auth, "POST", "/me/perfil/world-sailing", {
            usarFoto: false,
            usarBio: false,
          })
        ).status,
      ).toBe(409);

      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'aceitar_sugestao_world_sailing'",
      );
      expect(aud.rows[0]!.detalhes).toEqual({ usouFoto: true, usouBio: true });
    });

    it("dispensar marca a decisão e não muda a bio nem a foto", async () => {
      const a = await cadastrar("BRATESTE42");
      await completar(a.auth);
      urlsDeFoto.length = 0;
      const r = await chamar(a.auth, "POST", "/me/perfil/world-sailing", {
        usarFoto: false,
        usarBio: false,
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ usouFoto: false, usouBio: false, fotoUrl: null, bio: null });
      expect(urlsDeFoto).toEqual([]);
      expect((await chamar(a.auth, "GET", "/me/perfil")).corpo.sugestaoWorldSailing).toBeNull();
    });

    it("falha ao baixar a foto: 503, e a decisão continua em aberto", async () => {
      const a = await cadastrar("BRATESTE43");
      await completar(a.auth);
      const anterior = respostaFoto;
      respostaFoto = () => Promise.reject(new TypeError("fetch failed"));
      const r = await chamar(a.auth, "POST", "/me/perfil/world-sailing", {
        usarFoto: true,
        usarBio: true,
      });
      respostaFoto = anterior;
      expect(r.status).toBe(503);
      expect((await chamar(a.auth, "GET", "/me/perfil")).corpo.sugestaoWorldSailing).not.toBeNull();
      expect(
        await contar("world_sailing_perfis where atleta_id = $1 and foto_bio_decidida_em is null", [
          a.id,
        ]),
      ).toBe(1);
    });

    it("conteúdo que não é JPEG nem PNG: 400, sem decidir", async () => {
      const a = await cadastrar("BRATESTE44");
      await completar(a.auth);
      const anterior = respostaFoto;
      respostaFoto = () =>
        Promise.resolve(new Response("<html>não é imagem</html>", { status: 200 }));
      const r = await chamar(a.auth, "POST", "/me/perfil/world-sailing", {
        usarFoto: true,
        usarBio: false,
      });
      respostaFoto = anterior;
      expect(r.status).toBe(400);
      expect(
        await contar("world_sailing_perfis where atleta_id = $1 and foto_bio_decidida_em is null", [
          a.id,
        ]),
      ).toBe(1);
    });

    it("pedir foto que a World Sailing não trouxe: 400; sem sugestão nenhuma: 404; gestor: 403", async () => {
      // BRATESTE02 já foi cadastrado acima: o simulador não traz foto nem bio para ele.
      const sem = await p.db.query<{ id: string }>(
        "select id from atletas where ws_id = 'BRATESTE02'",
      );
      expect(sem.rows).toHaveLength(1);
      const email = "brateste02@exemplo.dev";
      const authUserId = crypto.randomUUID();
      await p.db.query("update usuarios set auth_user_id = $1 where email = $2", [
        authUserId,
        email,
      ]);
      const auth = cabecalhoAuth(await tokenPara(authUserId));
      await completar(auth, "Caio Maresia Duarte");
      expect(
        (await chamar(auth, "POST", "/me/perfil/world-sailing", { usarFoto: true, usarBio: false }))
          .status,
      ).toBe(400);
      expect(
        (await chamar(auth, "POST", "/me/perfil/world-sailing", { usarFoto: false, usarBio: true }))
          .status,
      ).toBe(400);

      // Helena (seed) nunca teve busca: sem sugestão, 404.
      expect(
        (
          await chamar(EMAILS_DEMO.atleta, "POST", "/me/perfil/world-sailing", {
            usarFoto: false,
            usarBio: false,
          })
        ).status,
      ).toBe(404);
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "POST", "/me/perfil/world-sailing", {
            usarFoto: false,
            usarBio: false,
          })
        ).status,
      ).toBe(403);
      expect(
        (await chamar(EMAILS_DEMO.atleta, "POST", "/me/perfil/world-sailing", { usarFoto: "sim" }))
          .status,
      ).toBe(400);
    });
  });

  describe("regra WS_NIVEIS (P13)", () => {
    it("vem do seed, é editável pelo gestor e a próxima importação usa a nova regra", async () => {
      const lida = await chamar(EMAILS_DEMO.gestor, "GET", "/parametros");
      const regra = lida.corpo.regras.find((x: { codigo: string }) => x.codigo === "WS_NIVEIS");
      expect(regra.valor.niveis["World Championships"]).toBe("mundial");
      expect(regra.valor.niveis.Continental).toBe("continental");

      // Treinador lê (GET) mas não edita.
      expect(
        (
          await chamar(EMAILS_DEMO.treinadora, "PUT", "/parametros", {
            regras: { WS_NIVEIS: regra.valor },
          })
        ).status,
      ).toBe(403);
      for (const ruim of [
        { niveis: { X: "nivel_inexistente" } },
        { niveis: { "": "mundial" } },
        { niveis: { X: "mundial" }, extra: 1 },
        { niveis: { ["N".repeat(121)]: "mundial" } },
      ]) {
        const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
          regras: { WS_NIVEIS: ruim },
        });
        expect(r.status, JSON.stringify(ruim)).toBe(400);
        expect(r.corpo.mensagem).toContain("WS_NIVEIS");
      }

      // Com "Sailing World Cup Series" mapeado para continental, o atleta novo ganha perf_continental pela Copa.
      const nova = {
        niveis: { ...regra.valor.niveis, "Sailing World Cup Series": "continental" },
      };
      const ok = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        regras: { WS_NIVEIS: nova },
      });
      expect(ok.status).toBe(200);
      const c = await cadastrar("BRATESTE51");
      const niveis = await p.db.query<{ nivel: string }>(
        "select nivel from resultados_regata where atleta_id = $1 and evento like 'Copa do Mundo%'",
        [c.id],
      );
      expect(niveis.rows[0]!.nivel).toBe("continental");
      // Volta ao valor original.
      await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        regras: { WS_NIVEIS: regra.valor },
      });
    });
  });

  describe("anonimização", () => {
    it("apaga ranking e sugestão, zera a referência dos resultados e deixa só números no histórico", async () => {
      const c = await cadastrar("BRATESTE61");
      await completar(c.auth, "Atleta Para Anonimizar");
      expect(await contar("world_sailing_ranking where atleta_id = $1", [c.id])).toBe(4);
      const gestorId = (
        await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
          EMAILS_DEMO.gestor,
        ])
      ).rows[0]!.id;
      const pedido = (
        await p.db.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
           values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
          [c.id, gestorId],
        )
      ).rows[0]!.id;
      const r = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${c.id}/anonimizar`, {
        pedidoTitularId: pedido,
        confirmacao: "ANONIMIZAR",
      });
      expect(r.status).toBe(200);

      expect(await contar("world_sailing_ranking where atleta_id = $1", [c.id])).toBe(0);
      expect(await contar("world_sailing_perfis where atleta_id = $1", [c.id])).toBe(0);
      const res = await p.db.query<{ ws_ref: string | null; anonimizado: boolean; evento: string }>(
        "select ws_ref, anonimizado, evento from resultados_regata where atleta_id = $1 and fonte = 'world_sailing'",
        [c.id],
      );
      expect(res.rows).toHaveLength(5);
      expect(
        res.rows.every(
          (x) => x.ws_ref === null && x.anonimizado && x.evento === "Evento anonimizado",
        ),
      ).toBe(true);
      const hist = await p.db.query<Record<string, unknown>>(
        "select * from world_sailing_importacoes where atleta_id = $1",
        [c.id],
      );
      expect(hist.rows).toHaveLength(1);
      expect(JSON.stringify(hist.rows)).not.toMatch(/Marina|Ventosa|BRATESTE61/);

      // Depois de anonimizado: não há busca nem leitura.
      expect(
        (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${c.id}/world-sailing`)).status,
      ).toBe(409);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${c.id}/world-sailing`)).status,
      ).toBe(404);
    });
  });

  describe("exportação do titular (LGPD)", () => {
    it("inclui o que veio da World Sailing", async () => {
      const c = await cadastrar("BRATESTE71");
      await completar(c.auth, "Atleta Exporta");
      const r = await chamar(c.auth, "GET", "/meus-dados");
      expect(r.status).toBe(200);
      expect(r.corpo.worldSailing.sugestao).toMatchObject({ nome: "Marina Ventosa Lemos" });
      expect(r.corpo.worldSailing.ranking).toHaveLength(4);
      expect(r.corpo.worldSailing.buscas).toHaveLength(1);
      expect(
        r.corpo.resultados.filter((x: { fonte: string }) => x.fonte === "world_sailing"),
      ).toHaveLength(5);
    });
  });

  // Outro treinador do seed (Marcos), com login próprio.
  async function tokenDoOutroTreinador() {
    const marcos = (
      await p.db.query<{ id: string }>(
        "select id from usuarios where papel = 'treinador' and id <> $1 and ativo limit 1",
        [treinadora],
      )
    ).rows[0]!.id;
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authUserId, marcos]);
    return cabecalhoAuth(await tokenPara(authUserId));
  }
});

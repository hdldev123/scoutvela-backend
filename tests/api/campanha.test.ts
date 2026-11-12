import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("financeiro da campanha e resultados internacionais", () => {
  let p: Piloto;
  let idAna: string; // SC-T01, treinadora Ana
  let idMarcos: string; // RS-T02, Marcos Pires
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    idAna = await p.idDe("SC-T01");
    idMarcos = await p.idDe("RS-T02");
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: email ? await p.como(email) : {},
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const ficha = async (id: string) =>
    (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}`)).corpo;
  const gate = (f: { gates: { itens: { gate: number; status: string }[] } }, n: number) =>
    f.gates.itens.find((i) => i.gate === n)!.status;
  const contar = async (tabela: string, onde = "true") =>
    Number(
      (await p.db.query<{ n: string }>(`select count(*)::text as n from ${tabela} where ${onde}`))
        .rows[0]!.n,
    );

  describe("PUT /atletas/:id/financeiro", () => {
    let componenteA: string;
    let componenteB: string;
    beforeAll(async () => {
      const c = await p.db.query<{ id: string }>(
        `select id from componentes_custo order by ordem limit 2`,
      );
      componenteA = c.rows[0]!.id;
      componenteB = c.rows[1]!.id;
    });
    const corpo = (extra: object = {}) => ({
      perfilSuporte: "D",
      mesesAssegurados: 2,
      patrocinioPrivado: "nao",
      componentes: [{ componenteId: componenteA, autonomia: "baixa", apoioCbvela: "alta" }],
      ...extra,
    });

    it("acesso: 401 sem token; treinador, atleta e IBVAR 403", async () => {
      expect((await chamar(null, "PUT", `/atletas/${idAna}/financeiro`, corpo())).status).toBe(401);
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        expect((await chamar(email, "PUT", `/atletas/${idAna}/financeiro`, corpo())).status).toBe(
          403,
        );
      }
    });

    it("valida corpo, componente inexistente ou repetido e atleta inexistente", async () => {
      const g = EMAILS_DEMO.gestor;
      const url = `/atletas/${idAna}/financeiro`;
      const ruim = await chamar(g, "PUT", url, corpo({ perfilSuporte: "E" }));
      expect(ruim.status).toBe(400);
      expect(ruim.corpo).toEqual({ erro: "requisicao_invalida", mensagem: "Requisição inválida." });
      expect((await chamar(g, "PUT", url, corpo({ mesesAssegurados: 121 }))).status).toBe(400);
      const inexistente = [{ componenteId: "nao_existe", autonomia: "alta", apoioCbvela: "baixa" }];
      expect((await chamar(g, "PUT", url, corpo({ componentes: inexistente }))).status).toBe(400);
      const dup = { componenteId: componenteA, autonomia: "alta", apoioCbvela: "baixa" };
      expect((await chamar(g, "PUT", url, corpo({ componentes: [dup, dup] }))).status).toBe(400);
      expect(
        (await chamar(g, "PUT", `/atletas/${crypto.randomUUID()}/financeiro`, corpo())).status,
      ).toBe(404);
    });

    it("grava nova linha sem apagar a anterior; G4 e a lista de investimento refletem o perfil", async () => {
      const antes = await ficha(idAna);
      const invAntes = (await chamar(EMAILS_DEMO.gestor, "GET", "/investimento")).corpo;
      const linhasAntes = await contar("financeiro_campanha", `atleta_id = '${idAna}'`);
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${idAna}/financeiro`, corpo());
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({
        perfilSuporte: "D",
        mesesAssegurados: 2,
        patrocinioPrivado: "nao",
        componentes: [
          expect.objectContaining({ id: componenteA, autonomia: "baixa", apoioCbvela: "alta" }),
        ],
      });
      expect(await contar("financeiro_campanha", `atleta_id = '${idAna}'`)).toBe(linhasAntes + 1);

      const depois = await ficha(idAna);
      expect(depois.financeiro).toEqual(r.corpo);
      expect(gate(depois, 4)).toBe("alerta");
      expect(depois.score).toBe(antes.score); // financeiro não entra no score

      // O painel passa a contar o atleta como dependente de apoio (perfil C ou D) e o G4 agregado muda.
      const inv = (await chamar(EMAILS_DEMO.gestor, "GET", "/investimento")).corpo;
      const jaDependia =
        antes.financeiro?.perfilSuporte === "C" || antes.financeiro?.perfilSuporte === "D";
      expect(inv.kpis.dependentesApoio).toBe(invAntes.kpis.dependentesApoio + (jaDependia ? 0 : 1));
      const g4 = (c: typeof inv) => c.gates.find((g: { gate: number }) => g.gate === 4);
      expect(g4(inv).alerta - g4(invAntes).alerta).toBe(gate(antes, 4) === "alerta" ? 0 : 1);
    });

    it("novo perfil A devolve o G4 a apto e sai da lista de investimento", async () => {
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${idAna}/financeiro`, {
        perfilSuporte: "A",
        mesesAssegurados: null,
        patrocinioPrivado: null,
        componentes: [
          { componenteId: componenteA, autonomia: "alta", apoioCbvela: "baixa" },
          { componenteId: componenteB, autonomia: "parcial", apoioCbvela: "media" },
        ],
      });
      expect(r.status).toBe(200);
      expect(r.corpo.componentes).toHaveLength(2);
      expect(gate(await ficha(idAna), 4)).toBe("apto");
      const inv = (await chamar(EMAILS_DEMO.gestor, "GET", "/investimento")).corpo;
      expect(
        (inv.ondeInvestir as { atleta: { id: string } }[]).some((a) => a.atleta.id === idAna),
      ).toBe(false);
    });

    it("auditoria sem valores", async () => {
      const aud = await p.db.query<{ detalhes: unknown }>(
        `select detalhes from auditoria where acao = 'informar_financeiro'`,
      );
      expect(aud.rows.length).toBe(2);
      for (const l of aud.rows) {
        expect(JSON.stringify(l.detalhes)).not.toMatch(
          /"(alta|baixa|parcial|media|nao|sim)"|perfil|meses/,
        );
      }
    });
  });

  describe("POST /atletas/:id/resultados", () => {
    const corpo = (extra: object = {}) => ({
      nivel: "mundial",
      evento: "Mundial ILCA 7 2026",
      data: "2026-10-01",
      posicao: 1,
      tamanhoFrota: 100,
      linkOficial: "https://resultados.exemplo.invalid/mundial-2026",
      ...extra,
    });

    it("acesso: 401, atleta e IBVAR 403, treinador de outro atleta 404", async () => {
      expect((await chamar(null, "POST", `/atletas/${idAna}/resultados`, corpo())).status).toBe(
        401,
      );
      expect(
        (await chamar(EMAILS_DEMO.atleta, "POST", `/atletas/${idAna}/resultados`, corpo())).status,
      ).toBe(403);
      expect(
        (await chamar(EMAILS_DEMO.ibvar, "POST", `/atletas/${idAna}/resultados`, corpo())).status,
      ).toBe(403);
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${idMarcos}/resultados`, corpo()))
          .status,
      ).toBe(404);
    });

    it("valida nível, evento, data futura, posição, frota e link", async () => {
      const u = `/atletas/${idAna}/resultados`;
      const g = EMAILS_DEMO.gestor;
      const ruim = await chamar(g, "POST", u, corpo({ nivel: "brasileiro" }));
      expect(ruim.status).toBe(400);
      expect(ruim.corpo).toEqual({ erro: "requisicao_invalida", mensagem: "Requisição inválida." });
      for (const extra of [
        { evento: "ab" },
        { data: "2026-11-07" },
        { data: "07/11/2026" },
        { posicao: 0 },
        { tamanhoFrota: 0 },
        { posicao: 101 },
        { linkOficial: "http://resultados.exemplo.invalid/x" },
        { linkOficial: "nao é url" },
        { linkOficial: `https://x.invalid/${"a".repeat(500)}` },
      ]) {
        expect((await chamar(g, "POST", u, corpo(extra))).status, JSON.stringify(extra)).toBe(400);
      }
      expect(
        (await chamar(g, "POST", `/atletas/${crypto.randomUUID()}/resultados`, corpo())).status,
      ).toBe(404);
    });

    it("lança como manual, muda os gates G2 e G3 e recusa duplicado", async () => {
      // Atleta do seed cujos G2 e G3 ainda não são aptos.
      let alvo: string | null = null;
      const todos = await p.db.query<{ id: string }>(
        `select id from atletas where treinador_id is not null order by velaid_codigo`,
      );
      for (const a of todos.rows) {
        const f = await ficha(a.id);
        if (gate(f, 2) !== "apto" && gate(f, 3) !== "apto") {
          alvo = a.id;
          break;
        }
      }
      expect(alvo, "nenhum atleta do seed com G2 e G3 não aptos").not.toBeNull();
      const dono = await p.db.query<{ email: string }>(
        `select u.email from atletas a join usuarios u on u.id = a.treinador_id where a.id = $1`,
        [alvo],
      );
      const antes = await ficha(alvo!);
      const base = await contar("resultados_regata", `atleta_id = '${alvo}'`);

      // Treinador dono lança (os 14 do seed estão com treinadores que talvez não tenham login; usa gestor se não for a Ana).
      const quem =
        dono.rows[0]!.email === EMAILS_DEMO.treinadora
          ? EMAILS_DEMO.treinadora
          : EMAILS_DEMO.gestor;
      const r = await chamar(quem, "POST", `/atletas/${alvo}/resultados`, corpo());
      expect(r.status).toBe(201);
      expect(r.corpo).toEqual({
        data: "2026-10-01",
        nivel: "mundial",
        evento: "Mundial ILCA 7 2026",
        posicao: 1,
        tamanhoFrota: 100,
        internacional: true,
        pontosCbvela: null,
        fonte: "manual",
        linkOficial: "https://resultados.exemplo.invalid/mundial-2026",
      });
      const linha = await p.db.query<{ registrado_por: string | null }>(
        `select registrado_por from resultados_regata where atleta_id = $1 and fonte = 'manual' and evento = 'Mundial ILCA 7 2026'`,
        [alvo],
      );
      expect(linha.rows).toHaveLength(1);
      expect(linha.rows[0]!.registrado_por).not.toBeNull();

      const depois = await ficha(alvo!);
      expect(depois.resultados).toHaveLength(base + 1);
      expect(depois.resultados).toContainEqual(r.corpo);
      expect(gate(depois, 2)).toBe("apto");
      const motivo = (f: typeof antes, n: number) =>
        f.gates.itens.find((i: { gate: number }) => i.gate === n).motivo;
      expect(motivo(depois, 2)).not.toBe(motivo(antes, 2));
      expect(motivo(depois, 3)).not.toBe(motivo(antes, 3));

      const dup = await chamar(
        EMAILS_DEMO.gestor,
        "POST",
        `/atletas/${alvo}/resultados`,
        corpo({ evento: "mundial ilca 7 2026" }),
      );
      expect(dup.status).toBe(409);
      // mesmo evento em outra data não é duplicado
      expect(
        (
          await chamar(
            EMAILS_DEMO.gestor,
            "POST",
            `/atletas/${alvo}/resultados`,
            corpo({ data: "2026-09-01" }),
          )
        ).status,
      ).toBe(201);

      const aud = await p.db.query<{ detalhes: unknown }>(
        `select detalhes from auditoria where acao = 'lancar_resultado'`,
      );
      expect(aud.rows.length).toBeGreaterThanOrEqual(2);
      for (const l of aud.rows) {
        const t = JSON.stringify(l.detalhes);
        expect(t).not.toContain("Mundial");
        expect(t).not.toContain("https");
      }
    });

    it("treinador lança para o próprio atleta", async () => {
      const r = await chamar(
        EMAILS_DEMO.treinadora,
        "POST",
        `/atletas/${idAna}/resultados`,
        corpo({ evento: "Sul-Americano ILCA 7 2026", nivel: "sul_americano" }),
      );
      expect(r.status).toBe(201);
    });
  });
});

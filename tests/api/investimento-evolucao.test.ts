import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface Ciclo {
  ciclo: { id: string; nome: string; fechadoEm: string | null };
  atletas: number;
  scoreMedio: number | null;
  mediaPorPilar: { pilarId: string; nomeCurto: string; media: number | null }[] | null;
  funil: { faixaId: string; nome: string; n: number }[] | null;
  aptosNosGates: number | null;
  congelamentoCompleto: boolean;
  suprimido: boolean;
}
interface Evolucao {
  ciclos: Ciclo[];
  meta: {
    percentual: number;
    cicloBase: { id: string; nome: string } | null;
    cicloAtual: { id: string; nome: string } | null;
    mediaBase: number | null;
    mediaAtual: number | null;
    variacaoPercentual: number | null;
    atingida: boolean | null;
  };
}

describe("D12: GET /investimento/evolucao", () => {
  let p: Piloto;
  let classeDaHelena: string;

  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
    classeDaHelena = (
      await p.db.query<{ classe_id: string }>("select classe_id from atletas where id = $1", [
        await p.idDe("SP-T07"),
      ])
    ).rows[0]!.classe_id;
  });
  afterAll(() => p.encerrar());

  const ler = async (email: string | null, query = "") => {
    const r = await p.app.inject({
      method: "GET",
      url: `/investimento/evolucao${query}`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<Evolucao>(), texto: r.body };
  };
  const parametros = async (regras: Record<string, unknown>, email: string = EMAILS_DEMO.gestor) =>
    p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: { regras },
    });
  const fecharAberto = async () => {
    const aberto = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
    const r = await p.app.inject({
      method: "POST",
      url: `/ciclos/${aberto}/fechar`,
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    expect(r.statusCode).toBe(200);
    return aberto;
  };

  it("acesso: sem token 401; treinador e atleta 403; classe inexistente 404", async () => {
    expect((await ler(null)).status).toBe(401);
    expect((await ler(EMAILS_DEMO.treinadora)).status).toBe(403);
    expect((await ler(EMAILS_DEMO.atleta)).status).toBe(403);
    expect((await ler(EMAILS_DEMO.gestor, "?classeId=nao-existe")).status).toBe(404);
    expect((await ler(EMAILS_DEMO.ibvar, "?classeId=nao-existe")).status).toBe(404);
  });

  it("ciclos antigos (só score e faixa): pilares e gates nulos, sem quebrar", async () => {
    // O seed tem dois ciclos fechados, os dois antes do congelamento completo.
    const { status, corpo } = await ler(EMAILS_DEMO.gestor);
    expect(status).toBe(200);
    expect(corpo.ciclos.map((c) => c.ciclo.nome)).toEqual(["Setembro de 2026", "Outubro de 2026"]);
    for (const c of corpo.ciclos) {
      expect(c).toMatchObject({
        atletas: 14,
        congelamentoCompleto: false,
        mediaPorPilar: null,
        aptosNosGates: null,
        suprimido: false,
      });
      expect(c.scoreMedio).toBeTypeOf("number");
      expect(c.funil!.reduce((t, f) => t + f.n, 0)).toBe(14);
      expect(c.ciclo.fechadoEm).not.toBeNull();
      // Média conferida direto no banco.
      const r = await p.db.query<{ m: string }>(
        "select avg(score)::text as m from scores_ciclo where ciclo_id = $1",
        [c.ciclo.id],
      );
      expect(c.scoreMedio).toBeCloseTo(Number(r.rows[0]!.m), 2);
    }
  });

  it("dois ciclos fechados: meta com o padrão de +10%, não atingida", async () => {
    const { corpo } = await ler(EMAILS_DEMO.gestor);
    const [set, out] = corpo.ciclos;
    expect(corpo.meta.cicloBase?.nome).toBe("Setembro de 2026");
    expect(corpo.meta.cicloAtual?.nome).toBe("Outubro de 2026");
    expect(corpo.meta.percentual).toBe(10);
    expect(corpo.meta.mediaBase).toBe(set!.scoreMedio);
    expect(corpo.meta.mediaAtual).toBe(out!.scoreMedio);
    const variacao = ((out!.scoreMedio! - set!.scoreMedio!) / set!.scoreMedio!) * 100;
    expect(corpo.meta.variacaoPercentual).toBeCloseTo(variacao, 1);
    expect(corpo.meta.atingida).toBe(false);
  });

  it("fechar o ciclo aberto acrescenta o ciclo com pilares, funil e aptos congelados", async () => {
    await fecharAberto();
    const { corpo } = await ler(EMAILS_DEMO.gestor);
    expect(corpo.ciclos.map((c) => c.ciclo.nome)).toEqual([
      "Setembro de 2026",
      "Outubro de 2026",
      "Novembro de 2026",
    ]);
    const nov = corpo.ciclos[2]!;
    expect(nov.congelamentoCompleto).toBe(true);
    expect(nov.mediaPorPilar).toHaveLength(9);
    expect(nov.mediaPorPilar!.every((m) => m.media !== null && m.media >= 0 && m.media <= 5)).toBe(
      true,
    );
    expect(nov.funil!.reduce((t, f) => t + f.n, 0)).toBe(14);
    const aptos = await p.db.query<{ n: string }>(
      "select count(*)::text as n from fechamento_atleta_ciclo where ciclo_id = $1 and status_final = 'apto'",
      [nov.ciclo.id],
    );
    expect(nov.aptosNosGates).toBe(Number(aptos.rows[0]!.n));
    // A meta passa a comparar Outubro com Novembro.
    expect(corpo.meta.cicloBase?.nome).toBe("Outubro de 2026");
    expect(corpo.meta.cicloAtual?.nome).toBe("Novembro de 2026");
    // O funil do ciclo congelado bate com as faixas gravadas.
    const faixas = await p.db.query<{ faixa_id: string; n: string }>(
      "select faixa_id, count(*)::text as n from scores_ciclo where ciclo_id = $1 group by 1",
      [nov.ciclo.id],
    );
    for (const f of faixas.rows) {
      expect(nov.funil!.find((x) => x.faixaId === f.faixa_id)!.n).toBe(Number(f.n));
    }
  });

  it("meta atingida e não atingida, com o percentual editável e auditado", async () => {
    // Ciclo seguinte, com o score de todos 20% maior: a alta da média passa de 10%.
    const nov = (await ler(EMAILS_DEMO.gestor)).corpo.ciclos[2]!;
    const dez = (
      await p.db.query<{ id: string }>(
        `insert into ciclos_avaliacao (nome, inicio, prazo, status, fechado_em)
         values ('Dezembro de 2026', '2026-12-01', '2026-12-31', 'fechado', '2026-12-31T23:59:59Z') returning id`,
      )
    ).rows[0]!.id;
    await p.db.query(
      `insert into scores_ciclo (atleta_id, ciclo_id, score, faixa_id)
       select atleta_id, $1::uuid, least(score * 1.2, 100), faixa_id from scores_ciclo where ciclo_id = $2`,
      [dez, nov.ciclo.id],
    );
    const atingida = (await ler(EMAILS_DEMO.gestor)).corpo.meta;
    expect(atingida).toMatchObject({
      percentual: 10,
      cicloBase: { nome: "Novembro de 2026" },
      cicloAtual: { nome: "Dezembro de 2026" },
      atingida: true,
    });
    expect(atingida.variacaoPercentual).toBeGreaterThan(10);

    const r = await parametros({ META_EVOLUCAO: { percentual: 50 } });
    expect(r.statusCode).toBe(200);
    const naoAtingida = (await ler(EMAILS_DEMO.gestor)).corpo.meta;
    expect(naoAtingida).toMatchObject({ percentual: 50, atingida: false });
    expect(naoAtingida.variacaoPercentual).toBe(atingida.variacaoPercentual);

    const aud = await p.db.query<{
      detalhes: { regras: { antes: Record<string, unknown>; depois: Record<string, unknown> } };
    }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.regras.antes.META_EVOLUCAO).toEqual({ percentual: 10 });
    expect(aud.rows[0]!.detalhes.regras.depois.META_EVOLUCAO).toEqual({ percentual: 50 });
    await parametros({ META_EVOLUCAO: { percentual: 10 } });
  });

  it("validação das regras novas e só o gestor edita", async () => {
    for (const regras of [
      { META_EVOLUCAO: { percentual: -1 } },
      { META_EVOLUCAO: { percentual: "10" } },
      { META_EVOLUCAO: { percentual: 10, extra: 1 } },
      { MIN_GRUPO_AGREGADO: { minimo: 0 } },
      { MIN_GRUPO_AGREGADO: { minimo: 2.5 } },
      { MIN_GRUPO_AGREGADO: {} },
    ]) {
      const r = await parametros(regras);
      expect(r.statusCode, JSON.stringify(regras)).toBe(400);
      expect(r.json<{ mensagem: string }>().mensagem).toMatch(/META_EVOLUCAO|MIN_GRUPO_AGREGADO/);
    }
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await parametros({ MIN_GRUPO_AGREGADO: { minimo: 1 } }, email)).statusCode).toBe(403);
    }
    const lidas = await p.app.inject({
      method: "GET",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    const regras = lidas.json<{ regras: { codigo: string; valor: unknown }[] }>().regras;
    expect(regras.find((x) => x.codigo === "MIN_GRUPO_AGREGADO")?.valor).toEqual({ minimo: 3 });
    expect(regras.find((x) => x.codigo === "META_EVOLUCAO")?.valor).toEqual({ percentual: 10 });
  });

  it("filtro por classe: gestor vê o recorte; IBVAR recebe grupo pequeno suprimido", async () => {
    const gestor = await ler(EMAILS_DEMO.gestor, `?classeId=${classeDaHelena}`);
    expect(gestor.status).toBe(200);
    expect(gestor.corpo.ciclos).toHaveLength(4);
    for (const c of gestor.corpo.ciclos) {
      expect(c.atletas).toBe(1);
      expect(c.suprimido).toBe(false);
      expect(c.scoreMedio).toBeTypeOf("number");
    }
    // Um atleta só: a média é o score dele no ciclo congelado.
    const unico = await p.db.query<{ score: string }>(
      "select score from scores_ciclo where ciclo_id = $1 and atleta_id = $2",
      [gestor.corpo.ciclos[0]!.ciclo.id, await p.idDe("SP-T07")],
    );
    expect(gestor.corpo.ciclos[0]!.scoreMedio).toBeCloseTo(Number(unico.rows[0]!.score), 2);

    const ibvar = await ler(EMAILS_DEMO.ibvar, `?classeId=${classeDaHelena}`);
    expect(ibvar.status).toBe(200);
    for (const c of ibvar.corpo.ciclos) {
      expect(c).toMatchObject({
        atletas: 1,
        suprimido: true,
        scoreMedio: null,
        mediaPorPilar: null,
        funil: null,
        aptosNosGates: null,
      });
    }
    expect(ibvar.corpo.meta).toMatchObject({
      mediaBase: null,
      mediaAtual: null,
      variacaoPercentual: null,
      atingida: null,
    });
  });

  it("IBVAR vê o piloto inteiro, e o mínimo editável muda o recorte", async () => {
    const ibvar = await ler(EMAILS_DEMO.ibvar);
    expect(ibvar.corpo.ciclos.every((c) => !c.suprimido && c.atletas >= 3)).toBe(true);
    expect(ibvar.corpo.ciclos[0]!.scoreMedio).toBe(
      (await ler(EMAILS_DEMO.gestor)).corpo.ciclos[0]!.scoreMedio,
    );

    expect((await parametros({ MIN_GRUPO_AGREGADO: { minimo: 15 } })).statusCode).toBe(200);
    const alto = await ler(EMAILS_DEMO.ibvar);
    expect(alto.corpo.ciclos.every((c) => c.suprimido && c.atletas === 14)).toBe(true);
    expect((await ler(EMAILS_DEMO.gestor)).corpo.ciclos.every((c) => !c.suprimido)).toBe(true);

    expect((await parametros({ MIN_GRUPO_AGREGADO: { minimo: 1 } })).statusCode).toBe(200);
    const livre = await ler(EMAILS_DEMO.ibvar, `?classeId=${classeDaHelena}`);
    expect(livre.corpo.ciclos.every((c) => !c.suprimido && c.scoreMedio !== null)).toBe(true);
  });
});

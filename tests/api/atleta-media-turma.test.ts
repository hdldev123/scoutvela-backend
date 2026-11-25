import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface Ficha {
  historicoScore: { ciclo: string; score: number }[];
  mediaTurmaPorCiclo: { cicloId: string; ciclo: string; media: number | null; atletas: number }[];
  comparacaoTurma: {
    scoreAtual: number;
    mediaTurma: number;
    diferenca: number;
    posicao: "acima" | "na_media" | "abaixo";
  } | null;
  tendencia: "subindo" | "estavel" | "caindo" | null;
}

describe("D13: ficha comparada à média da turma", () => {
  let p: Piloto;
  let livia: string; // SC-T01: consentiu o IBVAR
  let helena: string; // SP-T07: é a conta do atleta de teste; não consentiu

  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
    livia = await p.idDe("SC-T01");
    helena = await p.idDe("SP-T07");
  });
  afterAll(() => p.encerrar());

  const ficha = async (email: string | null, id: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${id}`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<Ficha>() };
  };
  const parametros = async (regras: Record<string, unknown>, email: string = EMAILS_DEMO.gestor) =>
    p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: { regras },
    });

  it("média por ciclo vem de scores_ciclo, do mais antigo ao mais recente, alinhada com historicoScore", async () => {
    const { status, corpo } = await ficha(EMAILS_DEMO.gestor, livia);
    expect(status).toBe(200);
    expect(corpo.mediaTurmaPorCiclo.map((m) => m.ciclo)).toEqual([
      "Setembro de 2026",
      "Outubro de 2026",
    ]);
    expect(corpo.mediaTurmaPorCiclo.map((m) => m.ciclo)).toEqual(
      corpo.historicoScore.map((h) => h.ciclo),
    );
    for (const m of corpo.mediaTurmaPorCiclo) {
      const r = await p.db.query<{ media: string; n: string }>(
        "select avg(score)::text as media, count(*)::text as n from scores_ciclo where ciclo_id = $1",
        [m.cicloId],
      );
      expect(m.media).toBeCloseTo(Number(r.rows[0]!.media), 2);
      expect(m.atletas).toBe(Number(r.rows[0]!.n));
      expect(m.atletas).toBe(14);
    }
    // A média é a mesma em qualquer ficha: é do piloto, não do atleta.
    const outra = await ficha(EMAILS_DEMO.gestor, helena);
    expect(outra.corpo.mediaTurmaPorCiclo).toEqual(corpo.mediaTurmaPorCiclo);
  });

  it("comparação com o último ciclo fechado e tendência entre os dois últimos", async () => {
    const { corpo } = await ficha(EMAILS_DEMO.gestor, livia);
    const [antes, ultimo] = corpo.historicoScore;
    const media = corpo.mediaTurmaPorCiclo[1]!.media!;
    expect(corpo.comparacaoTurma).not.toBeNull();
    expect(corpo.comparacaoTurma!.scoreAtual).toBeCloseTo(ultimo!.score, 2);
    expect(corpo.comparacaoTurma!.mediaTurma).toBe(media);
    expect(corpo.comparacaoTurma!.diferenca).toBeCloseTo(ultimo!.score - media, 1);
    const variacao = ultimo!.score - antes!.score;
    expect(corpo.tendencia).toBe(
      Math.abs(variacao) < 2 ? "estavel" : variacao > 0 ? "subindo" : "caindo",
    );
  });

  it("limiar editável (auditado): acima, na média, abaixo; subindo, estável, caindo", async () => {
    const base = (await ficha(EMAILS_DEMO.gestor, livia)).corpo;
    const dif = base.comparacaoTurma!.diferenca;
    const variacao = base.historicoScore[1]!.score - base.historicoScore[0]!.score;
    expect(Math.abs(dif)).toBeGreaterThan(0.02);
    expect(Math.abs(variacao)).toBeGreaterThan(0.02);

    // Limiar pequeno: qualquer diferença conta.
    expect((await parametros({ TENDENCIA: { limiar: 0.01 } })).statusCode).toBe(200);
    const fino = (await ficha(EMAILS_DEMO.gestor, livia)).corpo;
    expect(fino.comparacaoTurma!.posicao).toBe(dif > 0 ? "acima" : "abaixo");
    expect(fino.tendencia).toBe(variacao > 0 ? "subindo" : "caindo");

    // Limiar grande: tudo é "na média" e "estável".
    expect((await parametros({ TENDENCIA: { limiar: 100 } })).statusCode).toBe(200);
    const largo = (await ficha(EMAILS_DEMO.gestor, livia)).corpo;
    expect(largo.comparacaoTurma!.posicao).toBe("na_media");
    expect(largo.tendencia).toBe("estavel");

    const aud = await p.db.query<{
      detalhes: { regras: { antes: Record<string, unknown>; depois: Record<string, unknown> } };
    }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.regras.antes.TENDENCIA).toEqual({ limiar: 0.01 });
    expect(aud.rows[0]!.detalhes.regras.depois.TENDENCIA).toEqual({ limiar: 100 });
    await parametros({ TENDENCIA: { limiar: 2 } });
  });

  it("validação da regra TENDENCIA e só o gestor edita", async () => {
    for (const valor of [{ limiar: 0 }, { limiar: -1 }, { limiar: "2" }, { limiar: 2, x: 1 }, {}]) {
      const r = await parametros({ TENDENCIA: valor });
      expect(r.statusCode, JSON.stringify(valor)).toBe(400);
      expect(r.json<{ mensagem: string }>().mensagem).toContain("TENDENCIA");
    }
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await parametros({ TENDENCIA: { limiar: 3 } }, email)).statusCode).toBe(403);
    }
    const r = await p.app.inject({
      method: "GET",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    const regras = r.json<{ regras: { codigo: string; valor: unknown }[] }>().regras;
    expect(regras.find((x) => x.codigo === "TENDENCIA")?.valor).toEqual({ limiar: 2 });
  });

  it("papéis: treinador e o próprio atleta recebem; sem token 401; atleta alheio 404", async () => {
    expect((await ficha(null, livia)).status).toBe(401);
    const gestor = (await ficha(EMAILS_DEMO.gestor, helena)).corpo;
    for (const email of [EMAILS_DEMO.atleta, EMAILS_DEMO.gestor]) {
      const r = await ficha(email, helena);
      expect(r.status).toBe(200);
      expect(r.corpo.mediaTurmaPorCiclo).toEqual(gestor.mediaTurmaPorCiclo);
      expect(r.corpo.comparacaoTurma).toEqual(gestor.comparacaoTurma);
      expect(r.corpo.tendencia).toBe(gestor.tendencia);
    }
    expect((await ficha(EMAILS_DEMO.atleta, livia)).status).toBe(404);
    // A treinadora de teste vê a ficha de algum atleta dela.
    const treinada = await p.db.query<{ id: string }>(
      `select a.id from atletas a join usuarios u on u.id = a.treinador_id where u.email = $1 limit 1`,
      [EMAILS_DEMO.treinadora],
    );
    const id = treinada.rows[0]?.id;
    if (id) {
      const r = await ficha(EMAILS_DEMO.treinadora, id);
      expect(r.status).toBe(200);
      expect(r.corpo.mediaTurmaPorCiclo).toEqual(gestor.mediaTurmaPorCiclo);
    }
  });

  it("IBVAR: só a ficha de quem consentiu, com a média agregada; grupo pequeno sai nulo", async () => {
    expect((await ficha(EMAILS_DEMO.ibvar, helena)).status).toBe(404);
    const gestor = (await ficha(EMAILS_DEMO.gestor, livia)).corpo;
    const ibvar = await ficha(EMAILS_DEMO.ibvar, livia);
    expect(ibvar.status).toBe(200);
    expect(ibvar.corpo.mediaTurmaPorCiclo).toEqual(gestor.mediaTurmaPorCiclo);
    expect(ibvar.corpo.comparacaoTurma).toEqual(gestor.comparacaoTurma);
    expect(ibvar.corpo.tendencia).toBe(gestor.tendencia);

    // Mínimo acima do tamanho do piloto: a média some para o IBVAR e continua para os demais.
    expect((await parametros({ MIN_GRUPO_AGREGADO: { minimo: 15 } })).statusCode).toBe(200);
    const pequeno = (await ficha(EMAILS_DEMO.ibvar, livia)).corpo;
    expect(pequeno.mediaTurmaPorCiclo.map((m) => m.media)).toEqual([null, null]);
    expect(pequeno.mediaTurmaPorCiclo.map((m) => m.atletas)).toEqual([14, 14]);
    expect(pequeno.comparacaoTurma).toBeNull();
    expect(pequeno.tendencia).toBe(gestor.tendencia);
    expect((await ficha(EMAILS_DEMO.gestor, livia)).corpo.comparacaoTurma).not.toBeNull();
    expect((await ficha(EMAILS_DEMO.atleta, helena)).corpo.comparacaoTurma).not.toBeNull();
    await parametros({ MIN_GRUPO_AGREGADO: { minimo: 3 } });
  });
});

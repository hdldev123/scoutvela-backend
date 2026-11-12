import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calcularAtleta } from "../../src/domain/index.js";
import { carregarParametros } from "../../src/repositories/parametros.js";
import { buscarAtletaVisivel } from "../../src/repositories/atletas.js";
import { carregarEAvaliarAtletas } from "../../src/servicos/avaliacao-atletas.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("avaliações, prévia e gates", () => {
  let p: Piloto;
  let idT: string; // SC-T01 (treinadora Ana)
  let idMarcos: string; // RS-T02 (Marcos Pires)
  let indT: string; // indicador tipo T não calculado
  let indA: string; // indicador tipo A com resposta do atleta em SC-T01
  let indR: string;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    idT = await p.idDe("SC-T01");
    idMarcos = await p.idDe("RS-T02");
    const t = await p.db.query<{ id: string }>(
      `select id from indicadores where tipo = 'T' and not calculado order by ordem limit 1`,
    );
    indT = t.rows[0]!.id;
    const a = await p.db.query<{ indicador_id: string }>(
      `select indicador_id from resposta_atual where atleta_id = $1 limit 1`,
      [idT],
    );
    indA = a.rows[0]!.indicador_id;
    const r = await p.db.query<{ id: string }>(
      `select id from indicadores where tipo = 'R' limit 1`,
    );
    indR = r.rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const enviar = async (email: string, id: string, corpo: unknown, sufixo = "") => {
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/avaliacoes${sufixo}`,
      headers: await p.como(email),
      payload: corpo as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const contar = async (tabela: string) =>
    Number(
      (await p.db.query<{ n: string }>(`select count(*)::text as n from ${tabela}`)).rows[0]!.n,
    );
  const nota = (valor: number, indicadorId = indT) => ({
    indicadorId,
    valor,
    evidencia: "Observação em treino",
  });

  async function scoreCalculado(id: string): Promise<number> {
    const parametros = await carregarParametros(p.db);
    const base = (await buscarAtletaVisivel(
      p.db,
      { id: "x", papel: "gestor", atletaId: null },
      id,
    ))!;
    const [av] = await carregarEAvaliarAtletas(p.db, parametros, [base], AGORA());
    return calcularAtleta(parametros, {
      ...(await import("../../src/servicos/avaliacao-atletas.js")).montarEntradaCalculo(
        base,
        av!.dados,
        AGORA(),
      ),
    }).score;
  }

  it("prévia não grava nada e bate com o lançamento", async () => {
    const antesAval = await contar("avaliacoes");
    const antesAud = await contar("auditoria");
    const corpo = { notas: [nota(0)] };
    const previa = await enviar(EMAILS_DEMO.gestor, idT, corpo, "/previa");
    expect(previa.status).toBe(200);
    expect(await contar("avaliacoes")).toBe(antesAval);
    expect(await contar("auditoria")).toBe(antesAud);
    expect(previa.corpo.antes.pilares).toHaveLength(9);

    const real = await enviar(EMAILS_DEMO.gestor, idT, corpo);
    expect(real.status).toBe(201);
    expect(real.corpo.depois.score).toBeCloseTo(previa.corpo.depois.score, 9);
    expect(real.corpo.depois.faixa.id).toBe(previa.corpo.depois.faixa.id);
    expect(real.corpo.depois.statusGates).toBe(previa.corpo.depois.statusGates);
    expect(real.corpo.antes.score).toBeCloseTo(previa.corpo.antes.score, 9);
  });

  it("série histórica: dois lançamentos viram duas linhas e vale o último; score bate com calcularAtleta", async () => {
    const antes = Number(
      (
        await p.db.query<{ n: string }>(
          `select count(*)::text as n from avaliacoes where atleta_id=$1 and indicador_id=$2`,
          [idT, indT],
        )
      ).rows[0]!.n,
    );
    const a = await enviar(EMAILS_DEMO.treinadora, idT, { notas: [nota(1)] });
    const b = await enviar(EMAILS_DEMO.treinadora, idT, { notas: [nota(5)] });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const linhas = await p.db.query<{ valor: number }>(
      `select valor from avaliacoes where atleta_id=$1 and indicador_id=$2 order by id`,
      [idT, indT],
    );
    expect(linhas.rows.length).toBe(antes + 2);
    const atual = await p.db.query<{ valor: number; avaliador_id: string }>(
      `select valor, avaliador_id from avaliacao_atual where atleta_id=$1 and indicador_id=$2`,
      [idT, indT],
    );
    expect(atual.rows[0]!.valor).toBe(5);
    expect(b.corpo.depois.score).toBeCloseTo(await scoreCalculado(idT), 9);
    expect(b.corpo.depois.score).not.toBeCloseTo(a.corpo.depois.score, 6);
  });

  it("origem: resposta_confirmada quando o atleta respondeu, senão avaliacao", async () => {
    const r = await enviar(EMAILS_DEMO.gestor, idT, { notas: [nota(3, indA)] });
    expect(r.status).toBe(201);
    const o = await p.db.query<{ origem: string }>(
      `select origem from avaliacao_atual where atleta_id=$1 and indicador_id=$2`,
      [idT, indA],
    );
    expect(o.rows[0]!.origem).toBe("resposta_confirmada");
    const t = await p.db.query<{ origem: string }>(
      `select origem from avaliacao_atual where atleta_id=$1 and indicador_id=$2`,
      [idT, indT],
    );
    expect(t.rows[0]!.origem).toBe("avaliacao");
  });

  it("medida só com peso mantém a altura anterior; evidência padrão em pt-BR", async () => {
    const id = await p.idDe("CE-T09");
    const ficha = async () =>
      (
        await p.app.inject({
          method: "GET",
          url: `/atletas/${id}`,
          headers: await p.como(EMAILS_DEMO.gestor),
        })
      ).json();
    const antes = (await ficha()).classFit;
    const r = await enviar(EMAILS_DEMO.gestor, id, { medida: { pesoKg: 70.5 } });
    expect(r.status).toBe(201);
    const depois = await ficha();
    expect(depois.classFit.pesoKg).toBe(70.5);
    expect(depois.classFit.alturaCm).toBe(antes.alturaCm);
    const peso = depois.pilares
      .flatMap((x: { indicadores: { id: string; evidencia: string }[] }) => x.indicadores)
      .find((i: { id: string }) => i.id === "cf_peso_kg");
    expect(peso.evidencia).toBe("Pesagem: 70,5 kg");

    await enviar(EMAILS_DEMO.gestor, id, { medida: { alturaCm: 181.5 } });
    const final = (await ficha()).classFit;
    expect(final.pesoKg).toBe(70.5);
    expect(final.alturaCm).toBe(181.5);
  });

  it("auditoria grava sem valores", async () => {
    const r = await p.db.query<{ detalhes: unknown; acao: string }>(
      `select acao, detalhes from auditoria where acao = 'lancar_avaliacao' and entidade_id = $1 order by id desc limit 1`,
      [idT],
    );
    const texto = JSON.stringify(r.rows[0]!.detalhes);
    expect(texto).toContain(indA);
    expect(texto).not.toContain("Observação em treino");
    expect(texto).not.toMatch(/"valor"|"evidencia"/);
    const m = await p.db.query<{ detalhes: unknown }>(
      `select detalhes from auditoria where acao = 'lancar_avaliacao' and detalhes::text like '%pesoKg%' limit 1`,
    );
    // Só nomes de campo: nenhum número (o cicloId é UUID e pode conter "70" por acaso).
    const detalhesMedida = m.rows[0]!.detalhes as { medida?: unknown };
    expect(detalhesMedida.medida).toContain("pesoKg");
    expect(JSON.stringify(detalhesMedida)).not.toMatch(/[:[,]\s*-?\d+(\.\d+)?\s*[,\]}]/);
  });

  it("acesso: treinadora 404 em atleta do Marcos; atleta e ibvar 403; sem token 401", async () => {
    const corpo = { notas: [nota(2)] };
    expect((await enviar(EMAILS_DEMO.treinadora, idMarcos, corpo)).status).toBe(404);
    expect((await enviar(EMAILS_DEMO.treinadora, idMarcos, corpo, "/previa")).status).toBe(404);
    expect((await enviar(EMAILS_DEMO.atleta, idT, corpo)).status).toBe(403);
    expect((await enviar(EMAILS_DEMO.ibvar, idT, corpo, "/previa")).status).toBe(403);
    const sem = await p.app.inject({
      method: "POST",
      url: `/atletas/${idT}/avaliacoes`,
      payload: corpo,
    });
    expect(sem.statusCode).toBe(401);
    expect(
      (await enviar(EMAILS_DEMO.gestor, "00000000-0000-4000-8000-000000000000", corpo)).status,
    ).toBe(404);
  });

  it("validações: calculado, R, inexistente, repetido, faixas e corpo vazio -> 400", async () => {
    const antes = await contar("avaliacoes");
    const casos: unknown[] = [
      { notas: [nota(3, "cf_peso_kg")] },
      { notas: [nota(3, indR)] },
      { notas: [nota(3, "nao_existe")] },
      { notas: [nota(3), nota(4)] },
      { notas: [nota(6)] },
      { notas: [nota(-1)] },
      { notas: [nota(2.5)] },
      { notas: [{ indicadorId: indT, valor: 3, evidencia: "ab" }] },
      { notas: [{ indicadorId: indT, valor: 3, evidencia: "x".repeat(501) }] },
      { notas: [] },
      {},
      { medida: {} },
      { medida: { evidencia: "sem valor" } },
      { medida: { pesoKg: 29 } },
      { medida: { pesoKg: 161 } },
      { medida: { alturaCm: 119 } },
      { medida: { alturaCm: 231 } },
      { notas: Array.from({ length: 61 }, () => nota(1)) },
    ];
    for (const c of casos) {
      expect(
        (await enviar(EMAILS_DEMO.gestor, idT, c)).status,
        JSON.stringify(c).slice(0, 80),
      ).toBe(400);
      expect((await enviar(EMAILS_DEMO.gestor, idT, c, "/previa")).status).toBe(400);
    }
    expect(await contar("avaliacoes")).toBe(antes);
    const rep = await enviar(EMAILS_DEMO.gestor, idT, { notas: [nota(3, "cf_peso_kg")] });
    expect(rep.corpo.mensagem).toContain("calculado");
  });

  describe("PUT /atletas/:id/gates", () => {
    const decidir = async (email: string, id: string, corpo: unknown) => {
      const r = await p.app.inject({
        method: "PUT",
        url: `/atletas/${id}/gates`,
        headers: await p.como(email),
        payload: corpo as object,
      });
      return { status: r.statusCode, corpo: r.json() };
    };
    type Item = {
      gate: number;
      status: string;
      sugestaoAutomatica: string;
      ajustadoPeloGestor: boolean;
    };
    const outro = (s: string) => (s === "apto" ? "alerta" : "apto");

    it("status diferente da sugestão ajusta; igual volta ao automático (nulo)", async () => {
      const id = await p.idDe("RJ-T03");
      const ficha = (
        await p.app.inject({
          method: "GET",
          url: `/atletas/${id}`,
          headers: await p.como(EMAILS_DEMO.gestor),
        })
      ).json();
      const g2 = ficha.gates.itens.find((g: Item) => g.gate === 2) as Item;

      const diferente = await decidir(EMAILS_DEMO.gestor, id, {
        gate: 2,
        status: outro(g2.sugestaoAutomatica),
        justificativa: "Texto sigiloso",
      });
      expect(diferente.status).toBe(200);
      const item = (diferente.corpo.itens as Item[]).find((g) => g.gate === 2)!;
      expect(item).toMatchObject({
        status: outro(g2.sugestaoAutomatica),
        ajustadoPeloGestor: true,
      });
      expect(diferente.corpo.statusFinal).toEqual(expect.any(String));

      const igual = await decidir(EMAILS_DEMO.gestor, id, {
        gate: 2,
        status: g2.sugestaoAutomatica,
      });
      const item2 = (igual.corpo.itens as Item[]).find((g) => g.gate === 2)!;
      expect(item2).toMatchObject({ status: g2.sugestaoAutomatica, ajustadoPeloGestor: false });
      const ult = await p.db.query<{ status: string | null }>(
        `select status from gate_decisao_atual where atleta_id=$1 and gate=2`,
        [id],
      );
      expect(ult.rows[0]!.status).toBeNull();

      await decidir(EMAILS_DEMO.gestor, id, { gate: 2, status: outro(g2.sugestaoAutomatica) });
      const nulo = await decidir(EMAILS_DEMO.gestor, id, { gate: 2, status: null });
      expect((nulo.corpo.itens as Item[]).find((g) => g.gate === 2)!.ajustadoPeloGestor).toBe(
        false,
      );

      const aud = await p.db.query<{ detalhes: unknown }>(
        `select detalhes from auditoria where acao = 'decidir_gate'`,
      );
      expect(aud.rows.length).toBeGreaterThanOrEqual(4);
      expect(JSON.stringify(aud.rows)).not.toContain("sigiloso");
    });

    it("só gestor; validações", async () => {
      expect((await decidir(EMAILS_DEMO.treinadora, idT, { gate: 1, status: "apto" })).status).toBe(
        403,
      );
      expect((await decidir(EMAILS_DEMO.atleta, idT, { gate: 1, status: "apto" })).status).toBe(
        403,
      );
      expect((await decidir(EMAILS_DEMO.ibvar, idT, { gate: 1, status: "apto" })).status).toBe(403);
      expect((await decidir(EMAILS_DEMO.gestor, idT, { gate: 5, status: "apto" })).status).toBe(
        400,
      );
      expect((await decidir(EMAILS_DEMO.gestor, idT, { gate: 0, status: "apto" })).status).toBe(
        400,
      );
      expect((await decidir(EMAILS_DEMO.gestor, idT, { gate: 1, status: "ruim" })).status).toBe(
        400,
      );
      expect(
        (
          await decidir(EMAILS_DEMO.gestor, idT, {
            gate: 1,
            status: "apto",
            justificativa: "x".repeat(501),
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await decidir(EMAILS_DEMO.gestor, "00000000-0000-4000-8000-000000000000", {
            gate: 1,
            status: "apto",
          })
        ).status,
      ).toBe(404);
    });
  });
});

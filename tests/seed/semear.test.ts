import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { semear } from "../../seed/semear.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

interface Gabarito {
  atletas: {
    velaid: string;
    peso: number;
    perfilSuporte: string;
    consentIbvar: boolean;
    historico: { ciclo: string; score: number }[];
    notas: Record<string, number | null>;
    respostas: Record<string, string>;
    resultados: {
      nivel: string;
      evento: string;
      data: string;
      posicao: number;
      tamanhoFrota: number;
      internacional: boolean;
      pontos: number | null;
    }[];
  }[];
}
const gabarito = JSON.parse(readFileSync("tests/fixtures/prototipo.json", "utf8")) as Gabarito;

const NIVEIS: Record<string, string> = {
  Mundial: "mundial",
  "Sul-Americano": "sul_americano",
  "Europeu aberto": "internacional_aberto",
  Brasileiro: "brasileiro",
  Estadual: "estadual",
  Regional: "regional",
};

let db: Db;
const contagem = async (tabela: string) =>
  Number((await db.query<{ n: string }>(`select count(*)::text n from ${tabela}`)).rows[0]!.n);

beforeAll(async () => {
  db = await criarBancoDeTeste();
  await semear(db);
});
afterAll(async () => {
  await db.fechar();
});

describe("semear", () => {
  it("cria atletas, usuários e ciclos", async () => {
    expect(await contagem("atletas")).toBe(14);
    expect(await contagem("usuarios")).toBe(5);
    expect(await contagem("ciclos_avaliacao")).toBe(3);
    expect(await contagem("scores_ciclo")).toBe(28);
    expect(await contagem("medidas_corporais")).toBe(14);
    expect(await contagem("velaid_registros")).toBe(17);
    expect(
      await contagem("velaid_registros where fonte = 'simulado' and email like '%@exemplo.com'"),
    ).toBe(17);
    expect(await contagem("velaid_registros where codigo in ('MG-T15','BA-T16','PE-T17')")).toBe(3);
    const { rows } = await db.query<{ nome: string }>(
      "select nome from ciclos_avaliacao where status = 'aberto'",
    );
    expect(rows).toEqual([{ nome: "Novembro de 2026" }]);
  });

  it("Helena está vinculada ao usuário atleta; auth_user_id fica nulo", async () => {
    const { rows } = await db.query<{ velaid_codigo: string; auth_user_id: string | null }>(
      "select a.velaid_codigo, u.auth_user_id from usuarios u join atletas a on a.id = u.atleta_id where u.email = 'atleta@scoutvela.dev'",
    );
    expect(rows).toEqual([{ velaid_codigo: "SP-T07", auth_user_id: null }]);
    const marcos = await db.query<{ papel: string }>(
      "select papel from usuarios where email = 'marcos.pires@scoutvela.dev'",
    );
    expect(marcos.rows).toEqual([{ papel: "treinador" }]);
  });

  it("nenhum lançamento de cf_peso_kg (indicador calculado)", async () => {
    expect(await contagem("avaliacoes where indicador_id = 'cf_peso_kg'")).toBe(0);
  });

  it("notas, respostas e resultados batem com o gabarito do protótipo", async () => {
    for (const g of gabarito.atletas) {
      const at = (
        await db.query<{ id: string }>("select id from atletas where velaid_codigo = $1", [
          g.velaid,
        ])
      ).rows[0]!.id;

      const notas = (
        await db.query<{ indicador_id: string; valor: number }>(
          "select indicador_id, valor from avaliacao_atual where atleta_id = $1",
          [at],
        )
      ).rows;
      const obtido = Object.fromEntries(notas.map((n) => [n.indicador_id, n.valor]));
      const esperado = Object.fromEntries(
        Object.entries(g.notas).filter(([id, v]) => v !== null && id !== "cf_peso_kg"),
      );
      expect(obtido, g.velaid).toEqual(esperado);

      const resp = (
        await db.query<{ indicador_id: string; resposta: string }>(
          "select indicador_id, resposta from resposta_atual where atleta_id = $1",
          [at],
        )
      ).rows;
      expect(Object.fromEntries(resp.map((r) => [r.indicador_id, r.resposta])), g.velaid).toEqual(
        g.respostas,
      );

      const res = (
        await db.query<{
          nivel: string;
          evento: string;
          data: string;
          posicao: number;
          tamanho_frota: number;
          internacional: boolean;
          pontos_cbvela: string | null;
        }>(
          "select nivel, evento, data::text, posicao, tamanho_frota, internacional, pontos_cbvela from resultados_regata where atleta_id = $1 order by data desc",
          [at],
        )
      ).rows;
      expect(res.length).toBe(g.resultados.length);
      res.forEach((r, i) => {
        const e = g.resultados[i]!;
        expect([r.nivel, r.evento, r.data, r.posicao, r.tamanho_frota, r.internacional]).toEqual([
          NIVEIS[e.nivel],
          e.evento,
          e.data,
          e.posicao,
          e.tamanhoFrota,
          e.internacional,
        ]);
        if (e.pontos === null) expect(r.pontos_cbvela).toBeNull();
        else expect(Number(r.pontos_cbvela)).toBeCloseTo(e.pontos, 2);
      });
    }
  });

  it("peso, perfil, consentimento IBVAR e histórico batem com o gabarito", async () => {
    for (const g of gabarito.atletas) {
      const at = (
        await db.query<{ id: string }>("select id from atletas where velaid_codigo = $1", [
          g.velaid,
        ])
      ).rows[0]!.id;
      const peso = await db.query<{ peso_kg: string }>(
        "select peso_kg from medidas_corporais where atleta_id = $1",
        [at],
      );
      expect(Number(peso.rows[0]!.peso_kg)).toBe(g.peso);
      const fin = await db.query<{ perfil_suporte: string }>(
        "select perfil_suporte from financeiro_atual where atleta_id = $1",
        [at],
      );
      expect(fin.rows[0]!.perfil_suporte).toBe(g.perfilSuporte);
      const ib = await db.query<{ concedido: boolean }>(
        "select concedido from consentimento_atual where atleta_id = $1 and tipo = 'compartilhar_ibvar'",
        [at],
      );
      expect(ib.rows[0]!.concedido).toBe(g.consentIbvar);
      const hist = (
        await db.query<{ nome: string; score: string }>(
          "select c.nome, s.score from scores_ciclo s join ciclos_avaliacao c on c.id = s.ciclo_id where s.atleta_id = $1 order by c.inicio",
          [at],
        )
      ).rows;
      expect(hist.map((h) => h.nome)).toEqual(["Setembro de 2026", "Outubro de 2026"]);
      hist.forEach((h, i) => expect(Number(h.score)).toBeCloseTo(g.historico[i]!.score, 3));
    }
  });

  it("recusa rodar duas vezes", async () => {
    await expect(semear(db)).rejects.toThrow(/já tem atletas/);
    expect(await contagem("atletas")).toBe(14);
  });

  it("recusa produção", async () => {
    const antes = process.env.APP_ENV;
    process.env.APP_ENV = "producao";
    try {
      const vazio = await criarBancoDeTeste();
      await expect(semear(vazio)).rejects.toThrow(/proibido em produção/);
      await vazio.fechar();
    } finally {
      if (antes === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = antes;
    }
  });
});

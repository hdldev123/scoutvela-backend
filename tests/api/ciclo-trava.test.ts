import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("ciclo aberto lido com trava dentro da transação", () => {
  let p: Piloto;
  const sqls: string[] = [];
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    // Grava o SQL de tudo que roda dentro de transação (as rotas leem o ciclo ali).
    const original = p.db.transacao.bind(p.db);
    p.db.transacao = (fn) =>
      original((tx) => {
        const consulta = tx.query.bind(tx);
        tx.query = (sql: string, params?: unknown[]) => {
          sqls.push(sql);
          return consulta(sql, params);
        };
        return fn(tx);
      });
  });
  afterAll(() => p.encerrar());

  const leCicloComTrava = () =>
    sqls.some(
      (s) => /from ciclos_avaliacao where status = 'aberto'/.test(s) && /for share/.test(s),
    );

  it("lançar avaliação lê o ciclo aberto com for share (fechar o ciclo, que usa for update, espera)", async () => {
    sqls.length = 0;
    const id = await p.idDe("SC-T01");
    const indicador = (
      await p.db.query<{ id: string }>(
        `select i.id from indicadores i join pilares pl on pl.id = i.pilar_id
          where i.tipo = 'T' and not i.calculado and not pl.sensivel order by pl.ordem, i.ordem limit 1`,
      )
    ).rows[0]!.id;
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/avaliacoes`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { notas: [{ indicadorId: indicador, valor: 4, evidencia: "Observação em treino" }] },
    });
    expect(r.statusCode).toBe(201);
    expect(leCicloComTrava()).toBe(true);
  });

  it("responder o questionário trava o ciclo (for share)", async () => {
    sqls.length = 0;
    const painel = await p.app.inject({
      method: "GET",
      url: "/painel",
      headers: await p.como(EMAILS_DEMO.atleta),
    });
    const pergunta = (
      painel.json().modulos as {
        perguntas: { indicadorId: string; resposta: string | null; opcoes: { texto: string }[] }[];
      }[]
    )
      .flatMap((m) => m.perguntas)
      .find((q) => q.resposta === null)!;
    const r = await p.app.inject({
      method: "POST",
      url: "/respostas",
      headers: await p.como(EMAILS_DEMO.atleta),
      payload: { indicadorId: pergunta.indicadorId, resposta: pergunta.opcoes[0]!.texto },
    });
    expect(r.statusCode).toBe(201);
    expect(leCicloComTrava()).toBe(true);
  });
});

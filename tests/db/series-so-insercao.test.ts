import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const recusa = /aceita só inserção/;

describe("scores_ciclo e resultados_regata: só inserção (0017)", () => {
  let p: Piloto;
  let atletaId: string;
  let outroId: string;

  beforeAll(async () => {
    p = await criarPiloto();
    atletaId = await p.idDe("SC-T01");
    outroId = await p.idDe("RJ-T03");
    // O seed congela scores de ciclos anteriores; garante linhas dos dois atletas.
    const n = await p.db.query<{ n: string }>(
      "select count(*)::text as n from scores_ciclo where atleta_id = $1",
      [atletaId],
    );
    expect(Number(n.rows[0]!.n)).toBeGreaterThan(0);
  });
  afterAll(() => p.encerrar());

  const comoAnonimizacao = (alvo: string, sql: string, params: unknown[]) =>
    p.db.transacao(async (tx) => {
      await tx.query(`select set_config('scoutvela.anonimizando', $1, true)`, [alvo]);
      await tx.query(sql, params);
    });

  it("scores_ciclo recusa UPDATE e DELETE, até na anonimização", async () => {
    await expect(p.db.exec("update scores_ciclo set score = 1")).rejects.toThrow(recusa);
    await expect(p.db.exec("delete from scores_ciclo")).rejects.toThrow(recusa);
    await expect(
      comoAnonimizacao(atletaId, "update scores_ciclo set score = 1 where atleta_id = $1", [
        atletaId,
      ]),
    ).rejects.toThrow(recusa);
  });

  it("resultados_regata fora da anonimização: UPDATE e DELETE são recusados", async () => {
    await expect(p.db.exec("update resultados_regata set posicao = 1")).rejects.toThrow(recusa);
    await expect(p.db.exec("update resultados_regata set evento = 'x'")).rejects.toThrow(recusa);
    await expect(
      p.db.query(
        "update resultados_regata set evento = 'Evento anonimizado', link_oficial = null, anonimizado = true where atleta_id = $1",
        [atletaId],
      ),
    ).rejects.toThrow(recusa);
    await expect(p.db.exec("delete from resultados_regata")).rejects.toThrow(recusa);
  });

  it("dentro da anonimização, só o atleta da variável e só evento, link_oficial e anonimizado", async () => {
    // Variável de outro atleta: recusa.
    await expect(
      comoAnonimizacao(
        outroId,
        "update resultados_regata set evento = 'Evento anonimizado', link_oficial = null, anonimizado = true where atleta_id = $1",
        [atletaId],
      ),
    ).rejects.toThrow(recusa);
    // Variável certa, mas mexendo em outra coluna, sem marcar anonimizado ou apagando a linha: recusa.
    for (const sql of [
      "update resultados_regata set posicao = 1, anonimizado = true, link_oficial = null where atleta_id = $1",
      "update resultados_regata set evento = 'Evento anonimizado' where atleta_id = $1",
      "update resultados_regata set pontos_cbvela = 999, anonimizado = true, link_oficial = null where atleta_id = $1",
      "delete from resultados_regata where atleta_id = $1",
    ]) {
      await expect(comoAnonimizacao(atletaId, sql, [atletaId]), sql).rejects.toThrow(recusa);
    }
    // A alteração da anonimização passa.
    await comoAnonimizacao(
      atletaId,
      "update resultados_regata set evento = 'Evento anonimizado', link_oficial = null, anonimizado = true where atleta_id = $1",
      [atletaId],
    );
    const r = await p.db.query<{ evento: string; anonimizado: boolean }>(
      "select evento, anonimizado from resultados_regata where atleta_id = $1",
      [atletaId],
    );
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((l) => l.anonimizado && l.evento === "Evento anonimizado")).toBe(true);
    // Os de outro atleta ficam intactos.
    const o = await p.db.query<{ anonimizado: boolean }>(
      "select anonimizado from resultados_regata where atleta_id = $1",
      [outroId],
    );
    expect(o.rows.every((l) => !l.anonimizado)).toBe(true);
  });
});

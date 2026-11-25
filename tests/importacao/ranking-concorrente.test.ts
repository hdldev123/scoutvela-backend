import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { importarRanking } from "../../src/importacao/ranking.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("importarRanking: envios simultâneos", () => {
  let db: Db;
  beforeAll(async () => {
    db = await criarBancoDeTeste();
    await db.exec(`
      insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
        values ('t_cls', 'Classe teste', 'Teste', 'ind', 60, 65, 70, 99);
      insert into usuarios (id, email, nome, papel)
        values ('11111111-1111-4111-8111-111111111111', 'g@t.dev', 'Gestor', 'gestor');
      insert into atletas (velaid_codigo, ws_id, nome, genero, data_nascimento, classe_id, cadastro_completo_em)
        values ('SP-R01', 'BRASPR01', 'Atleta R', 'F', '2000-01-01', 't_cls', now());
    `);
  });
  afterAll(() => db.fechar());

  const CAB = ["velaid", "nivel", "evento", "data", "posicao", "tamanho_frota", "pontos"];
  const linha = ["SP-R01", "estadual", "Copa Concorrente", "2026-05-30", "2", "30", "12,5"];
  const contar = async () =>
    Number(
      (
        await db.query<{ n: string }>(
          "select count(*)::text as n from resultados_regata where lower(evento) = 'copa concorrente'",
        )
      ).rows[0]!.n,
    );

  it("o segundo envio, que não viu o primeiro no select, vira erro 'já importado' e não duplica", async () => {
    const GESTOR = "11111111-1111-4111-8111-111111111111";
    const primeiro = await importarRanking(db, CAB, [linha], "2026-11-06", GESTOR);
    expect(primeiro).toEqual({ linhasOk: 1, erros: [] });

    // Simula a corrida: a conferência por select não enxerga o resultado que o outro envio gravou.
    const cego: Db = {
      ...db,
      query: (sql: string, params?: unknown[]) =>
        sql.includes("select 1 from resultados_regata")
          ? Promise.resolve({ rows: [] })
          : db.query(sql, params),
    };
    const segundo = await importarRanking(cego, CAB, [linha], "2026-11-06", GESTOR);
    expect(segundo.linhasOk).toBe(0);
    expect(segundo.erros).toEqual([
      { linha: 2, mensagem: "Resultado já importado (mesmo atleta, evento e data)." },
    ]);
    expect(await contar()).toBe(1);
  });
});

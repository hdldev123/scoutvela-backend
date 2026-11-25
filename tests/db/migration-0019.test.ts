import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { listarMigrations, migrar, PASTA_MIGRATIONS } from "../../src/db/migrar.js";
import { criarDbPglite } from "../../src/db/pglite.js";

/** Aplica a 0019 sobre ciclos que já estavam fechados (só score e faixa congelados). */
describe("migration 0019 sobre ciclos já fechados", () => {
  let db: Db;
  let pasta: string;

  beforeAll(async () => {
    pasta = mkdtempSync(join(tmpdir(), "vela-mig-"));
    const todas = listarMigrations();
    for (const f of todas.filter((f) => f < "0019"))
      copyFileSync(join(PASTA_MIGRATIONS, f), join(pasta, f));
    db = await criarDbPglite();
    await migrar(db, pasta);

    await db.exec(`
      insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
        values ('t_cls', 'Classe teste', 'Teste', 'ind', 60, 65, 70, 99);
      insert into atletas (id, nome, genero, data_nascimento, classe_id, ws_id, cadastro_completo_em)
        values ('00000000-0000-4000-8000-000000000001', 'A1', 'F', '2000-01-01', 't_cls', 'BRAAB12', now());
      insert into ciclos_avaliacao (id, nome, inicio, prazo, status) values
        ('00000000-0000-4000-8000-0000000000c1', 'Fechado', '2026-09-01', '2026-09-30', 'fechado'),
        ('00000000-0000-4000-8000-0000000000c2', 'Fechado sem score', '2026-08-01', '2026-08-31', 'fechado'),
        ('00000000-0000-4000-8000-0000000000c3', 'Aberto', '2026-11-01', '2026-11-30', 'aberto');
      insert into faixas_score (id, nome, nome_curto, score_min, ordem) values ('t_f', 'Faixa', 'F', 0, 99)
        on conflict do nothing;
      insert into scores_ciclo (atleta_id, ciclo_id, score, faixa_id, calculado_em)
        values ('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-0000000000c1', 50, 't_f', '2026-10-01T10:00:00Z');
    `);

    copyFileSync(
      join(PASTA_MIGRATIONS, "0019_congelamento_ciclo.sql"),
      join(pasta, "0019_congelamento_ciclo.sql"),
    );
    await migrar(db, pasta);
  });
  afterAll(async () => {
    await db.fechar();
    rmSync(pasta, { recursive: true, force: true });
  });

  it("preenche fechado_em com o último calculado_em e marca o congelamento como incompleto", async () => {
    const { rows } = await db.query<{
      nome: string;
      fechado_em: Date | null;
      congelamento_completo: boolean;
    }>("select nome, fechado_em, congelamento_completo from ciclos_avaliacao order by nome");
    const por = Object.fromEntries(rows.map((r) => [r.nome, r]));
    expect(por["Fechado"]!.fechado_em?.toISOString()).toBe("2026-10-01T10:00:00.000Z");
    expect(por["Fechado sem score"]!.fechado_em).toBeNull();
    expect(por["Aberto"]!.fechado_em).toBeNull();
    for (const r of rows) expect(r.congelamento_completo).toBe(false);
  });

  it("ciclo aberto não aceita fechado_em nem congelamento completo", async () => {
    await expect(
      db.exec("update ciclos_avaliacao set fechado_em = now() where nome = 'Aberto'"),
    ).rejects.toThrow();
    await expect(
      db.exec("update ciclos_avaliacao set congelamento_completo = true where nome = 'Aberto'"),
    ).rejects.toThrow();
  });
});

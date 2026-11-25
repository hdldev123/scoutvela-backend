import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { listarMigrations, migrar, PASTA_MIGRATIONS } from "../../src/db/migrar.js";
import { criarDbPglite } from "../../src/db/pglite.js";

/** Aplica a 0018 sobre dados que já existiam (atletas com WS ID nulo, repetido ou fora do formato). */
describe("migration 0018 sobre dados existentes", () => {
  let db: Db;
  let pasta: string;

  beforeAll(async () => {
    pasta = mkdtempSync(join(tmpdir(), "vela-mig-"));
    mkdirSync(pasta, { recursive: true });
    const todas = listarMigrations();
    const anteriores = todas.filter((f) => f < "0018");
    for (const f of anteriores) copyFileSync(join(PASTA_MIGRATIONS, f), join(pasta, f));
    db = await criarDbPglite();
    await migrar(db, pasta);

    await db.exec(`
      insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
        values ('t_cls', 'Classe teste', 'Teste', 'ind', 60, 65, 70, 99);
      insert into atletas (id, velaid_codigo, nome, genero, data_nascimento, classe_id, ws_id, criado_em) values
        ('00000000-0000-4000-8000-000000000001', 'XX-A01', 'A1', 'F', '2000-01-01', 't_cls', ' bra ab12 ', '2026-01-01'),
        ('00000000-0000-4000-8000-000000000002', 'XX-A02', 'A2', 'M', '2000-01-01', 't_cls', 'BRAAB12', '2026-01-02'),
        ('00000000-0000-4000-8000-000000000003', 'XX-A03', 'A3', 'F', '2000-01-01', 't_cls', null, '2026-01-03'),
        ('00000000-0000-4000-8000-000000000004', 'XX-A04', 'A4', 'M', '2000-01-01', 't_cls', '12-inválido', '2026-01-04');
    `);

    for (const f of todas.filter((f) => f >= "0018")) {
      copyFileSync(join(PASTA_MIGRATIONS, f), join(pasta, f));
    }
    await migrar(db, pasta);
  });
  afterAll(async () => {
    await db.fechar();
    rmSync(pasta, { recursive: true, force: true });
  });

  it("mantém o WS ID válido normalizado e dá WS ID fictício a nulo, repetido e inválido", async () => {
    const { rows } = await db.query<{ nome: string; ws_id: string }>(
      "select nome, ws_id from atletas order by nome",
    );
    expect(rows[0]).toEqual({ nome: "A1", ws_id: "BRAAB12" });
    for (const r of rows.slice(1)) expect(r.ws_id).toMatch(/^BRA[0-9A-F]{9}$/);
    expect(new Set(rows.map((r) => r.ws_id)).size).toBe(4);
    for (const r of rows) expect(r.ws_id).toMatch(/^[A-Z]{3}[A-Z0-9]{2,12}$/);
  });

  it("os atletas existentes ficam com o cadastro completo", async () => {
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from atletas where cadastro_completo_em is not null",
    );
    expect(rows[0]!.n).toBe("4");
  });
});

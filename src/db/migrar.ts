import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "./db.js";

/** Pasta das migrations. No Render e no dev, o processo roda na raiz do vela-back. */
export const PASTA_MIGRATIONS = process.env.MIGRATIONS_DIR ?? join(process.cwd(), "migrations");

/**
 * Aplica, em ordem, as migrations SQL ainda não aplicadas. Cada arquivo roda
 * numa transação própria e fica registrado em schema_migrations.
 * O esquema só muda por aqui: nada é criado à mão no painel do Supabase.
 */
export async function migrar(db: Db, pasta = PASTA_MIGRATIONS): Promise<string[]> {
  await db.exec(`
    create table if not exists schema_migrations (
      nome text primary key,
      aplicada_em timestamptz not null default now()
    );
    alter table schema_migrations enable row level security;
  `);
  const { rows } = await db.query<{ nome: string }>("select nome from schema_migrations");
  const aplicadas = new Set(rows.map((r) => r.nome));
  const arquivos = readdirSync(pasta)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();

  const novas: string[] = [];
  for (const arquivo of arquivos) {
    if (aplicadas.has(arquivo)) continue;
    const sql = readFileSync(join(pasta, arquivo), "utf8");
    await db.transacao(async (tx) => {
      await tx.exec(sql);
      await tx.query("insert into schema_migrations (nome) values ($1)", [arquivo]);
    });
    novas.push(arquivo);
  }
  return novas;
}

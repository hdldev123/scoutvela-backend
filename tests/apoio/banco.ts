import { PGlite } from "@electric-sql/pglite";
import type { Db } from "../../src/db/db.js";
import { migrar } from "../../src/db/migrar.js";

/** Db sobre PGlite (Postgres real em WASM, em memória). Só para testes. */
export function dbDoPglite(pg: PGlite): Db {
  const db: Db = {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await pg.query<T>(sql, params);
      return { rows: r.rows };
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    async transacao<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      // PGlite tem uma conexão só; begin/commit explícitos bastam.
      await pg.exec("begin");
      try {
        const r = await fn(db);
        await pg.exec("commit");
        return r;
      } catch (e) {
        await pg.exec("rollback");
        throw e;
      }
    },
    async fechar() {
      await pg.close();
    },
  };
  return db;
}

/** Banco em memória com todas as migrations aplicadas. */
export async function criarBancoDeTeste(): Promise<Db> {
  const db = dbDoPglite(new PGlite());
  await migrar(db);
  return db;
}

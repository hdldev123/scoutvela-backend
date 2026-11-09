import type { PGlite } from "@electric-sql/pglite";
import type { Db } from "./db.js";

/** Adaptador de Db sobre uma instância do PGlite (Postgres real em WASM). */
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

/**
 * Db sobre PGlite: em disco quando há `diretorio`, em memória sem ele.
 * Só para desenvolvimento e testes. O @electric-sql/pglite é devDependency,
 * por isso o import é dinâmico: o build de produção não depende dele.
 */
export async function criarDbPglite(diretorio?: string): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = diretorio ? new PGlite(diretorio) : new PGlite();
  await pg.waitReady;
  return dbDoPglite(pg);
}

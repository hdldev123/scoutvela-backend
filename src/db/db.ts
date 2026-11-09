import pg from "pg";

/**
 * Acesso mínimo ao Postgres usado pela API. Implementado pelo pool do `pg`
 * (Supabase) e, nos testes, pelo PGlite (Postgres real em WASM, sem Docker).
 *
 * Convenções para quem escreve consultas:
 * - sempre parâmetros posicionais ($1, $2...), nunca concatenar valor em SQL;
 * - `date` sai como texto: selecione `coluna::text` (o `pg` converteria para Date no fuso local);
 * - `numeric` sai como string nos dois drivers: converta com Number();
 * - `timestamptz` sai como Date: converta com toISOString().
 */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Vários comandos de uma vez, sem parâmetros (migrations, seed). */
  exec(sql: string): Promise<void>;
  /** Executa fn numa transação, numa única conexão. */
  transacao<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  fechar(): Promise<void>;
}

export function criarDbPg(opcoes: { url: string; caCert?: string | undefined }): Db {
  const pool = new pg.Pool({
    connectionString: opcoes.url,
    ssl: opcoes.caCert ? { ca: opcoes.caCert, rejectUnauthorized: true } : undefined,
    max: 10,
  });
  return dbDoPg(pool, pool);
}

function dbDoPg(alvo: pg.Pool | pg.PoolClient, pool: pg.Pool): Db {
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const r = await alvo.query(sql, params);
      return { rows: r.rows as T[] };
    },
    async exec(sql: string) {
      await alvo.query(sql);
    },
    async transacao<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
      const cliente = await pool.connect();
      try {
        await cliente.query("begin");
        const r = await fn(dbDoPg(cliente, pool));
        await cliente.query("commit");
        return r;
      } catch (e) {
        await cliente.query("rollback");
        throw e;
      } finally {
        cliente.release();
      }
    },
    async fechar() {
      if (alvo === pool) await pool.end();
    },
  };
}

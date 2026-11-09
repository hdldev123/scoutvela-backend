import type { Db } from "../../src/db/db.js";
import { migrar } from "../../src/db/migrar.js";
import { criarDbPglite } from "../../src/db/pglite.js";

/** Banco em memória com todas as migrations aplicadas. */
export async function criarBancoDeTeste(): Promise<Db> {
  const db = await criarDbPglite();
  await migrar(db);
  return db;
}

import type { Db } from "../db/db.js";

/** ids dos atletas com consentimento atual de compartilhamento com o IBVAR. */
export async function idsComConsentimentoIbvar(db: Db, atletaIds: string[]): Promise<Set<string>> {
  if (atletaIds.length === 0) return new Set();
  const r = await db.query<{ atleta_id: string }>(
    `select atleta_id from consentimento_atual
      where tipo = 'compartilhar_ibvar' and concedido and atleta_id = any($1::uuid[])`,
    [atletaIds],
  );
  return new Set(r.rows.map((l) => l.atleta_id));
}

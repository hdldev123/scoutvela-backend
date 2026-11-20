import type { Db } from "../src/db/db.js";

/**
 * Faixas de altura de referência FICTÍCIAS por classe e posição, só para desenvolvimento e homologação.
 * A faixa real é definida pela CBVela (PUT /parametros); em produção ela nasce vazia (migration 0014).
 * [mínimo, média, máximo] em cm.
 */
export const ALTURAS_FICTICIAS: Record<string, [number, number, number]> = {
  "470-helm": [165, 170, 175],
  "470-crew": [175, 180, 185],
  "49er-helm": [175, 180, 185],
  "49er-crew": [185, 190, 195],
  "fx-helm": [165, 170, 175],
  "fx-crew": [172, 177, 182],
  ilca6: [168, 173, 178],
  ilca7: [180, 185, 190],
  "iqf-m": [178, 183, 188],
  "iqf-w": [166, 171, 176],
  "fk-m": [175, 180, 185],
  "fk-w": [165, 170, 175],
  "n17-helm": [170, 175, 180],
  "n17-crew": [175, 180, 185],
};

/** Grava as alturas fictícias só nas classes que ainda estão sem faixa. Idempotente. */
export async function preencherAlturasFicticias(db: Db): Promise<number> {
  if (process.env.APP_ENV === "producao") {
    throw new Error("As alturas fictícias são proibidas em produção (APP_ENV=producao).");
  }
  let n = 0;
  for (const [id, [min, media, max]] of Object.entries(ALTURAS_FICTICIAS)) {
    const r = await db.query(
      `update classes set altura_min_cm = $2, altura_media_cm = $3, altura_max_cm = $4
        where id = $1 and altura_min_cm is null and altura_media_cm is null and altura_max_cm is null
        returning id`,
      [id, min, media, max],
    );
    n += r.rows.length;
  }
  return n;
}

import { termoSql } from "./termo.js";
import type { Db } from "../db/db.js";

/**
 * Foto e bio que o IBVAR pode ver (D14, decisão D). A regra fica na consulta: o atleta só aparece
 * se consentiu com o IBVAR E o aceite mais recente do termo é de uma versão que inclui foto e bio
 * (`ibvar_ve_foto_bio`, migration 0036). Fora disso, `foto_caminho` e `bio` nem saem do banco.
 *
 * Quem aparece no mapa pode ver; quem não aparece, não. A foto é a da conta ativa do atleta (nula se
 * não tem) e a bio é nula se não escreveu. Os ids devem vir de atletas que o IBVAR já enxerga.
 */
export interface FotoEBioDoAtleta {
  fotoCaminho: string | null;
  bio: string | null;
}

export async function fotoEBioParaIbvar(
  db: Db,
  atletaIds: string[],
  agora: Date,
): Promise<Map<string, FotoEBioDoAtleta>> {
  const mapa = new Map<string, FotoEBioDoAtleta>();
  if (atletaIds.length === 0) return mapa;
  const r = await db.query<{ atleta_id: string; bio: string | null; foto_caminho: string | null }>(
    `select a.id::text as atleta_id, a.bio,
            (select u.foto_caminho from usuarios u
              where u.papel = 'atleta' and u.atleta_id = a.id and u.ativo and u.foto_caminho is not null
              order by u.criado_em desc limit 1) as foto_caminho
       from atletas a
      where a.id = any($1::uuid[]) and ${termoSql.ibvarVeFotoBio("a.id", "$2")}`,
    [atletaIds, agora],
  );
  for (const l of r.rows) mapa.set(l.atleta_id, { fotoCaminho: l.foto_caminho, bio: l.bio });
  return mapa;
}

/** Bio do atleta para gestor, treinador e o próprio atleta (a rota já conferiu o acesso). */
export async function bioDoAtleta(db: Db, atletaId: string): Promise<string | null> {
  const r = await db.query<{ bio: string | null }>(`select bio from atletas where id = $1::uuid`, [
    atletaId,
  ]);
  return r.rows[0]?.bio ?? null;
}

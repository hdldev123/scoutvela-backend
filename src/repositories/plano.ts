import type { Db } from "../db/db.js";
import type { TextosPlano } from "../domain/plano.js";

export interface PlanoRegistrado extends TextosPlano {
  registradoPor: { id: string; nome: string };
  registradoEm: string;
}

interface LinhaPlano {
  forcas: string;
  lacunas: string;
  meta_12m: string;
  meta_24m: string;
  recomendacao: string;
  registrado_por: string;
  registrador_nome: string;
  registrado_em: Date;
}

/** Versão mais recente do plano do atleta. O controle de acesso é de quem chama (buscarAtletaVisivel). */
export async function buscarPlanoAtual(db: Db, atletaId: string): Promise<PlanoRegistrado | null> {
  const r = await db.query<LinhaPlano>(
    `select p.forcas, p.lacunas, p.meta_12m, p.meta_24m, p.recomendacao, p.registrado_por,
            u.nome as registrador_nome, p.registrado_em
       from plano_atual p join usuarios u on u.id = p.registrado_por
      where p.atleta_id = $1::uuid`,
    [atletaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    forcas: l.forcas,
    lacunas: l.lacunas,
    meta12m: l.meta_12m,
    meta24m: l.meta_24m,
    recomendacao: l.recomendacao,
    registradoPor: { id: l.registrado_por, nome: l.registrador_nome },
    registradoEm: new Date(l.registrado_em).toISOString(),
  };
}

import type { Db } from "../db/db.js";
import { sqlNotaDoAvaliador } from "./origens.js";

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/** Sugestão do atleta (origem `autoavaliacao`) mais recente de um indicador no ciclo. */
export interface SugestaoDoAtleta {
  valor: number;
  evidencia: string | null;
  link: string | null;
  anexo: { id: string; nomeArquivo: string } | null;
  em: string;
}

/** Nota do treinador (ou do gestor) mais recente de um indicador no ciclo. */
export interface NotaDoTreinador {
  valor: number;
  origem: "avaliacao" | "resposta_confirmada" | "autoavaliacao_aprovada";
  justificativa: string | null;
  avaliador: { nome: string } | null;
  em: string;
}

export interface CicloDeAutoavaliacao {
  id: string;
  nome: string;
  status: "aberto" | "fechado";
}

/**
 * Ciclo pedido, ou o aberto, ou o último fechado. Nulo se não existe (ou se `id` não existe).
 */
export async function cicloParaAutoavaliacao(
  db: Db,
  id?: string,
): Promise<CicloDeAutoavaliacao | null> {
  const r = id
    ? await db.query<CicloDeAutoavaliacao>(
        `select id, nome, status from ciclos_avaliacao where id = $1::uuid`,
        [id],
      )
    : await db.query<CicloDeAutoavaliacao>(
        `select id, nome, status from ciclos_avaliacao
          order by (status = 'aberto') desc, inicio desc, id limit 1`,
      );
  return r.rows[0] ?? null;
}

/** Sugestão mais recente por indicador, no ciclo. */
export async function sugestoesDoCiclo(
  db: Db,
  atletaId: string,
  cicloId: string,
): Promise<Map<string, SugestaoDoAtleta>> {
  const r = await db.query<{
    indicador_id: string;
    valor: number;
    evidencia: string | null;
    link: string | null;
    anexo_id: string | null;
    anexo_nome: string | null;
    lancado_em: Date;
  }>(
    `select distinct on (n.indicador_id) n.indicador_id, n.valor, n.evidencia, n.link,
            n.anexo_id, ea.nome_arquivo as anexo_nome, n.lancado_em
       from avaliacoes n
       left join evidencias_anexos ea on ea.id = n.anexo_id
      where n.atleta_id = $1::uuid and n.ciclo_id = $2::uuid and n.origem = 'autoavaliacao'
      order by n.indicador_id, n.lancado_em desc, n.id desc`,
    [atletaId, cicloId],
  );
  return new Map(
    r.rows.map((l) => [
      l.indicador_id,
      {
        valor: Number(l.valor),
        evidencia: l.evidencia,
        link: l.link,
        anexo: l.anexo_id ? { id: l.anexo_id, nomeArquivo: l.anexo_nome ?? "" } : null,
        em: iso(l.lancado_em),
      },
    ]),
  );
}

/** Nota do avaliador mais recente por indicador, no ciclo. */
export async function notasDoTreinadorNoCiclo(
  db: Db,
  atletaId: string,
  cicloId: string,
): Promise<Map<string, NotaDoTreinador>> {
  const r = await db.query<{
    indicador_id: string;
    valor: number;
    origem: NotaDoTreinador["origem"];
    justificativa: string | null;
    avaliador_nome: string | null;
    lancado_em: Date;
  }>(
    `select distinct on (n.indicador_id) n.indicador_id, n.valor, n.origem, n.justificativa,
            u.nome as avaliador_nome, n.lancado_em
       from avaliacoes n
       left join usuarios u on u.id = n.avaliador_id
      where n.atleta_id = $1::uuid and n.ciclo_id = $2::uuid and ${sqlNotaDoAvaliador("n")}
      order by n.indicador_id, n.lancado_em desc, n.id desc`,
    [atletaId, cicloId],
  );
  return new Map(
    r.rows.map((l) => [
      l.indicador_id,
      {
        valor: Number(l.valor),
        origem: l.origem,
        justificativa: l.justificativa,
        avaliador: l.avaliador_nome ? { nome: l.avaliador_nome } : null,
        em: iso(l.lancado_em),
      },
    ]),
  );
}

/** Sugestões do atleta no ciclo ABERTO (a que vale para a decisão do treinador). Nulo sem ciclo aberto. */
export async function sugestoesDoCicloAberto(
  db: Db,
  atletaId: string,
): Promise<{ cicloId: string; sugestoes: Map<string, SugestaoDoAtleta> } | null> {
  const c = await db.query<{ id: string }>(
    `select id from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  const cicloId = c.rows[0]?.id;
  if (!cicloId) return null;
  return { cicloId, sugestoes: await sugestoesDoCiclo(db, atletaId, cicloId) };
}

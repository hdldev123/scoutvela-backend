import type { Db } from "../db/db.js";
import type { NivelCompeticao } from "../domain/tipos.js";
import type { ResultadoDoAtleta } from "./atletas.js";

/**
 * Conquista como a ficha mostra. `resultado`: pódio (1º a 3º) de um resultado validado, calculado na
 * leitura. `manual`: informada pelo atleta, com anexo, e já validada pelo treinador ou pelo gestor.
 */
export interface ConquistaFicha {
  tipo: "resultado" | "manual";
  titulo: string;
  ano: number;
  evento?: string;
  nivel?: NivelCompeticao;
  posicao?: number;
}

/** Pódios dos resultados validados (fonte `manual`, Ranking CBVela ou do atleta, só se validado). */
export function conquistasAutomaticas(resultados: ResultadoDoAtleta[]): ConquistaFicha[] {
  return resultados
    .filter((r) => r.status === "validado" && r.posicao >= 1 && r.posicao <= 3)
    .map((r) => ({
      tipo: "resultado" as const,
      titulo: `${r.posicao}º lugar em ${r.evento}`,
      ano: r.edicao,
      evento: r.evento,
      nivel: r.nivel,
      posicao: r.posicao,
    }));
}

/** Conquistas manuais já validadas (a rota decide se o papel pode vê-las). */
export async function conquistasManuaisValidadas(
  db: Db,
  atletaId: string,
): Promise<ConquistaFicha[]> {
  const r = await db.query<{ titulo: string; ano: number }>(
    `select titulo, ano from conquistas_atleta
      where atleta_id = $1::uuid and status = 'validada'
      order by ano desc, criado_em desc, id`,
    [atletaId],
  );
  return r.rows.map((l) => ({ tipo: "manual" as const, titulo: l.titulo, ano: l.ano }));
}

/** Do ano mais novo para o mais antigo; no mesmo ano, as de resultado primeiro, pela colocação. */
export function ordenarConquistas(lista: ConquistaFicha[]): ConquistaFicha[] {
  return [...lista].sort((a, b) => {
    if (a.ano !== b.ano) return b.ano - a.ano;
    if (a.tipo !== b.tipo) return a.tipo === "resultado" ? -1 : 1;
    return (a.posicao ?? 0) - (b.posicao ?? 0);
  });
}

export interface ConquistaManual {
  id: string;
  titulo: string;
  ano: number;
  status: "pendente" | "validada" | "recusada";
  motivo: string | null;
  anexoId: string;
  criadoEm: string;
  decididoPor: { id: string; nome: string } | null;
  decididoEm: string | null;
}

interface LinhaConquista {
  id: string;
  titulo: string;
  ano: number;
  status: ConquistaManual["status"];
  motivo: string | null;
  anexo_id: string;
  criado_em: Date;
  decidido_por: string | null;
  decisor_nome: string | null;
  decidido_em: Date | null;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

const COLUNAS_CONQUISTA = `c.id::text as id, c.titulo, c.ano, c.status, c.motivo, c.anexo_id::text as anexo_id,
       c.criado_em, c.decidido_por::text as decidido_por, u.nome as decisor_nome, c.decidido_em`;
const ORIGEM_CONQUISTA = `conquistas_atleta c left join usuarios u on u.id = c.decidido_por`;

const paraConquistaManual = (l: LinhaConquista): ConquistaManual => ({
  id: l.id,
  titulo: l.titulo,
  ano: l.ano,
  status: l.status,
  motivo: l.motivo,
  anexoId: l.anexo_id,
  criadoEm: iso(l.criado_em),
  decididoPor: l.decidido_por ? { id: l.decidido_por, nome: l.decisor_nome ?? "" } : null,
  decididoEm: l.decidido_em ? iso(l.decidido_em) : null,
});

export async function lerConquista(db: Db, id: string): Promise<ConquistaManual> {
  const r = await db.query<LinhaConquista>(
    `select ${COLUNAS_CONQUISTA} from ${ORIGEM_CONQUISTA} where c.id = $1::uuid`,
    [id],
  );
  return paraConquistaManual(r.rows[0]!);
}

/** Todas as conquistas manuais do atleta, de qualquer situação, da mais nova para a mais antiga. */
export async function listarConquistasManuais(
  db: Db,
  atletaId: string,
): Promise<ConquistaManual[]> {
  const r = await db.query<LinhaConquista>(
    `select ${COLUNAS_CONQUISTA} from ${ORIGEM_CONQUISTA}
      where c.atleta_id = $1::uuid order by c.criado_em desc, c.id`,
    [atletaId],
  );
  return r.rows.map(paraConquistaManual);
}

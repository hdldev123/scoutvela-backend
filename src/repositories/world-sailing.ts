import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { filtroVisibilidade } from "./atletas.js";

/**
 * Atleta ativo que o usuário pode consultar na seção World Sailing. O filtro de acesso fica na consulta:
 * gestor vê qualquer um, treinador só os próprios, atleta só a si. Diferente de `buscarAtletaVisivel`, não
 * exige o cadastro completo (o gestor busca logo depois de cadastrar, antes do primeiro acesso).
 * Quem não pode ver recebe nulo, sem distinguir de inexistente.
 */
export async function buscarAtletaParaWorldSailing(
  db: Db,
  usuario: Pick<UsuarioAutenticado, "papel" | "id" | "atletaId">,
  atletaId: string,
): Promise<{ id: string; wsId: string } | null> {
  const vis = filtroVisibilidade(usuario, "a", 2);
  const r = await db.query<{ id: string; ws_id: string }>(
    `select a.id, a.ws_id from atletas a
      where a.id = $1::uuid and a.ativo and a.anonimizado_em is null and (${vis.sql})`,
    [atletaId, ...vis.params],
  );
  const l = r.rows[0];
  return l ? { id: l.id, wsId: l.ws_id } : null;
}

export interface RankingDoAtleta {
  data: string;
  classe: string;
  tipo: string | null;
  posicao: number;
  pontos: number | null;
}

/** Histórico de ranking do atleta, do mais recente para o mais antigo (mesmo filtro de acesso). */
export async function listarRankingWorldSailing(
  db: Db,
  usuario: Pick<UsuarioAutenticado, "papel" | "id" | "atletaId">,
  atletaId: string,
): Promise<RankingDoAtleta[]> {
  const vis = filtroVisibilidade(usuario, "a", 2);
  const r = await db.query<{
    data: string;
    classe: string;
    tipo: string | null;
    posicao: number;
    pontos: string | null;
  }>(
    `select k.data::text as data, k.classe, k.tipo, k.posicao, k.pontos
       from world_sailing_ranking k join atletas a on a.id = k.atleta_id
      where k.atleta_id = $1::uuid and a.ativo and a.anonimizado_em is null and (${vis.sql})
      order by k.data desc, k.classe, k.tipo nulls last, k.id`,
    [atletaId, ...vis.params],
  );
  return r.rows.map((l) => ({
    data: l.data,
    classe: l.classe,
    tipo: l.tipo,
    posicao: l.posicao,
    pontos: l.pontos === null ? null : Number(l.pontos),
  }));
}

/** Última busca do atleta (qualquer status), do mais recente. */
export async function ultimaImportacaoWorldSailing(
  db: Db,
  usuario: Pick<UsuarioAutenticado, "papel" | "id" | "atletaId">,
  atletaId: string,
): Promise<{ em: Date; status: "ok" | "nao_encontrado" | "falhou" } | null> {
  const vis = filtroVisibilidade(usuario, "a", 2);
  const r = await db.query<{ em: Date; status: "ok" | "nao_encontrado" | "falhou" }>(
    `select i.executada_em as em, i.status
       from world_sailing_importacoes i join atletas a on a.id = i.atleta_id
      where i.atleta_id = $1::uuid and a.ativo and a.anonimizado_em is null and (${vis.sql})
      order by i.executada_em desc, i.id desc limit 1`,
    [atletaId, ...vis.params],
  );
  return r.rows[0] ?? null;
}

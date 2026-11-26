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

export interface MedidaSugeridaWs {
  pesoKg: number | null;
  alturaCm: number | null;
  /** AAAA-MM-DD: quando o velejador atualizou o perfil na World Sailing. */
  informadoEm: string | null;
}

/** Texto SQL da sugestão pendente (D20): há peso ou altura, e nunca foi decidida ou o perfil mudou depois. */
const SQL_MEDIDA_PENDENTE = `(p.peso_kg is not null or p.altura_cm is not null)
  and (p.medida_decidida_em is null or p.medida_decidida_ref is distinct from p.perfil_atualizado_em)`;

interface LinhaMedidaSugerida {
  peso_kg: string | null;
  altura_cm: string | null;
  informado_em: string | null;
}

const paraMedidaSugerida = (l: LinhaMedidaSugerida): MedidaSugeridaWs => ({
  pesoKg: l.peso_kg === null ? null : Number(l.peso_kg),
  alturaCm: l.altura_cm === null ? null : Number(l.altura_cm),
  informadoEm: l.informado_em,
});

/**
 * Sugestão de medida (D20) ainda não decidida do atleta, ou nulo. O acesso ao atleta já foi conferido por
 * `buscarAtletaParaWorldSailing`. Peso e altura são dado sensível: nunca vão para log nem para auditoria.
 */
export async function buscarMedidaSugerida(
  db: Db,
  atletaId: string,
): Promise<MedidaSugeridaWs | null> {
  const r = await db.query<LinhaMedidaSugerida>(
    `select p.peso_kg, p.altura_cm, p.perfil_atualizado_em::text as informado_em
       from world_sailing_perfis p
      where p.atleta_id = $1::uuid and ${SQL_MEDIDA_PENDENTE}`,
    [atletaId],
  );
  return r.rows[0] ? paraMedidaSugerida(r.rows[0]) : null;
}

/** Igual a `buscarMedidaSugerida`, mas trava a linha para a decisão (usar ou dispensar) numa transação. */
export async function travarMedidaSugerida(
  tx: Db,
  atletaId: string,
): Promise<MedidaSugeridaWs | null> {
  const r = await tx.query<LinhaMedidaSugerida>(
    `select p.peso_kg, p.altura_cm, p.perfil_atualizado_em::text as informado_em
       from world_sailing_perfis p
      where p.atleta_id = $1::uuid and ${SQL_MEDIDA_PENDENTE}
        for update of p`,
    [atletaId],
  );
  return r.rows[0] ? paraMedidaSugerida(r.rows[0]) : null;
}

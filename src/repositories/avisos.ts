import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { filtroVisibilidade } from "./atletas.js";

/** Tipos de aviso (lista fechada no banco; tipo novo entra por migration). */
export const TIPOS_AVISO = [
  "atleta_respondeu",
  "atleta_anexou",
  "atleta_atualizou_perfil",
  "atleta_completou_cadastro",
  "pedido_ajuste",
  "sugestao_respondida",
  "atleta_autoavaliou",
  "autoavaliacao_corrigida",
  "atleta_enviou_pesagem",
  "pesagem_validada",
  "pesagem_recusada",
  "atleta_lancou_resultado",
  "resultado_validado",
  "resultado_recusado",
  "atleta_registrou_conquista",
  "conquista_validada",
  "conquista_recusada",
  "mensagem_nova",
] as const;
export type TipoAviso = (typeof TIPOS_AVISO)[number];

/** Avisos lidos há mais de 180 dias são apagados pelo job de limpeza. */
export const DIAS_RETENCAO_AVISOS = 180;

/**
 * Só ids e nomes de campo: nunca nota, peso, texto livre do atleta nem nome de arquivo.
 * Ex.: `{ indicadorId }`, `{ anexoId, categoria }`, `{ pedidoAjusteId }`, `{ sugestaoId, status }`,
 * `{ quantidade }` (autoavaliação), `{ pesagemId }` (pesagem), `{ resultadoId }` (resultado), `{ conquistaId }` (conquista), `{ conversaId }` (mensagem nova do chat).
 */
export type ReferenciaAviso = Record<string, string | number | string[] | null>;

export interface NovoAviso {
  tipo: TipoAviso;
  atletaId: string | null;
  referencia: ReferenciaAviso;
  /** Quem causou o aviso; nunca recebe o próprio aviso. */
  autorId: string | null;
  em: Date;
}

/**
 * Cria um aviso para um usuário. Chame dentro da transação da escrita que o gerou. Não avisa quem é
 * o próprio autor. Devolve true se criou.
 */
export async function registrarAviso(
  tx: Db,
  destinatarioId: string,
  aviso: NovoAviso,
): Promise<boolean> {
  if (aviso.autorId !== null && aviso.autorId === destinatarioId) return false;
  await tx.query(
    `insert into avisos (destinatario_id, tipo, atleta_id, referencia, criado_por, criado_em)
     values ($1::uuid, $2, $3::uuid, $4::jsonb, $5::uuid, $6)`,
    [
      destinatarioId,
      aviso.tipo,
      aviso.atletaId,
      JSON.stringify(aviso.referencia),
      aviso.autorId,
      aviso.em,
    ],
  );
  return true;
}

/**
 * Avisa o treinador do atleta (se houver, ativo e diferente do autor). Chame dentro da transação
 * da escrita. Devolve true se criou.
 */
export async function avisarTreinadorDoAtleta(
  tx: Db,
  atletaId: string,
  aviso: Omit<NovoAviso, "atletaId">,
): Promise<boolean> {
  const r = await tx.query(
    `insert into avisos (destinatario_id, tipo, atleta_id, referencia, criado_por, criado_em)
     select a.treinador_id, $2, a.id, $3::jsonb, $4::uuid, $5
       from atletas a join usuarios t on t.id = a.treinador_id and t.ativo
      where a.id = $1::uuid and a.treinador_id is distinct from $4::uuid
  returning id`,
    [atletaId, aviso.tipo, JSON.stringify(aviso.referencia), aviso.autorId, aviso.em],
  );
  return r.rows.length > 0;
}

/**
 * Avisa as contas de login do atleta. Devolve quantos avisos criou (0 = o atleta ainda não tem conta).
 */
export async function avisarContasDoAtleta(
  tx: Db,
  atletaId: string,
  aviso: Omit<NovoAviso, "atletaId">,
): Promise<number> {
  const r = await tx.query(
    `insert into avisos (destinatario_id, tipo, atleta_id, referencia, criado_por, criado_em)
     select u.id, $2, $1::uuid, $3::jsonb, $4::uuid, $5
       from usuarios u
      where u.papel = 'atleta' and u.atleta_id = $1::uuid and u.ativo
        and u.id is distinct from $4::uuid
  returning id`,
    [atletaId, aviso.tipo, JSON.stringify(aviso.referencia), aviso.autorId, aviso.em],
  );
  return r.rows.length;
}

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

/** Papéis que recebem avisos (o IBVAR não recebe). */
export const recebeAvisos = (papel: string): boolean =>
  papel === "gestor" || papel === "treinador" || papel === "atleta";

export interface FiltroAvisos {
  apenasNaoLidos?: boolean;
  limite?: number;
  antesDe?: Date;
}

export interface LinhaAviso {
  id: string;
  tipo: TipoAviso;
  criado_em: Date;
  lido_em: Date | null;
  atleta_id: string | null;
  atleta_nome: string | null;
  referencia: ReferenciaAviso;
  autor_nome: string | null;
  autor_papel: string | null;
  mensagem: string | null;
  indicador_id: string | null;
  indicador_nome: string | null;
}

/**
 * Avisos do destinatário, do mais recente para o mais antigo. O acesso fica no SQL: o aviso que cita
 * um atleta só aparece se o destinatário ainda pode ver esse atleta (matriz de acesso; ex.: treinador
 * que deixou de ser o treinador dele não o vê mais). A mensagem do pedido de ajuste só sai para o
 * próprio destinatário (a consulta é sempre por `destinatario_id`).
 */
export async function listarAvisos(
  db: Db,
  usuario: UsuarioDeAcesso,
  filtro: FiltroAvisos,
): Promise<LinhaAviso[]> {
  if (!recebeAvisos(usuario.papel)) return [];
  const vis = filtroVisibilidade(usuario, "a", 2);
  const params: unknown[] = [usuario.id, ...vis.params];
  const where = [`v.destinatario_id = $1::uuid`, `(v.atleta_id is null or ${vis.sql})`];
  if (filtro.apenasNaoLidos) where.push(`v.lido_em is null`);
  if (filtro.antesDe) {
    params.push(filtro.antesDe);
    where.push(`v.criado_em < $${params.length}::timestamptz`);
  }
  params.push(filtro.limite ?? 20);
  const r = await db.query<LinhaAviso>(
    `select v.id::text as id, v.tipo, v.criado_em, v.lido_em, a.id::text as atleta_id, a.nome as atleta_nome,
            v.referencia, au.nome as autor_nome, au.papel as autor_papel,
            pa.mensagem, i.id as indicador_id, i.nome as indicador_nome
       from avisos v
       left join atletas a on a.id = v.atleta_id
       left join usuarios au on au.id = v.criado_por
       left join pedidos_ajuste pa
              on v.tipo = 'pedido_ajuste' and pa.id::text = v.referencia->>'pedidoAjusteId'
       left join indicadores i on i.id = coalesce(pa.indicador_id, v.referencia->>'indicadorId')
      where ${where.join(" and ")}
      order by v.criado_em desc, v.id desc
      limit $${params.length}`,
    params,
  );
  return r.rows;
}

/** Quantos avisos não lidos o usuário tem (mesmo filtro de acesso da lista). */
export async function contarAvisosNaoLidos(db: Db, usuario: UsuarioDeAcesso): Promise<number> {
  if (!recebeAvisos(usuario.papel)) return 0;
  const vis = filtroVisibilidade(usuario, "a", 2);
  const r = await db.query<{ n: string }>(
    `select count(*)::text as n
       from avisos v left join atletas a on a.id = v.atleta_id
      where v.destinatario_id = $1::uuid and v.lido_em is null
        and (v.atleta_id is null or ${vis.sql})`,
    [usuario.id, ...vis.params],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Marca um aviso do próprio destinatário como lido (idempotente). Falso = não existe ou é de outro. */
export async function marcarAvisoLido(
  db: Db,
  usuarioId: string,
  avisoId: string,
  em: Date,
): Promise<boolean> {
  const r = await db.query(
    `update avisos set lido_em = coalesce(lido_em, $3)
      where id = $1::bigint and destinatario_id = $2::uuid
  returning id`,
    [avisoId, usuarioId, em],
  );
  return r.rows.length > 0;
}

/** Marca todos os avisos não lidos do usuário. Devolve quantos mudaram. */
export async function marcarTodosAvisosLidos(db: Db, usuarioId: string, em: Date): Promise<number> {
  const r = await db.query(
    `update avisos set lido_em = $2 where destinatario_id = $1::uuid and lido_em is null returning id`,
    [usuarioId, em],
  );
  return r.rows.length;
}

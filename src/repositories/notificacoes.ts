import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { pendenciasDoCiclo } from "./pendencias.js";
import { termoSql } from "./termo.js";

export const CHAVES_NOTIFICACAO = ["painel", "revisoes", "cadastro", "avaliar"] as const;
export type ChaveNotificacao = (typeof CHAVES_NOTIFICACAO)[number];

/** Chaves que cada papel pode marcar como vistas (PUT /me/notificacoes/vistas). */
export const CHAVES_VISTAS_POR_PAPEL: Partial<Record<string, ChaveNotificacao[]>> = {
  atleta: ["painel"],
};

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

const contagem = (v: string | undefined) => Number(v ?? 0);

/**
 * Contagens dos balões do menu. Só as chaves do papel, sempre presentes (0 quando nada pede atenção).
 * O acesso é aplicado no SQL (a matriz de acesso): o treinador só enxerga atletas próprios e o atleta só o seu.
 * Poucas consultas, todas sobre índices existentes (pedidos abertos: índices parciais por status).
 */
export async function contarNotificacoes(
  db: Db,
  usuario: UsuarioDeAcesso,
  agora: Date,
): Promise<Record<string, number>> {
  switch (usuario.papel) {
    case "gestor": {
      const r = await db.query<{ revisoes: string; cadastro: string }>(
        `select ((select count(*) from pedidos_revisao where status = 'aberto')
               + (select count(*) from pedidos_titular where status = 'aberto'))::text as revisoes,
                (select count(*) from atletas a
                  where a.ativo and not ${termoSql.aceitoVigente("a.id", "$1")})::text as cadastro`,
        [agora],
      );
      return { revisoes: contagem(r.rows[0]?.revisoes), cadastro: contagem(r.rows[0]?.cadastro) };
    }
    case "treinador": {
      const [rev, ciclo] = await Promise.all([
        db.query<{ n: string }>(
          `select count(*)::text as n from pedidos_revisao r
             join atletas a on a.id = r.atleta_id
            where r.status = 'aberto' and a.treinador_id = $1::uuid`,
          [usuario.id],
        ),
        cicloAbertoId(db),
      ]);
      // Mesma regra do job de lembretes e de GET /ciclos/:id/pendencias.
      const avaliar = ciclo
        ? ((await pendenciasDoCiclo(db, ciclo, agora, { treinadorId: usuario.id })).treinadores[0]
            ?.atletasPendentes.length ?? 0)
        : 0;
      return { revisoes: contagem(rev.rows[0]?.n), avaliar };
    }
    case "atleta": {
      if (!usuario.atletaId) return { painel: 0 };
      const [extras, ciclo] = await Promise.all([
        db.query<{ termo: boolean; respostas: string }>(
          `select not ${termoSql.aceitoVigente("$1::uuid", "$2")} as termo,
                  ((select count(*) from pedidos_revisao r
                     where r.atleta_id = $1::uuid and r.status = 'respondido'
                       and r.respondido_em > coalesce(v.visto_em, '-infinity'::timestamptz))
                 + (select count(*) from pedidos_titular t
                     where t.atleta_id = $1::uuid and t.status = 'respondido'
                       and t.respondido_em > coalesce(v.visto_em, '-infinity'::timestamptz)))::text as respostas
             from (select (select visto_em from notificacoes_vistas
                            where usuario_id = $3::uuid and chave = 'painel') as visto_em) v`,
          [usuario.atletaId, agora, usuario.id],
        ),
        cicloAbertoId(db),
      ]);
      const perguntas = ciclo
        ? ((await pendenciasDoCiclo(db, ciclo, agora, { atletaId: usuario.atletaId })).atletas[0]
            ?.perguntasSemResposta ?? 0)
        : 0;
      const l = extras.rows[0];
      return { painel: perguntas + (l?.termo ? 1 : 0) + contagem(l?.respostas) };
    }
    default:
      // IBVAR e demais papéis: nada.
      return {};
  }
}

async function cicloAbertoId(db: Db): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `select id from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  return r.rows[0]?.id ?? null;
}

/** Upsert do "visto". Dado de interface: sem auditoria. */
export async function marcarVista(
  db: Db,
  usuarioId: string,
  chave: ChaveNotificacao,
  agora: Date,
): Promise<void> {
  await db.query(
    `insert into notificacoes_vistas (usuario_id, chave, visto_em) values ($1::uuid, $2, $3::timestamptz)
     on conflict (usuario_id, chave) do update set visto_em = excluded.visto_em`,
    [usuarioId, chave, agora],
  );
}

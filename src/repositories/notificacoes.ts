import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { contarAvisosNaoLidos } from "./avisos.js";
import { contarConversasNaoLidas } from "./conversas.js";
import { pendenciasDoCiclo } from "./pendencias.js";
import { termoSql } from "./termo.js";

export const CHAVES_NOTIFICACAO = [
  "painel",
  "revisoes",
  "cadastro",
  "avaliar",
  "investimento",
] as const;
export type ChaveNotificacao = (typeof CHAVES_NOTIFICACAO)[number];

/** Chaves que cada papel pode marcar como vistas (PUT /me/notificacoes/vistas). */
export const CHAVES_VISTAS_POR_PAPEL: Partial<Record<string, ChaveNotificacao[]>> = {
  atleta: ["painel"],
  gestor: ["investimento"],
  ibvar: ["investimento"],
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
      const [r, investimento, avisos, sugestoes, conversas] = await Promise.all([
        db.query<{ revisoes: string; cadastro: string }>(
          `select ((select count(*) from pedidos_revisao where status = 'aberto')
               + (select count(*) from pedidos_titular where status = 'aberto'))::text as revisoes,
                ((select count(*) from atletas a
                   where a.ativo and not ${termoSql.aceitoVigente("a.id", "$1")})
               + (select count(*) from atletas a
                   where a.cadastro_recusado_em is not null and a.anonimizado_em is null))::text as cadastro`,
          [agora],
        ),
        avisoCicloFechado(db, usuario.id),
        contarAvisosNaoLidos(db, usuario),
        db.query<{ n: string }>(
          `select count(*)::text as n from sugestoes where status = 'aberta'`,
        ),
        contarConversasNaoLidas(db, usuario),
      ]);
      return {
        revisoes: contagem(r.rows[0]?.revisoes),
        cadastro: contagem(r.rows[0]?.cadastro),
        investimento,
        avisos,
        sugestoes: contagem(sugestoes.rows[0]?.n),
        conversas,
      };
    }
    case "treinador": {
      const [rev, ciclo, avisos, conversas] = await Promise.all([
        db.query<{ n: string }>(
          `select count(*)::text as n from pedidos_revisao r
             join atletas a on a.id = r.atleta_id
            where r.status = 'aberto' and r.instancia = 1 and a.treinador_id = $1::uuid`,
          [usuario.id],
        ),
        cicloAbertoId(db),
        contarAvisosNaoLidos(db, usuario),
        contarConversasNaoLidas(db, usuario),
      ]);
      // Mesma regra do job de lembretes e de GET /ciclos/:id/pendencias.
      const avaliar = ciclo
        ? ((await pendenciasDoCiclo(db, ciclo, agora, { treinadorId: usuario.id })).treinadores[0]
            ?.atletasPendentes.length ?? 0)
        : 0;
      return { revisoes: contagem(rev.rows[0]?.n), avaliar, avisos, conversas };
    }
    case "atleta": {
      if (!usuario.atletaId)
        return { painel: 0, avisos: await contarAvisosNaoLidos(db, usuario), conversas: 0 };
      const [extras, ciclo, avisos, conversas] = await Promise.all([
        db.query<{ termo: boolean; incompleto: boolean; respostas: string }>(
          `select not ${termoSql.aceitoVigente("$1::uuid", "$2")} as termo,
                  (select cadastro_completo_em is null from atletas where id = $1::uuid) as incompleto,
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
        contarAvisosNaoLidos(db, usuario),
        contarConversasNaoLidas(db, usuario),
      ]);
      // Perguntas ainda sem resposta (regra de repositories/pendencias.ts: não é por ciclo).
      const perguntas = ciclo
        ? ((await pendenciasDoCiclo(db, ciclo, agora, { atletaId: usuario.atletaId })).atletas[0]
            ?.perguntasSemResposta ?? 0)
        : 0;
      const l = extras.rows[0];
      return {
        painel: perguntas + (l?.termo ? 1 : 0) + (l?.incompleto ? 1 : 0) + contagem(l?.respostas),
        avisos,
        conversas,
      };
    }
    case "ibvar":
      return { investimento: await avisoCicloFechado(db, usuario.id) };
    default:
      return {};
  }
}

/**
 * Balão de Investimento (gestor e IBVAR): 1 se há ciclo fechado depois da última vez que a pessoa
 * marcou a tela como vista (nunca marcou: qualquer ciclo fechado conta); senão 0.
 */
async function avisoCicloFechado(db: Db, usuarioId: string): Promise<number> {
  const r = await db.query<{ novo: boolean }>(
    `select exists (
              select 1 from ciclos_avaliacao c
               where c.status = 'fechado' and c.fechado_em is not null
                 and c.fechado_em > coalesce(
                       (select v.visto_em from notificacoes_vistas v
                         where v.usuario_id = $1::uuid and v.chave = 'investimento'),
                       '-infinity'::timestamptz)) as novo`,
    [usuarioId],
  );
  return r.rows[0]?.novo ? 1 : 0;
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

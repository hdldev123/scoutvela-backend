import type { Db } from "../db/db.js";
import { termoSql } from "./termo.js";

/**
 * Regra única de pendência do ciclo, usada pelo job de lembretes e pela tela do gestor
 * (GET /ciclos/:id/pendencias). Só entram atletas ativos com o termo do piloto aceito.
 *
 * - Treinador: treinador ativo com atleta sem nota, no ciclo, em algum indicador T não calculado
 *   (a nota sugerida pela resposta do atleta não conta).
 * - Atleta: perguntas do questionário ainda sem resposta.
 */

export interface AtletaPendenteDoTreinador {
  id: string;
  nome: string;
  /** Indicadores T (não calculados) sem nota neste ciclo. */
  faltam: number;
}

export interface TreinadorComPendencia {
  id: string;
  nome: string;
  email: string;
  atletasPendentes: AtletaPendenteDoTreinador[];
}

export interface AtletaComPendencia {
  id: string;
  nome: string;
  perguntasSemResposta: number;
  /** Conta ativa do atleta (para o lembrete por e-mail). Nula: o atleta ainda não tem como responder. */
  conta: { usuarioId: string; email: string } | null;
}

export interface PendenciasCiclo {
  treinadores: TreinadorComPendencia[];
  atletas: AtletaComPendencia[];
}

const FUSO = "America/Sao_Paulo";
const MS_DIA = 86_400_000;

/** Data civil (AAAA-MM-DD) de um instante no fuso de Brasília. */
export function diaEmBrasilia(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: FUSO,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

const dias = (iso: string) => Date.parse(`${iso}T00:00:00Z`) / MS_DIA;

/** Dias do dia de hoje (Brasília) até o prazo. Zero no dia do prazo; negativo depois dele. */
export function diasParaPrazo(prazo: string, agora: Date): number {
  return dias(prazo) - dias(diaEmBrasilia(agora));
}

export async function pendenciasDoCiclo(
  db: Db,
  cicloId: string,
  agora: Date,
): Promise<PendenciasCiclo> {
  const [treinos, atletas] = await Promise.all([
    db.query<{
      treinador_id: string;
      treinador_nome: string;
      treinador_email: string;
      atleta_id: string;
      atleta_nome: string;
      faltam: string;
    }>(
      `select u.id as treinador_id, u.nome as treinador_nome, u.email as treinador_email,
              a.id as atleta_id, a.nome as atleta_nome,
              (select count(*) from indicadores i
                where i.tipo = 'T' and not i.calculado
                  and not exists (select 1 from avaliacoes n
                                   where n.atleta_id = a.id and n.indicador_id = i.id
                                     and n.ciclo_id = $1::uuid and n.origem <> 'resposta_sugerida'))::text as faltam
         from usuarios u
         join atletas a on a.treinador_id = u.id and a.ativo
        where u.papel = 'treinador' and u.ativo
          and ${termoSql.aceitoNoPiloto("a.id", "$2")}
        order by u.nome, u.id, a.nome, a.id`,
      [cicloId, agora],
    ),
    db.query<{
      id: string;
      nome: string;
      perguntas: string;
      usuario_id: string | null;
      usuario_email: string | null;
    }>(
      `select a.id, a.nome,
              (select count(*) from perguntas_atleta q
                where not exists (select 1 from resposta_atual ra
                                   where ra.atleta_id = a.id and ra.indicador_id = q.indicador_id))::text as perguntas,
              conta.id as usuario_id, conta.email as usuario_email
         from atletas a
         left join lateral (select u.id, u.email from usuarios u
                             where u.atleta_id = a.id and u.papel = 'atleta' and u.ativo
                             order by u.criado_em, u.id limit 1) conta on true
        where a.ativo and ${termoSql.aceitoNoPiloto("a.id", "$1")}
        order by a.nome, a.id`,
      [agora],
    ),
  ]);

  const treinadores: TreinadorComPendencia[] = [];
  const porId = new Map<string, TreinadorComPendencia>();
  for (const l of treinos.rows) {
    const faltam = Number(l.faltam);
    if (faltam === 0) continue;
    let t = porId.get(l.treinador_id);
    if (!t) {
      t = {
        id: l.treinador_id,
        nome: l.treinador_nome,
        email: l.treinador_email,
        atletasPendentes: [],
      };
      porId.set(l.treinador_id, t);
      treinadores.push(t);
    }
    t.atletasPendentes.push({ id: l.atleta_id, nome: l.atleta_nome, faltam });
  }

  return {
    treinadores,
    atletas: atletas.rows
      .map((l) => ({
        id: l.id,
        nome: l.nome,
        perguntasSemResposta: Number(l.perguntas),
        conta:
          l.usuario_id && l.usuario_email
            ? { usuarioId: l.usuario_id, email: l.usuario_email }
            : null,
      }))
      .filter((a) => a.perguntasSemResposta > 0),
  };
}

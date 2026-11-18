import type { Db } from "../db/db.js";
import { diaEmBrasilia, diasParaPrazo, pendenciasDoCiclo } from "../repositories/pendencias.js";
import type { MensagemEmail, ProvedorEmail } from "../email/index.js";

export interface OpcoesLembretes {
  db: Db;
  email: ProvedorEmail;
  agora: Date;
  frontUrl: string;
  /** Dias antes do prazo em que o lembrete sai. Depois do prazo, sai todo dia. */
  diasAntes?: number[];
  /** Só contagens e ids; nunca e-mail, nome ou texto. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export interface ResultadoLembretes {
  treinadores: number;
  atletas: number;
  /** Pessoas com pendência que não receberam: já avisadas hoje ou falha de envio. */
  ignorados: number;
}

const dataBr = (iso: string) => iso.split("-").reverse().join("/");

interface Pendente {
  usuarioId: string;
  email: string;
  quantidade: number;
}

/**
 * Quem recebe lembrete, pela regra compartilhada (repositories/pendencias): o treinador recebe a
 * contagem de atletas pendentes; o atleta, a de perguntas sem resposta, se tiver conta ativa.
 */
async function destinatarios(
  db: Db,
  cicloId: string,
  agora: Date,
): Promise<{ treinadores: Pendente[]; atletas: Pendente[] }> {
  const p = await pendenciasDoCiclo(db, cicloId, agora);
  return {
    treinadores: p.treinadores.map((t) => ({
      usuarioId: t.id,
      email: t.email,
      quantidade: t.atletasPendentes.length,
    })),
    atletas: p.atletas.flatMap((a) =>
      a.conta
        ? [
            {
              usuarioId: a.conta.usuarioId,
              email: a.conta.email,
              quantidade: a.perguntasSemResposta,
            },
          ]
        : [],
    ),
  };
}

function frasePrazo(prazo: string, restam: number): string {
  if (restam < 0) return `O prazo terminou em ${dataBr(prazo)}.`;
  if (restam === 0) return `O prazo termina hoje (${dataBr(prazo)}).`;
  return `O prazo termina em ${dataBr(prazo)}.`;
}

type Montar = (
  para: string,
  ciclo: string,
  prazo: string,
  restam: number,
  n: number,
  url: string,
) => MensagemEmail;

const mensagemTreinador: Montar = (para, ciclo, prazo, restam, n, url) => ({
  para,
  assunto:
    restam < 0
      ? `Scout Vela: avaliações do ciclo ${ciclo} em atraso`
      : `Scout Vela: avaliações do ciclo ${ciclo} pendentes`,
  texto:
    `Olá,\n\nNo ciclo ${ciclo} você tem ${n === 1 ? "1 atleta" : `${n} atletas`} com avaliação incompleta. ` +
    `${frasePrazo(prazo, restam)}\n\nLance as notas em: ${url}/avaliar\n\nScout Vela`,
});

const mensagemAtleta: Montar = (para, ciclo, prazo, restam, n, url) => ({
  para,
  assunto:
    restam < 0
      ? `Scout Vela: questionário do ciclo ${ciclo} em atraso`
      : `Scout Vela: questionário do ciclo ${ciclo} pendente`,
  texto:
    `Olá,\n\nNo ciclo ${ciclo} você tem ${n === 1 ? "1 pergunta" : `${n} perguntas`} sem resposta. ` +
    `${frasePrazo(prazo, restam)}\n\nResponda em: ${url}/painel\n\nScout Vela`,
});

/**
 * Job diário (Cron Job do Render). Só envia se houver ciclo aberto e faltarem exatamente N dias
 * (N em `diasAntes`) ou o prazo tiver passado. Um e-mail por pessoa com pendência, no máximo um por dia.
 * O e-mail não traz nota, peso nem nome de atleta: só contagem, prazo e link.
 */
export async function executarLembretes(opcoes: OpcoesLembretes): Promise<ResultadoLembretes> {
  const { db, email, frontUrl, log } = opcoes;
  const diasAntes = opcoes.diasAntes ?? [7, 3, 1, 0];
  const resultado: ResultadoLembretes = { treinadores: 0, atletas: 0, ignorados: 0 };

  const c = await db.query<{ id: string; nome: string; prazo: string }>(
    `select id, nome, prazo::text as prazo from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  const ciclo = c.rows[0];
  if (!ciclo) return resultado;

  const hoje = diaEmBrasilia(opcoes.agora);
  const restam = diasParaPrazo(ciclo.prazo, opcoes.agora);
  if (restam >= 0 && !diasAntes.includes(restam)) return resultado;

  const url = frontUrl.replace(/\/+$/, "");
  const pendentes = await destinatarios(db, ciclo.id, opcoes.agora);
  const grupos = [
    { tipo: "treinador" as const, pendentes: pendentes.treinadores, montar: mensagemTreinador },
    { tipo: "atleta" as const, pendentes: pendentes.atletas, montar: mensagemAtleta },
  ];

  for (const g of grupos) {
    for (const p of g.pendentes) {
      const reservado = await db.query(
        `insert into lembretes_enviados (ciclo_id, usuario_id, tipo, enviado_em, dia)
         values ($1::uuid, $2::uuid, $3, $4, $5::date)
         on conflict (ciclo_id, usuario_id, tipo, dia) do nothing returning id`,
        [ciclo.id, p.usuarioId, g.tipo, opcoes.agora, hoje],
      );
      if (reservado.rows.length === 0) {
        resultado.ignorados++;
        continue;
      }
      try {
        await email.enviar(g.montar(p.email, ciclo.nome, ciclo.prazo, restam, p.quantidade, url));
        if (g.tipo === "treinador") resultado.treinadores++;
        else resultado.atletas++;
      } catch {
        // Libera a reserva para a próxima execução do dia tentar de novo.
        await db.query(
          `delete from lembretes_enviados where ciclo_id = $1::uuid and usuario_id = $2::uuid and tipo = $3 and dia = $4::date`,
          [ciclo.id, p.usuarioId, g.tipo, hoje],
        );
        resultado.ignorados++;
        log?.info(
          { evento: "lembrete_falhou", tipo: g.tipo, usuarioId: p.usuarioId },
          "falha ao enviar lembrete",
        );
      }
    }
  }
  log?.info(
    { evento: "lembretes_concluidos", cicloId: ciclo.id, diasParaOPrazo: restam, ...resultado },
    "lembretes concluídos",
  );
  return resultado;
}

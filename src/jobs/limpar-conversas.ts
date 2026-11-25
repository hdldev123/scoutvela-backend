import type { Db } from "../db/db.js";
import { DIAS_RETENCAO_CONVERSAS, apagarConversas } from "../repositories/conversas.js";

export interface OpcoesLimparConversas {
  db: Db;
  agora: Date;
  /** Só contagens; nunca id de pessoa nem conteúdo de mensagem. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export interface ResultadoLimparConversas {
  conversas: number;
  mensagens: number;
}

/**
 * Retenção do chat (D16, decisão I). Apaga conversas, mensagens, leituras e acessos de supervisão quando,
 * há mais de 90 dias:
 *  (a) o atleta da conversa foi desativado (`inativado_em`) ou anonimizado;
 *  (b) a conta do treinador de uma conversa com a gestão foi desativada;
 *  (c) o atleta trocou de treinador e a conversa do par antigo deixou de valer (`encerrada_em`).
 * O que ainda está dentro do prazo fica.
 */
export async function limparConversasAntigas(
  o: OpcoesLimparConversas,
): Promise<ResultadoLimparConversas> {
  const limite = new Date(o.agora.getTime() - DIAS_RETENCAO_CONVERSAS * 86_400_000);
  const resultado = await o.db.transacao(async (tx) => {
    // Libera o DELETE nas tabelas de só inserção, só dentro desta transação.
    await tx.query(`select set_config('scoutvela.limpando_conversas', 'on', true)`);
    const r = await tx.query<{ id: string }>(
      `select c.id::text as id from conversas c
        where (c.atleta_id is not null and exists (
                 select 1 from atletas a
                  where a.id = c.atleta_id
                    and ((not a.ativo and a.inativado_em < $1::timestamptz)
                         or a.anonimizado_em < $1::timestamptz)))
           or (c.tipo = 'gestao_treinador' and exists (
                 select 1 from usuarios t
                  where t.id = c.treinador_id and not t.ativo and t.inativado_em < $1::timestamptz))
           or (c.tipo = 'treinador_atleta' and c.encerrada_em < $1::timestamptz)`,
      [limite],
    );
    const ids = r.rows.map((x) => x.id);
    const { mensagens } = await apagarConversas(tx, ids);
    return { conversas: ids.length, mensagens };
  });
  o.log?.info({ ...resultado }, "limpeza de conversas finalizada");
  return resultado;
}

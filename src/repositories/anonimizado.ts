import type { FastifyInstance, preHandlerAsyncHookHandler } from "fastify";
import type { Db } from "../db/db.js";
import { conflito, naoEncontrado } from "../erros.js";

export const MSG_ATLETA_ANONIMIZADO =
  "Este atleta foi anonimizado a pedido do titular (LGPD): o registro está fechado e não aceita alterações.";

export const erroAtletaAnonimizado = () => conflito(MSG_ATLETA_ANONIMIZADO);

/**
 * Dentro da transação da escrita: trava a linha do atleta (`for share`, que espera uma anonimização
 * em andamento terminar) e recusa com 409 se ele já foi anonimizado. Atleta inexistente passa:
 * quem chama já tratou o 404.
 */
export async function travarAtletaEditavel(
  tx: Db,
  atletaId: string,
  opcoes: { exigirAtivo?: boolean } = {},
): Promise<void> {
  const r = await tx.query<{ ativo: boolean; anonimizado_em: Date | null }>(
    `select ativo, anonimizado_em from atletas where id = $1::uuid for share`,
    [atletaId],
  );
  if (r.rows[0]?.anonimizado_em) throw erroAtletaAnonimizado();
  if (opcoes.exigirAtivo && r.rows[0] && !r.rows[0].ativo) {
    throw naoEncontrado("Atleta não encontrado.");
  }
}

/**
 * preHandler das rotas `/atletas/:id/...` que gravam: atleta anonimizado responde 409 (e não o 404
 * de atleta inativo). Só quem enxergaria o atleta antes da anonimização recebe o 409; os demais
 * seguem para o 404 de sempre. Use depois de `app.autenticar`.
 */
export function recusarAtletaAnonimizado(app: FastifyInstance): preHandlerAsyncHookHandler {
  return async (req) => {
    const { id } = req.params as { id?: string };
    if (!id || !/^[0-9a-f-]{36}$/i.test(id)) return;
    const r = await app.db.query<{ anonimizado_em: Date | null; treinador_id: string | null }>(
      `select anonimizado_em, treinador_id::text as treinador_id from atletas where id = $1::uuid`,
      [id],
    );
    const a = r.rows[0];
    if (!a?.anonimizado_em) return;
    const u = req.usuario;
    if (u.papel === "gestor" || a.treinador_id === u.id || u.atletaId === id) {
      throw erroAtletaAnonimizado();
    }
  };
}

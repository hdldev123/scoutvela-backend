import type { Db } from "../db/db.js";
import type { Papel } from "../domain/tipos.js";

export interface UsuarioRegistro {
  id: string;
  authUserId: string;
  nome: string;
  email: string;
  papel: Papel;
  atletaId: string | null;
  ativo: boolean;
}

export async function buscarUsuarioPorAuthId(db: Db, authUserId: string): Promise<UsuarioRegistro | null> {
  const r = await db.query<{
    id: string;
    auth_user_id: string;
    nome: string;
    email: string;
    papel: Papel;
    atleta_id: string | null;
    ativo: boolean;
  }>(
    `select id, auth_user_id, nome, email, papel, atleta_id, ativo
       from usuarios where auth_user_id = $1`,
    [authUserId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    id: l.id,
    authUserId: l.auth_user_id,
    nome: l.nome,
    email: l.email,
    papel: l.papel,
    atletaId: l.atleta_id,
    ativo: l.ativo,
  };
}

export async function buscarNomeDoAtleta(db: Db, atletaId: string): Promise<{ id: string; nome: string } | null> {
  const r = await db.query<{ id: string; nome: string }>(`select id, nome from atletas where id = $1`, [atletaId]);
  return r.rows[0] ?? null;
}

/**
 * Grava o auth_user_id no usuário ativo ainda sem login cujo e-mail é o do token.
 * Devolve o usuário vinculado ou null (sem cadastro, ou já vinculado a outro login).
 */
export async function vincularContaPorEmail(db: Db, authUserId: string, email: string): Promise<UsuarioRegistro | null> {
  try {
    await db.transacao(async (tx) => {
      const r = await tx.query<{ id: string }>(
        `update usuarios set auth_user_id = $1
          where lower(email) = lower($2) and auth_user_id is null and ativo
        returning id`,
        [authUserId, email],
      );
      const id = r.rows[0]?.id;
      if (!id) return;
      await tx.query(
        `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
         values ($1, 'vincular_conta', 'usuarios', $2, '{}'::jsonb)`,
        [id, id],
      );
    });
  } catch (e) {
    if ((e as { code?: string }).code === "23505") return null; // este login já está em outro cadastro
    throw e;
  }
  return buscarUsuarioPorAuthId(db, authUserId);
}

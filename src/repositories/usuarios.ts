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

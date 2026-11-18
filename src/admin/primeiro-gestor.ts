import type { Db } from "../db/db.js";
import type { AdminAuth } from "../integracoes/supabase-admin.js";

/** O ambiente já tem gestor ativo: os demais entram pelo convite em Contas. */
export class GestorJaExiste extends Error {
  constructor() {
    super(
      "Este ambiente já tem um gestor ativo. Os próximos usuários entram pelo convite em Contas.",
    );
    this.name = "GestorJaExiste";
  }
}

export class DadosInvalidos extends Error {
  constructor(mensagem: string) {
    super(mensagem);
    this.name = "DadosInvalidos";
  }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Cria o primeiro gestor de um ambiente novo (produção não tem seed): grava a conta e envia
 * o convite do Supabase Auth. Ninguém conhece a senha; o gestor a define pelo link do convite.
 * Recusa se já houver gestor ativo. Se o convite falhar, nada fica gravado no banco.
 */
export async function criarPrimeiroGestor(
  db: Db,
  adminAuth: AdminAuth,
  dados: { email: string; nome: string; redirectTo: string },
): Promise<{ usuarioId: string }> {
  const email = dados.email.trim().toLowerCase();
  const nome = dados.nome.trim();
  if (!EMAIL.test(email)) throw new DadosInvalidos("Informe um e-mail válido em --email.");
  if (nome.length < 2 || nome.length > 120)
    throw new DadosInvalidos("Informe o nome em --nome (2 a 120 caracteres).");

  return db.transacao(async (tx) => {
    const gestor = await tx.query(
      "select 1 from usuarios where papel = 'gestor' and ativo limit 1",
    );
    if (gestor.rows.length > 0) throw new GestorJaExiste();
    const emUso = await tx.query("select 1 from usuarios where email = $1", [email]);
    if (emUso.rows.length > 0) throw new DadosInvalidos("Já existe um usuário com este e-mail.");

    const { rows } = await tx.query<{ id: string }>(
      "insert into usuarios (email, nome, papel) values ($1, $2, 'gestor') returning id",
      [email, nome],
    );
    const usuarioId = rows[0]!.id;
    // Convite dentro da transação: se o Auth recusar, o insert acima é desfeito.
    const { authUserId } = await adminAuth.convidar(email, dados.redirectTo);
    await tx.query("update usuarios set auth_user_id = $2, convidado_em = now() where id = $1", [
      usuarioId,
      authUserId,
    ]);
    await tx.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       values (null, 'criar_primeiro_gestor', 'usuarios', $1, '{}'::jsonb)`,
      [usuarioId],
    );
    return { usuarioId };
  });
}

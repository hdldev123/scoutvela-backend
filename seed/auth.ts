import type { Db } from "../src/db/db.js";
import { CONTAS_DEMO, type ContaDemo } from "./contas-demo.js";

export interface OpcoesVinculo {
  db: Db;
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Injetável para teste. */
  fetch?: typeof fetch;
  contas?: ContaDemo[];
}

interface UsuarioAuth {
  id: string;
  email?: string;
}

/**
 * Cria (ou atualiza a senha de) cada conta de teste no Supabase Auth e grava
 * o auth_user_id em usuarios. Não loga nem inclui senha ou chave em mensagens.
 * Devolve os e-mails vinculados.
 */
export async function vincularContasDemo(opcoes: OpcoesVinculo): Promise<string[]> {
  if (process.env.APP_ENV === "producao") {
    throw new Error("Contas de teste são proibidas em produção (APP_ENV=producao).");
  }
  const f = opcoes.fetch ?? fetch;
  const base = `${opcoes.supabaseUrl.replace(/\/+$/, "")}/auth/v1/admin/users`;
  const cabecalhos = {
    apikey: opcoes.serviceRoleKey,
    Authorization: `Bearer ${opcoes.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  async function buscarPorEmail(email: string): Promise<UsuarioAuth | undefined> {
    const r = await f(`${base}?page=1&per_page=1000`, { headers: cabecalhos });
    if (!r.ok) throw new Error(`Supabase Auth: falha ao listar usuários (HTTP ${r.status})`);
    const corpo = (await r.json()) as { users?: UsuarioAuth[] };
    return corpo.users?.find((u) => u.email?.toLowerCase() === email);
  }

  const vinculadas: string[] = [];
  for (const conta of opcoes.contas ?? CONTAS_DEMO) {
    const email = conta.email.toLowerCase();
    let authId: string | undefined;

    const criar = await f(base, {
      method: "POST",
      headers: cabecalhos,
      body: JSON.stringify({ email, password: conta.senha, email_confirm: true }),
    });
    if (criar.ok) {
      authId = ((await criar.json()) as UsuarioAuth).id;
    } else {
      const texto = await criar.text();
      const jaExiste =
        criar.status === 409 ||
        criar.status === 422 ||
        /already.*(registered|exists)|email_exists/i.test(texto);
      if (!jaExiste)
        throw new Error(`Supabase Auth: falha ao criar ${email} (HTTP ${criar.status})`);
      const existente = await buscarPorEmail(email);
      if (!existente)
        throw new Error(`Supabase Auth: ${email} já existe mas não foi encontrado na listagem`);
      const atualizar = await f(`${base}/${existente.id}`, {
        method: "PUT",
        headers: cabecalhos,
        body: JSON.stringify({ password: conta.senha, email_confirm: true }),
      });
      if (!atualizar.ok)
        throw new Error(`Supabase Auth: falha ao atualizar ${email} (HTTP ${atualizar.status})`);
      authId = existente.id;
    }

    const r = await opcoes.db.query(
      "update usuarios set auth_user_id = $1 where email = $2 returning id",
      [authId, email],
    );
    if (r.rows.length === 0)
      throw new Error(`Usuário ${email} não existe em usuarios; rode o seed antes`);
    vinculadas.push(email);
  }
  return vinculadas;
}

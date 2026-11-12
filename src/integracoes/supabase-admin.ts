/**
 * Cliente da API admin do Supabase Auth. Usa a chave de servidor (service role),
 * que só existe no back (Render). Nunca loga e-mail, token nem chave.
 */

/** O e-mail já tem conta no Supabase Auth. */
export class ContaJaExiste extends Error {
  constructor() {
    super("Já existe uma conta com este e-mail.");
    this.name = "ContaJaExiste";
  }
}

export interface AdminAuth {
  /** Cria a conta sem senha e envia o e-mail de convite. `redirectTo` é a tela de definir senha. */
  convidar(email: string, redirectTo: string): Promise<{ authUserId: string }>;
  /** Apaga a conta (e as sessões) no Supabase Auth. Conta inexistente (404) conta como sucesso. */
  removerConta(authUserId: string): Promise<void>;
}

export function criarAdminAuth(opcoes: {
  supabaseUrl: string;
  serviceRoleKey: string;
  /** Injetável para teste. */
  fetch?: typeof fetch;
}): AdminAuth {
  const base = opcoes.supabaseUrl.replace(/\/+$/, "");
  const f = opcoes.fetch ?? fetch;
  return {
    async convidar(email, redirectTo) {
      const url = `${base}/auth/v1/invite?redirect_to=${encodeURIComponent(redirectTo)}`;
      const r = await f(url, {
        method: "POST",
        headers: {
          apikey: opcoes.serviceRoleKey,
          Authorization: `Bearer ${opcoes.serviceRoleKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!r.ok) {
        const texto = await r.text().catch(() => "");
        if (
          r.status === 409 ||
          r.status === 422 ||
          /email_exists|already.*(registered|exists)/i.test(texto)
        ) {
          throw new ContaJaExiste();
        }
        throw new Error(`Supabase Auth: falha ao convidar (HTTP ${r.status})`);
      }
      const corpo = (await r.json()) as { id?: unknown };
      if (typeof corpo.id !== "string" || corpo.id === "")
        throw new Error("Supabase Auth: resposta do convite sem id");
      return { authUserId: corpo.id };
    },
    async removerConta(authUserId) {
      const r = await f(`${base}/auth/v1/admin/users/${encodeURIComponent(authUserId)}`, {
        method: "DELETE",
        headers: {
          apikey: opcoes.serviceRoleKey,
          Authorization: `Bearer ${opcoes.serviceRoleKey}`,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (r.status === 404) return;
      if (!r.ok) throw new Error(`Supabase Auth: falha ao remover conta (HTTP ${r.status})`);
    },
  };
}

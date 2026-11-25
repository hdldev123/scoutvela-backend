import type { Db } from "../db/db.js";
import type { ProvedorEmail } from "../email/index.js";

export interface OpcoesAvisoCicloFechado {
  db: Db;
  email: ProvedorEmail;
  frontUrl: string;
  cicloNome: string;
  /** Só evento e domínio; nunca endereço, nome ou texto. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Avisa por e-mail as contas ativas de gestor e IBVAR que o ciclo foi fechado (D4).
 * Chamar depois do commit do fechamento. O texto não traz score nem nome de atleta: só o ciclo e o link.
 * Falha de envio não propaga: vira evento no log, com o domínio do destinatário.
 */
export async function avisarCicloFechado(opcoes: OpcoesAvisoCicloFechado): Promise<number> {
  const { db, email, log, cicloNome } = opcoes;
  const url = `${opcoes.frontUrl.replace(/\/+$/, "")}/investimento`;
  let enviados = 0;
  try {
    const r = await db.query<{ email: string }>(
      `select email from usuarios where ativo and papel in ('gestor', 'ibvar') order by email`,
    );
    for (const { email: para } of r.rows) {
      try {
        await email.enviar({
          para,
          assunto: `Scout Vela: ciclo ${cicloNome} fechado`,
          texto:
            `Olá,\n\nO ciclo ${cicloNome} foi fechado; os números do ciclo estão disponíveis no painel de investimento.\n\n` +
            `Acesse: ${url}\n\nScout Vela`,
        });
        enviados++;
      } catch {
        log?.info(
          { evento: "aviso_ciclo_fechado_falhou", dominio: para.split("@")[1] ?? null },
          "falha ao enviar aviso de ciclo fechado",
        );
      }
    }
  } catch {
    log?.info(
      { evento: "aviso_ciclo_fechado_falhou", dominio: null },
      "falha ao listar destinatários",
    );
  }
  return enviados;
}

import type { Db } from "../db/db.js";
import { DIAS_RETENCAO_AVISOS } from "../repositories/avisos.js";

export interface OpcoesLimparAvisos {
  db: Db;
  agora: Date;
  /** Só contagens; nunca id de pessoa nem conteúdo de aviso. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export interface ResultadoLimparAvisos {
  removidos: number;
}

/**
 * Apaga os avisos lidos há mais de 180 dias (D8). Aviso não lido fica, por mais antigo que seja:
 * quem não leu ainda pode precisar dele.
 */
export async function limparAvisosAntigos(o: OpcoesLimparAvisos): Promise<ResultadoLimparAvisos> {
  const limite = new Date(o.agora.getTime() - DIAS_RETENCAO_AVISOS * 86_400_000);
  const r = await o.db.query(
    `delete from avisos where lido_em is not null and lido_em < $1 returning id`,
    [limite],
  );
  const resultado = { removidos: r.rows.length };
  o.log?.info({ ...resultado }, "limpeza de avisos finalizada");
  return resultado;
}

import type { Db } from "../db/db.js";
import { removerAnexoNaoVinculado } from "../servicos/anexos.js";
import type { ArmazenamentoEvidencias } from "../storage/index.js";

/** Anexo enviado e nunca ligado a uma avaliação some depois deste prazo. */
export const HORAS_ANEXO_NAO_VINCULADO = 24;

export interface OpcoesLimparAnexos {
  db: Db;
  armazenamento: ArmazenamentoEvidencias;
  agora: Date;
  /** Só contagens; nunca caminho, nome ou id de pessoa. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export interface ResultadoLimparAnexos {
  removidos: number;
  /** Falhas no Storage (o anexo segue como estava e entra na próxima rodada). */
  falhas: number;
}

/**
 * Remove os anexos não vinculados a nenhuma avaliação e enviados há mais de 24 h. Fica de fora o que o
 * atleta enviou e o que não é evidência de nota (súmula, balança): esses esperam as telas da D9 e da
 * D10 e saem pela remoção do próprio atleta.
 */
export async function limparAnexosNaoVinculados(
  o: OpcoesLimparAnexos,
): Promise<ResultadoLimparAnexos> {
  const limite = new Date(o.agora.getTime() - HORAS_ANEXO_NAO_VINCULADO * 3_600_000);
  const candidatos = await o.db.query<{ id: string }>(
    `select a.id from evidencias_anexos a join usuarios u on u.id = a.enviado_por
      where a.removido_em is null and a.enviado_em < $1
        and a.categoria = 'evidencia' and u.papel <> 'atleta'
        and not exists (select 1 from avaliacoes v where v.anexo_id = a.id)
      order by a.enviado_em, a.id`,
    [limite],
  );
  const resultado: ResultadoLimparAnexos = { removidos: 0, falhas: 0 };
  for (const { id } of candidatos.rows) {
    try {
      const r = await removerAnexoNaoVinculado(
        { db: o.db, armazenamento: o.armazenamento, agora: () => o.agora },
        id,
        null,
      );
      if (r === "removido") resultado.removidos++;
    } catch {
      resultado.falhas++;
    }
  }
  o.log?.info({ ...resultado }, "limpeza de anexos finalizada");
  return resultado;
}

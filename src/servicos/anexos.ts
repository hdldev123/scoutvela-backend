import type { Db } from "../db/db.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import { ErroArmazenamento, type ArmazenamentoEvidencias } from "../storage/index.js";

export const CATEGORIAS_ANEXO = ["evidencia", "sumula", "balanca"] as const;
export type CategoriaAnexo = (typeof CATEGORIAS_ANEXO)[number];

/** Soma dos bytes dos anexos do atleta que ainda não foram removidos. */
export async function bytesUsadosPeloAtleta(db: Db, atletaId: string): Promise<number> {
  const r = await db.query<{ total: string }>(
    `select coalesce(sum(tamanho_bytes), 0)::text as total
       from evidencias_anexos where atleta_id = $1::uuid and removido_em is null`,
    [atletaId],
  );
  return Number(r.rows[0]?.total ?? 0);
}

export type ResultadoRemocaoAnexo = "removido" | "vinculado" | "ja_removido" | "inexistente";

export interface DepsRemocaoAnexo {
  db: Db;
  armazenamento: ArmazenamentoEvidencias;
  agora: () => Date;
}

/**
 * Remove um anexo AINDA NÃO ligado a nenhuma avaliação.
 *
 * Saída escolhida para a regra de só-inserção de `evidencias_anexos` (opção "a"): o registro fica e
 * é marcado como removido (`removido_em` + `nome_arquivo = 'removido'`), a mesma exceção controlada
 * da anonimização (migration 0010). DELETE continua proibido no banco.
 *
 * Ordem: trava o anexo (`for update`, o que também faz um lançamento concorrente esperar), confere
 * que não há avaliação ligada, remove o arquivo do Storage e só então marca o registro. Se o Storage
 * falhar, o erro sobe e a transação desfaz tudo (nada muda). A auditoria `remover_anexo` leva só ids.
 * `usuarioId` nulo = limpeza automática.
 */
export async function removerAnexoNaoVinculado(
  deps: DepsRemocaoAnexo,
  anexoId: string,
  usuarioId: string | null,
): Promise<ResultadoRemocaoAnexo> {
  const em = deps.agora();
  return deps.db.transacao(async (tx) => {
    const r = await tx.query<{
      atleta_id: string;
      caminho: string;
      removido_em: Date | null;
    }>(
      `select atleta_id, caminho, removido_em from evidencias_anexos where id = $1::uuid for update`,
      [anexoId],
    );
    const anexo = r.rows[0];
    if (!anexo) return "inexistente";
    if (anexo.removido_em) return "ja_removido";

    await travarAtletaEditavel(tx, anexo.atleta_id);
    const ligado = await tx.query(`select 1 from avaliacoes where anexo_id = $1::uuid limit 1`, [
      anexoId,
    ]);
    if (ligado.rows.length > 0) return "vinculado";

    // Storage primeiro: se falhar, a exceção desfaz a transação e o registro continua como estava.
    try {
      await deps.armazenamento.remover(anexo.caminho);
    } catch {
      throw new ErroArmazenamento("Falha ao remover o arquivo do Storage.");
    }

    await tx.query(
      `update evidencias_anexos set removido_em = greatest($2::timestamptz, enviado_em), nome_arquivo = 'removido'
        where id = $1::uuid`,
      [anexoId, em],
    );
    await tx.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
       values ($1, 'remover_anexo', 'atleta', $2, $3::jsonb, $4)`,
      [
        usuarioId,
        anexo.atleta_id,
        JSON.stringify({ anexoId, origem: usuarioId ? "usuario" : "limpeza" }),
        em,
      ],
    );
    return "removido";
  });
}

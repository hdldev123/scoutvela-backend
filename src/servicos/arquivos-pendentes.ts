import type { Db } from "../db/db.js";
import type { ArmazenamentoEvidencias } from "../storage/index.js";

interface Log {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

const nomeDoErro = (e: unknown): string => {
  const f = e as { code?: unknown; name?: unknown };
  return typeof f?.code === "string" ? f.code : typeof f?.name === "string" ? f.name : "Error";
};

/**
 * Tenta apagar o arquivo do Storage. Se não conseguir, guarda o caminho em `arquivos_pendentes`
 * (só caminho e motivo) para a anonimização do atleta limpar depois. Nunca lança: o log leva só o
 * motivo e o tipo do erro, sem caminho nem dado da pessoa.
 */
export async function removerOuPendenciar(
  deps: { db: Db; armazenamento: ArmazenamentoEvidencias; log: Log; agora: () => Date },
  caminho: string,
  motivo: "troca_foto" | "rollback_foto" | "rollback_evidencia",
): Promise<boolean> {
  try {
    await deps.armazenamento.remover(caminho);
    return true;
  } catch (e) {
    deps.log.warn(
      { evento: "arquivo_pendente", motivo, erro: nomeDoErro(e) },
      "arquivo não saiu do Storage",
    );
    try {
      await deps.db.query(
        `insert into arquivos_pendentes (caminho, motivo, criado_em) values ($1, $2, $3)
         on conflict (caminho) do nothing`,
        [caminho, motivo, deps.agora()],
      );
    } catch (e2) {
      deps.log.warn(
        { evento: "arquivo_pendente_nao_registrado", motivo, erro: nomeDoErro(e2) },
        "falha ao registrar arquivo pendente",
      );
    }
    return false;
  }
}

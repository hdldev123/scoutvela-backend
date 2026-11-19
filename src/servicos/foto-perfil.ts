import type { ArmazenamentoEvidencias } from "../storage/index.js";

interface Log {
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

const nomeDoErro = (e: unknown): string => {
  const f = e as { code?: unknown; name?: unknown };
  return typeof f?.code === "string" ? f.code : typeof f?.name === "string" ? f.name : "Error";
};

/** Link assinado curto; falha do Storage vira null para não derrubar a tela. */
export async function linkDaFoto(
  armazenamento: ArmazenamentoEvidencias,
  caminho: string | null,
  log: Log,
): Promise<string | null> {
  if (!caminho) return null;
  const tipoMime = caminho.endsWith(".png") ? "image/png" : "image/jpeg";
  try {
    return (await armazenamento.linkTemporario(caminho, tipoMime, "foto")).url;
  } catch (e) {
    log.warn({ evento: "foto_link_falhou", erro: nomeDoErro(e) }, "falha ao gerar link da foto");
    return null;
  }
}

export async function removerFotoSemFalhar(
  armazenamento: ArmazenamentoEvidencias,
  caminho: string,
  log: Log,
): Promise<boolean> {
  try {
    await armazenamento.remover(caminho);
    return true;
  } catch (e) {
    log.warn({ evento: "foto_orfa", erro: nomeDoErro(e) }, "falha ao remover foto do Storage");
    return false;
  }
}

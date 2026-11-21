import type { Db } from "../db/db.js";
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

export async function caminhoDaFotoDoUsuario(db: Db, usuarioId: string): Promise<string | null> {
  const r = await db.query<{ foto_caminho: string | null }>(
    `select foto_caminho from usuarios where id = $1::uuid`,
    [usuarioId],
  );
  return r.rows[0]?.foto_caminho ?? null;
}

/** Foto da conta ativa do atleta (a conta anonimizada fica inativa e não expõe a foto). */
export async function caminhoDaFotoDoAtleta(db: Db, atletaId: string): Promise<string | null> {
  const r = await db.query<{ foto_caminho: string }>(
    `select foto_caminho from usuarios
      where papel = 'atleta' and atleta_id = $1::uuid and ativo and foto_caminho is not null
      order by criado_em desc limit 1`,
    [atletaId],
  );
  return r.rows[0]?.foto_caminho ?? null;
}

/** Links das fotos de vários atletas (só os que têm foto), com uma consulta ao banco. */
export async function linksDasFotosDosAtletas(
  db: Db,
  armazenamento: ArmazenamentoEvidencias,
  atletaIds: string[],
  log: Log,
): Promise<Map<string, string | null>> {
  if (atletaIds.length === 0) return new Map();
  const r = await db.query<{ atleta_id: string; foto_caminho: string }>(
    `select distinct on (atleta_id) atleta_id::text as atleta_id, foto_caminho from usuarios
      where papel = 'atleta' and atleta_id = any($1::uuid[]) and ativo and foto_caminho is not null
      order by atleta_id, criado_em desc`,
    [atletaIds],
  );
  const resultado = new Map<string, string | null>();
  if (r.rows.length === 0) return resultado;
  let links = new Map<string, { url: string }>();
  try {
    links = await armazenamento.linksTemporarios(
      r.rows.map((l) => ({
        caminho: l.foto_caminho,
        tipoMime: l.foto_caminho.endsWith(".png") ? "image/png" : "image/jpeg",
      })),
    );
  } catch (e) {
    log.warn({ evento: "foto_link_falhou", erro: nomeDoErro(e) }, "falha ao gerar link da foto");
  }
  for (const l of r.rows) resultado.set(l.atleta_id, links.get(l.foto_caminho)?.url ?? null);
  return resultado;
}

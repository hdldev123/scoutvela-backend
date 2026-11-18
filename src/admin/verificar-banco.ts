import type { Db } from "../db/db.js";

export interface Verificacao {
  nome: string;
  ok: boolean;
  detalhe: string;
}

const BUCKET = {
  id: "evidencias",
  limite: 5_242_880,
  tipos: ["application/pdf", "image/jpeg", "image/png"],
};

/** Tabelas e views do schema public (o que a API REST do Supabase expõe). */
export async function objetosPublicos(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r', 'v') order by c.relname`,
  );
  return rows.map((r) => r.relname);
}

/**
 * Confere o banco de um ambiente: migrations aplicadas, RLS em toda tabela e o bucket
 * privado das evidências (criado pela 0007; só existe no Supabase).
 */
export async function verificarBanco(db: Db, migrations: string[]): Promise<Verificacao[]> {
  const resultado: Verificacao[] = [];

  const { rows: aplicadas } = await db.query<{ nome: string }>(
    "select nome from schema_migrations order by nome",
  );
  const feitas = new Set(aplicadas.map((r) => r.nome));
  const pendentes = migrations.filter((m) => !feitas.has(m));
  resultado.push({
    nome: "migrations",
    ok: pendentes.length === 0,
    detalhe: pendentes.length
      ? `pendentes: ${pendentes.join(", ")}`
      : `${feitas.size} aplicadas (última: ${aplicadas.at(-1)?.nome ?? "nenhuma"})`,
  });

  const { rows: semRls } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity order by c.relname`,
  );
  resultado.push({
    nome: "rls",
    ok: semRls.length === 0,
    detalhe: semRls.length
      ? `sem RLS: ${semRls.map((r) => r.relname).join(", ")}`
      : "todas as tabelas do schema public com RLS",
  });

  const { rows: temStorage } = await db.query(
    "select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets'",
  );
  if (temStorage.length === 0) {
    resultado.push({
      nome: "bucket",
      ok: false,
      detalhe: "schema storage ausente (não é Supabase)",
    });
    return resultado;
  }
  const { rows: buckets } = await db.query<{
    public: boolean;
    file_size_limit: string | number | null;
    allowed_mime_types: string[] | null;
  }>("select public, file_size_limit, allowed_mime_types from storage.buckets where id = $1", [
    BUCKET.id,
  ]);
  const b = buckets[0];
  const tipos = [...(b?.allowed_mime_types ?? [])].sort();
  const problemas = !b
    ? ["não existe"]
    : [
        ...(b.public ? ["está público"] : []),
        ...(Number(b.file_size_limit) === BUCKET.limite ? [] : [`limite ${b.file_size_limit}`]),
        ...(tipos.join() === BUCKET.tipos.join() ? [] : [`tipos ${tipos.join(", ") || "livres"}`]),
      ];
  resultado.push({
    nome: "bucket",
    ok: problemas.length === 0,
    detalhe: problemas.length
      ? `${BUCKET.id}: ${problemas.join("; ")}`
      : `${BUCKET.id} privado, 5 MB, PDF/JPG/PNG`,
  });
  return resultado;
}

/**
 * Confere que a chave pública (anon ou publishable) não lê nada pela API REST do Supabase.
 * Passa com 200 e lista vazia (RLS sem política) ou com recusa (401/403/404).
 */
export async function verificarChavePublica(opcoes: {
  supabaseUrl: string;
  chavePublica: string;
  objetos: string[];
  fetch?: typeof fetch;
}): Promise<Verificacao[]> {
  const base = opcoes.supabaseUrl.replace(/\/+$/, "");
  const f = opcoes.fetch ?? fetch;
  const resultado: Verificacao[] = [];
  for (const objeto of opcoes.objetos) {
    const r = await f(`${base}/rest/v1/${encodeURIComponent(objeto)}?select=*&limit=1`, {
      headers: { apikey: opcoes.chavePublica },
      signal: AbortSignal.timeout(10_000),
    });
    let ok: boolean;
    let detalhe: string;
    if ([401, 403, 404].includes(r.status)) {
      ok = true;
      detalhe = `recusado (HTTP ${r.status})`;
    } else if (r.status === 200) {
      const corpo: unknown = await r.json().catch(() => null);
      ok = Array.isArray(corpo) && corpo.length === 0;
      detalhe = ok ? "vazio" : "A CHAVE PÚBLICA LEU DADOS";
    } else {
      ok = false;
      detalhe = `resposta inesperada (HTTP ${r.status})`;
    }
    resultado.push({ nome: `anon:${objeto}`, ok, detalhe });
  }
  return resultado;
}

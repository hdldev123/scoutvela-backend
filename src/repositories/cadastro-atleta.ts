import type { Db } from "../db/db.js";

/** Dados do VelaID oferecidos ao atleta, para ele confirmar ou corrigir. */
export interface SugestaoCadastro {
  nome: string;
  genero: "F" | "M";
  /** AAAA-MM-DD. */
  dataNascimento: string;
}

export interface CadastroPendente {
  wsId: string;
  velaid: string | null;
  /** Nula se o atleta não tem VelaID ou o código não está no VelaID importado. */
  sugestao: SugestaoCadastro | null;
}

/**
 * Cadastro que o atleta ainda precisa completar (nulo se já completou, foi recusado ou não existe).
 * A sugestão vem de `velaid_registros`, ligada pelo código VelaID guardado no cadastro.
 */
export async function buscarCadastroPendente(
  db: Db,
  atletaId: string,
): Promise<CadastroPendente | null> {
  const r = await db.query<{
    ws_id: string;
    velaid_codigo: string | null;
    nome: string | null;
    genero: "F" | "M" | null;
    data_nascimento: string | null;
  }>(
    `select a.ws_id, a.velaid_codigo, v.nome, v.genero, v.data_nascimento::text as data_nascimento
       from atletas a
       left join velaid_registros v on v.codigo = a.velaid_codigo
      where a.id = $1::uuid and a.cadastro_completo_em is null and a.cadastro_recusado_em is null`,
    [atletaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    wsId: l.ws_id,
    velaid: l.velaid_codigo,
    sugestao:
      l.nome && l.genero && l.data_nascimento
        ? { nome: l.nome, genero: l.genero, dataNascimento: l.data_nascimento }
        : null,
  };
}

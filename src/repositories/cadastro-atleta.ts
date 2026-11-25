import type { Db } from "../db/db.js";

/**
 * Dados oferecidos ao atleta, para ele confirmar ou corrigir. Do VelaID vêm os três campos; da World
 * Sailing, o que o perfil público trouxe (o nome sempre; gênero e nascimento podem faltar).
 */
export interface SugestaoCadastro {
  nome: string;
  genero: "F" | "M" | null;
  /** AAAA-MM-DD. */
  dataNascimento: string | null;
}

export interface CadastroPendente {
  wsId: string;
  velaid: string | null;
  /** Nula se não há sugestão: sem VelaID no cadastro, código fora do VelaID importado e sem perfil na World Sailing. */
  sugestao: SugestaoCadastro | null;
  /** De onde veio a sugestão: o VelaID vale antes da World Sailing. Nula sem sugestão. */
  origemSugestao: "velaid" | "world_sailing" | null;
}

/**
 * Cadastro que o atleta ainda precisa completar (nulo se já completou, foi recusado ou não existe).
 * A sugestão vem de `velaid_registros` (ligada pelo código VelaID do cadastro) e, se não houver, do perfil
 * importado da World Sailing (`world_sailing_perfis`).
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
    ws_nome: string | null;
    ws_genero: "F" | "M" | null;
    ws_data_nascimento: string | null;
  }>(
    `select a.ws_id, a.velaid_codigo, v.nome, v.genero, v.data_nascimento::text as data_nascimento,
            w.nome as ws_nome, w.genero as ws_genero, w.data_nascimento::text as ws_data_nascimento
       from atletas a
       left join velaid_registros v on v.codigo = a.velaid_codigo
       left join world_sailing_perfis w on w.atleta_id = a.id
      where a.id = $1::uuid and a.cadastro_completo_em is null and a.cadastro_recusado_em is null`,
    [atletaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  let sugestao: SugestaoCadastro | null = null;
  let origemSugestao: CadastroPendente["origemSugestao"] = null;
  if (l.nome && l.genero && l.data_nascimento) {
    sugestao = { nome: l.nome, genero: l.genero, dataNascimento: l.data_nascimento };
    origemSugestao = "velaid";
  } else if (l.ws_nome) {
    sugestao = { nome: l.ws_nome, genero: l.ws_genero, dataNascimento: l.ws_data_nascimento };
    origemSugestao = "world_sailing";
  }
  return { wsId: l.ws_id, velaid: l.velaid_codigo, sugestao, origemSugestao };
}

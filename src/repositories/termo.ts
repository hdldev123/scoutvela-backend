import type { Db } from "../db/db.js";

export interface TermoVigente {
  versao: string;
  titulo: string;
  texto: string;
  vigenteDesde: string;
}

/** Termo vigente: o de maior vigente_desde. */
export async function buscarTermoVigente(db: Db): Promise<TermoVigente> {
  const r = await db.query<{ versao: string; titulo: string; texto: string; vigente_desde: Date }>(
    "select versao, titulo, texto, vigente_desde from termos_consentimento order by vigente_desde desc, criado_em desc limit 1",
  );
  const l = r.rows[0];
  if (!l) throw new Error("Nenhum termo de consentimento cadastrado.");
  return {
    versao: l.versao,
    titulo: l.titulo,
    texto: l.texto,
    vigenteDesde: new Date(l.vigente_desde).toISOString(),
  };
}

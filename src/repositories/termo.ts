import type { Db } from "../db/db.js";

export interface TermoVigente {
  versao: string;
  titulo: string;
  texto: string;
  vigenteDesde: string;
}

/**
 * Definição única de "termo aceito" (migration 0011). Estes fragmentos SQL chamam as funções do banco,
 * que decidem pela regra TERMO_EXIGE_REACEITE. `atleta` é a expressão do id (ex.: "a.id") e `agora`
 * o placeholder do instante de referência (ex.: "$2"), sempre `app.agora()`.
 */
export const termoSql = {
  /** Versão vigente no instante. */
  vigenteVersao: (agora: string) => `termo_vigente_versao(${agora}::timestamptz)`,
  /** Aceitou a versão vigente. */
  aceitoVigente: (atleta: string, agora: string) =>
    `termo_aceito_vigente(${atleta}, ${agora}::timestamptz)`,
  /** Aceitou alguma versão. */
  aceitoAlguma: (atleta: string) => `termo_aceito_alguma(${atleta})`,
  /** Vale para o piloto (ranking, listas, lembretes): segue TERMO_EXIGE_REACEITE. */
  aceitoNoPiloto: (atleta: string, agora: string) =>
    `termo_aceito_no_piloto(${atleta}, ${agora}::timestamptz)`,
};

/** Termo vigente em `agora`: o de maior vigente_desde que já começou. */
export async function buscarTermoVigente(db: Db, agora: Date): Promise<TermoVigente> {
  const r = await db.query<{ versao: string; titulo: string; texto: string; vigente_desde: Date }>(
    `select versao, titulo, texto, vigente_desde from termos_consentimento
      where vigente_desde <= $1::timestamptz
      order by vigente_desde desc, criado_em desc limit 1`,
    [agora],
  );
  const l = r.rows[0];
  if (!l) throw new Error("Nenhum termo de consentimento vigente.");
  return {
    versao: l.versao,
    titulo: l.titulo,
    texto: l.texto,
    vigenteDesde: new Date(l.vigente_desde).toISOString(),
  };
}

export interface ItemTermo {
  versao: string;
  titulo: string;
  vigenteDesde: string;
  criadoEm: string;
  vigente: boolean;
  futura: boolean;
  aceites: number;
}

/** Versões do termo, da mais nova para a mais antiga, com a contagem de aceites (atletas distintos). */
export async function listarTermos(db: Db, agora: Date): Promise<ItemTermo[]> {
  const r = await db.query<{
    versao: string;
    titulo: string;
    vigente_desde: Date;
    criado_em: Date;
    vigente: boolean;
    aceites: string;
  }>(
    `select t.versao, t.titulo, t.vigente_desde, t.criado_em,
            (t.versao = ${termoSql.vigenteVersao("$1")}) as vigente,
            (select count(distinct c.atleta_id) from consentimentos c
              where c.tipo = 'termo_piloto' and c.concedido and c.versao_termo = t.versao)::text as aceites
       from termos_consentimento t
      order by t.vigente_desde desc, t.criado_em desc`,
    [agora],
  );
  return r.rows.map((l) => ({
    versao: l.versao,
    titulo: l.titulo,
    vigenteDesde: new Date(l.vigente_desde).toISOString(),
    criadoEm: new Date(l.criado_em).toISOString(),
    vigente: l.vigente,
    futura: new Date(l.vigente_desde).getTime() > agora.getTime(),
    aceites: Number(l.aceites),
  }));
}

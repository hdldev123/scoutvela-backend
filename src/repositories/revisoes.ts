import type { Db } from "../db/db.js";

/** Dados do pedido de revisão que definem quais lançamentos podem ser ligados a ele. */
export interface PedidoParaVinculo {
  atleta_id: string;
  pilar_id: string | null;
  indicador_id: string | null;
  criado_em: Date;
}

/**
 * Regra única de "lançamento elegível para o pedido". Usada na validação do PUT e na listagem
 * (GET /revisoes/:id/lancamentos), para as duas nunca divergirem. Espera os aliases
 * `a` (avaliacoes) e `i` (indicadores) e os parâmetros $1 a $4 de `paramsElegibilidade`.
 */
export const SQL_LANCAMENTO_ELEGIVEL = `a.atleta_id = $1::uuid
  and a.lancado_em > $4::timestamptz
  and case when $3::text is not null then a.indicador_id = $3::text
           when $2::text is not null then i.pilar_id = $2::text
           else true end`;

export const paramsElegibilidade = (p: PedidoParaVinculo): unknown[] => [
  p.atleta_id,
  p.pilar_id,
  p.indicador_id,
  p.criado_em,
];

/** O lançamento pode ser ligado ao pedido? */
export async function lancamentoEhElegivel(
  db: Db,
  pedido: PedidoParaVinculo,
  avaliacaoId: string,
): Promise<boolean> {
  const r = await db.query(
    `select 1 from avaliacoes a join indicadores i on i.id = a.indicador_id
      where ${SQL_LANCAMENTO_ELEGIVEL} and a.id = $5::bigint`,
    [...paramsElegibilidade(pedido), avaliacaoId],
  );
  return r.rows.length > 0;
}

export interface LancamentoElegivel {
  id: string;
  indicadorId: string;
  indicadorNome: string;
  valor: number;
  lancadoEm: string;
  origem: string;
  avaliador: { id: string; nome: string } | null;
}

interface LinhaLancamento {
  id: string;
  indicador_id: string;
  indicador_nome: string;
  valor: number;
  lancado_em: Date;
  origem: string;
  avaliador_id: string | null;
  avaliador_nome: string | null;
}

/** Lançamentos elegíveis para o pedido, do mais novo para o mais antigo. */
export async function listarLancamentosElegiveis(
  db: Db,
  pedido: PedidoParaVinculo,
): Promise<LancamentoElegivel[]> {
  const r = await db.query<LinhaLancamento>(
    `select a.id::text as id, a.indicador_id, i.nome as indicador_nome, a.valor, a.lancado_em,
            a.origem, a.avaliador_id, u.nome as avaliador_nome
       from avaliacoes a
       join indicadores i on i.id = a.indicador_id
       left join usuarios u on u.id = a.avaliador_id
      where ${SQL_LANCAMENTO_ELEGIVEL}
      order by a.lancado_em desc, a.id desc`,
    paramsElegibilidade(pedido),
  );
  return r.rows.map((l) => ({
    id: l.id,
    indicadorId: l.indicador_id,
    indicadorNome: l.indicador_nome,
    valor: Number(l.valor),
    lancadoEm: new Date(l.lancado_em).toISOString(),
    origem: l.origem,
    avaliador: l.avaliador_id ? { id: l.avaliador_id, nome: l.avaliador_nome ?? "" } : null,
  }));
}

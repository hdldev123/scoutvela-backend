import type { Db } from "../db/db.js";
import type { AtletaAvaliado } from "./avaliacao-atletas.js";

/**
 * Congela, no fechamento do ciclo, o que o painel do investidor lê depois: nota de cada pilar, status
 * de cada gate, status final e perfil de suporte (além de score e faixa, gravados em scores_ciclo).
 * Roda na mesma transação do fechamento. Tabelas só de inserção (migration 0019).
 */
export async function congelarCiclo(
  tx: Db,
  cicloId: string,
  avaliados: AtletaAvaliado[],
): Promise<void> {
  if (avaliados.length === 0) return;

  const pilares = avaliados.flatMap((x) =>
    x.calculo.pilares.map((p) => ({ atleta: x.atleta.id, pilar: p.pilarId, nota: p.nota })),
  );
  if (pilares.length > 0) {
    await tx.query(
      `insert into pilares_ciclo (atleta_id, ciclo_id, pilar_id, nota)
       select a, $1::uuid, p, n
         from unnest($2::uuid[], $3::text[], $4::float8[]) as t(a, p, n)`,
      [
        cicloId,
        pilares.map((i) => i.atleta),
        pilares.map((i) => i.pilar),
        pilares.map((i) => i.nota),
      ],
    );
  }

  const gates = avaliados.flatMap((x) =>
    x.calculo.gates.map((g) => ({ atleta: x.atleta.id, gate: g.gate, status: g.status })),
  );
  if (gates.length > 0) {
    await tx.query(
      `insert into gates_ciclo (atleta_id, ciclo_id, gate, status)
       select a, $1::uuid, g, s
         from unnest($2::uuid[], $3::int2[], $4::text[]) as t(a, g, s)`,
      [cicloId, gates.map((i) => i.atleta), gates.map((i) => i.gate), gates.map((i) => i.status)],
    );
  }

  await tx.query(
    `insert into fechamento_atleta_ciclo (atleta_id, ciclo_id, status_final, perfil_suporte, meses_assegurados)
     select a, $1::uuid, s, p, m
       from unnest($2::uuid[], $3::text[], $4::text[], $5::int4[]) as t(a, s, p, m)`,
    [
      cicloId,
      avaliados.map((x) => x.atleta.id),
      avaliados.map((x) => x.calculo.statusFinal),
      avaliados.map((x) => x.dados.financeiro?.perfilSuporte ?? null),
      avaliados.map((x) => x.dados.financeiro?.mesesAssegurados ?? null),
    ],
  );
}

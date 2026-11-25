import type { Db } from "../db/db.js";
import type { CicloCongeladoEntrada, LinhaCongelada } from "../domain/evolucao.js";
import type { CicloDaTurma } from "../domain/turma.js";
import { ESQUEMAS_REGRAS, type CodigoRegra } from "./regras-esquemas.js";

type ValorDe<C extends CodigoRegra> = ReturnType<(typeof ESQUEMAS_REGRAS)[C]["parse"]>;

/** Lê uma regra da tabela `regras` e valida pelo mesmo esquema da edição. Regra ausente é erro de instalação. */
export async function lerRegra<C extends CodigoRegra>(db: Db, codigo: C): Promise<ValorDe<C>> {
  const r = await db.query<{ valor: unknown }>("select valor from regras where codigo = $1", [
    codigo,
  ]);
  const linha = r.rows[0];
  if (!linha) throw new Error(`Regra ${codigo} não encontrada na tabela regras`);
  return ESQUEMAS_REGRAS[codigo].parse(linha.valor) as ValorDe<C>;
}

/** Existe a classe (ativa ou não)? */
export async function classeExiste(db: Db, classeId: string): Promise<boolean> {
  const r = await db.query("select 1 from classes where id = $1", [classeId]);
  return r.rows.length > 0;
}

/**
 * Ciclos fechados, do mais antigo ao mais recente, com o que o fechamento congelou de cada atleta
 * (score e faixa de `scores_ciclo`; pilares e status final das tabelas do congelamento completo, nulos
 * nos ciclos antigos). Sem filtro de acesso: só para agregados. `classeId` restringe à classe atual
 * do atleta.
 */
export async function carregarCiclosCongelados(
  db: Db,
  classeId: string | null,
): Promise<CicloCongeladoEntrada[]> {
  const ciclos = await db.query<{
    id: string;
    nome: string;
    fechado_em: Date | null;
    congelamento_completo: boolean;
  }>(
    `select c.id, c.nome,
            coalesce(c.fechado_em, (select max(s.calculado_em) from scores_ciclo s where s.ciclo_id = c.id)) as fechado_em,
            c.congelamento_completo
       from ciclos_avaliacao c
      where c.status = 'fechado'
      order by c.inicio, c.id`,
  );
  if (ciclos.rows.length === 0) return [];
  const ids = ciclos.rows.map((c) => c.id);

  const base = await db.query<{
    ciclo_id: string;
    atleta_id: string;
    score: string;
    faixa_id: string;
    status_final: LinhaCongelada["statusFinal"];
  }>(
    `select s.ciclo_id, s.atleta_id, s.score, s.faixa_id, f.status_final
       from scores_ciclo s
       join atletas a on a.id = s.atleta_id
       left join fechamento_atleta_ciclo f on f.atleta_id = s.atleta_id and f.ciclo_id = s.ciclo_id
      where s.ciclo_id = any($1::uuid[]) and ($2::text is null or a.classe_id = $2)
      order by s.ciclo_id, s.atleta_id`,
    [ids, classeId],
  );
  const pilares = await db.query<{
    ciclo_id: string;
    atleta_id: string;
    pilar_id: string;
    nota: string | null;
  }>(
    `select ciclo_id, atleta_id, pilar_id, nota from pilares_ciclo where ciclo_id = any($1::uuid[])`,
    [ids],
  );
  const pilaresDe = new Map<string, Map<string, number | null>>();
  for (const l of pilares.rows) {
    const chave = `${l.ciclo_id}|${l.atleta_id}`;
    if (!pilaresDe.has(chave)) pilaresDe.set(chave, new Map());
    pilaresDe.get(chave)!.set(l.pilar_id, l.nota === null ? null : Number(l.nota));
  }

  return ciclos.rows.map((c) => ({
    id: c.id,
    nome: c.nome,
    fechadoEm: c.fechado_em ? new Date(c.fechado_em).toISOString() : null,
    congelamentoCompleto: c.congelamento_completo,
    linhas: base.rows
      .filter((l) => l.ciclo_id === c.id)
      .map((l) => ({
        score: Number(l.score),
        faixaId: l.faixa_id,
        statusFinal: c.congelamento_completo ? l.status_final : null,
        pilares: c.congelamento_completo
          ? (pilaresDe.get(`${l.ciclo_id}|${l.atleta_id}`) ?? new Map())
          : null,
      })),
  }));
}

/**
 * Por ciclo fechado (mais antigo primeiro): média do score de todos os atletas do piloto, quantos são e o
 * score do atleta informado. Só agregado mais o score do próprio atleta; o acesso à ficha já foi checado.
 */
export async function carregarTurmaPorCiclo(db: Db, atletaId: string): Promise<CicloDaTurma[]> {
  const r = await db.query<{
    ciclo_id: string;
    ciclo: string;
    media: string;
    atletas: string;
    score_atleta: string | null;
  }>(
    `select c.id as ciclo_id, c.nome as ciclo, avg(s.score)::text as media, count(*)::text as atletas,
            max(s.score) filter (where s.atleta_id = $1::uuid)::text as score_atleta
       from scores_ciclo s
       join ciclos_avaliacao c on c.id = s.ciclo_id
      where c.status = 'fechado'
      group by c.id, c.nome, c.inicio
      order by c.inicio, c.id`,
    [atletaId],
  );
  return r.rows.map((l) => ({
    cicloId: l.ciclo_id,
    ciclo: l.ciclo,
    media: Number(l.media),
    atletas: Number(l.atletas),
    scoreDoAtleta: l.score_atleta === null ? null : Number(l.score_atleta),
  }));
}

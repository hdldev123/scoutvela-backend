import type { Db } from "../db/db.js";
import { sqlNotaDoAvaliador } from "./origens.js";

/** ids dos atletas com consentimento atual de compartilhamento com o IBVAR. */
export async function idsComConsentimentoIbvar(db: Db, atletaIds: string[]): Promise<Set<string>> {
  if (atletaIds.length === 0) return new Set();
  const r = await db.query<{ atleta_id: string }>(
    `select atleta_id from consentimento_atual
      where tipo = 'compartilhar_ibvar' and concedido and atleta_id = any($1::uuid[])`,
    [atletaIds],
  );
  return new Set(r.rows.map((l) => l.atleta_id));
}

export interface CicloDoPainel {
  id: string;
  nome: string;
  inicio: string;
  prazo: string;
  status: "aberto" | "fechado";
  /** Instante do fechamento; nulo se aberto (ou fechado sem registro de data). */
  fechadoEm: string | null;
  /** O fechamento congelou também pilares, gates, status final e perfil (ciclos novos). */
  congelamentoCompleto: boolean;
}

interface LinhaCicloPainel {
  id: string;
  nome: string;
  inicio: string;
  prazo: string;
  status: "aberto" | "fechado";
  fechado_em: Date | null;
  congelamento_completo: boolean;
}

/** Todos os ciclos, do mais recente ao mais antigo (mesma ordem de GET /ciclos). */
export async function listarCiclosDoPainel(db: Db): Promise<CicloDoPainel[]> {
  const r = await db.query<LinhaCicloPainel>(
    `select c.id, c.nome, c.inicio::text as inicio, c.prazo::text as prazo, c.status,
            coalesce(c.fechado_em, (select max(s.calculado_em) from scores_ciclo s where s.ciclo_id = c.id)) as fechado_em,
            c.congelamento_completo
       from ciclos_avaliacao c
      order by c.inicio desc, c.id`,
  );
  return r.rows.map((l) => ({
    id: l.id,
    nome: l.nome,
    inicio: l.inicio,
    prazo: l.prazo,
    status: l.status,
    fechadoEm: l.status === "fechado" && l.fechado_em ? new Date(l.fechado_em).toISOString() : null,
    congelamentoCompleto: l.congelamento_completo,
  }));
}

/** Um atleta no que foi congelado no fechamento do ciclo. Campos novos são nulos em ciclos antigos. */
export interface CongeladoDoAtleta {
  atletaId: string;
  score: number;
  faixaId: string;
  statusFinal: "apto" | "condicional" | "nao_prioritario" | null;
  perfilSuporte: "A" | "B" | "C" | "D" | null;
  mesesAssegurados: number | null;
  /** pilar -> nota; nulo se o ciclo não congelou pilares. */
  pilares: Map<string, number | null> | null;
  /** gate (1 a 4) -> status; nulo se o ciclo não congelou gates. */
  gates: Map<number, "apto" | "condicional" | "alerta"> | null;
}

/** O que o fechamento congelou de cada atleta do ciclo (sem filtro de acesso: só para agregados). */
export async function carregarCongelado(
  db: Db,
  cicloId: string,
  congelamentoCompleto: boolean,
): Promise<CongeladoDoAtleta[]> {
  const base = await db.query<{
    atleta_id: string;
    score: string;
    faixa_id: string;
    status_final: CongeladoDoAtleta["statusFinal"];
    perfil_suporte: CongeladoDoAtleta["perfilSuporte"];
    meses_assegurados: number | null;
  }>(
    `select s.atleta_id, s.score, s.faixa_id, f.status_final, f.perfil_suporte, f.meses_assegurados
       from scores_ciclo s
       left join fechamento_atleta_ciclo f on f.atleta_id = s.atleta_id and f.ciclo_id = s.ciclo_id
      where s.ciclo_id = $1::uuid
      order by s.atleta_id`,
    [cicloId],
  );
  const pilares = new Map<string, Map<string, number | null>>();
  const gates = new Map<string, Map<number, "apto" | "condicional" | "alerta">>();
  if (congelamentoCompleto) {
    const [p, g] = await Promise.all([
      db.query<{ atleta_id: string; pilar_id: string; nota: number | null }>(
        `select atleta_id, pilar_id, nota from pilares_ciclo where ciclo_id = $1::uuid`,
        [cicloId],
      ),
      db.query<{ atleta_id: string; gate: number; status: "apto" | "condicional" | "alerta" }>(
        `select atleta_id, gate, status from gates_ciclo where ciclo_id = $1::uuid`,
        [cicloId],
      ),
    ]);
    for (const l of p.rows) {
      if (!pilares.has(l.atleta_id)) pilares.set(l.atleta_id, new Map());
      pilares.get(l.atleta_id)!.set(l.pilar_id, l.nota === null ? null : Number(l.nota));
    }
    for (const l of g.rows) {
      if (!gates.has(l.atleta_id)) gates.set(l.atleta_id, new Map());
      gates.get(l.atleta_id)!.set(l.gate, l.status);
    }
  }
  return base.rows.map((l) => ({
    atletaId: l.atleta_id,
    score: Number(l.score),
    faixaId: l.faixa_id,
    statusFinal: l.status_final,
    perfilSuporte: l.perfil_suporte,
    mesesAssegurados: l.meses_assegurados,
    pilares: congelamentoCompleto ? (pilares.get(l.atleta_id) ?? new Map()) : null,
    gates: congelamentoCompleto ? (gates.get(l.atleta_id) ?? new Map()) : null,
  }));
}

/**
 * Instante do último lançamento que muda score ou gates (avaliações que pontuam, medidas corporais,
 * resultados de regata, decisões de gate e financeiro) dos atletas informados. Nulo se não houver.
 * Sugestão do atleta ainda sem nota (`resposta_sugerida` e `autoavaliacao`) não muda o score e fica de fora.
 * Os ids devem vir já filtrados pela matriz de acesso; para o painel, é sempre o agregado do piloto.
 */
export async function ultimoLancamento(db: Db, atletaIds: string[]): Promise<string | null> {
  if (atletaIds.length === 0) return null;
  const r = await db.query<{ em: Date | null }>(
    `select max(t) as em from (
       select max(lancado_em) as t from avaliacoes
        where atleta_id = any($1::uuid[]) and ${sqlNotaDoAvaliador()}
       union all select max(registrado_em) from medidas_corporais where atleta_id = any($1::uuid[])
       union all select max(registrado_em) from resultados_regata where atleta_id = any($1::uuid[])
       union all select max(decidido_em) from gates_decisoes where atleta_id = any($1::uuid[])
       union all select max(informado_em) from financeiro_campanha where atleta_id = any($1::uuid[])
     ) x`,
    [atletaIds],
  );
  const em = r.rows[0]?.em;
  return em ? new Date(em).toISOString() : null;
}

import type { Db } from "../db/db.js";
import type { Classe, FaixaScore, Parametros, Pilar, Regras, StatusGate, TipoIndicador } from "../domain/tipos.js";

type ValorRegra = Record<string, unknown>;

function numero(v: unknown, regra: string, campo: string): number {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) {
    throw new Error(`Regra ${regra} sem o campo numérico "${campo}"`);
  }
  return n;
}

/** Converte as regras do banco (jsonb em snake_case) para o tipo Regras (camelCase). */
export function regrasDoBanco(linhas: { codigo: string; valor: ValorRegra }[]): Regras {
  const porCodigo = new Map(linhas.map((l) => [l.codigo, l.valor]));
  const pegar = (codigo: string): ValorRegra => {
    const v = porCodigo.get(codigo);
    if (!v) throw new Error(`Regra ${codigo} não encontrada na tabela regras`);
    return v;
  };

  const p3 = pegar("P3");
  const g1 = pegar("G1");
  const g2 = pegar("G2");
  const g3 = pegar("G3");
  const g4 = pegar("G4") as Record<string, { status: StatusGate; motivo: string }>;
  const rk = pegar("RANKING_CBVELA");
  const perfil = (p: "A" | "B" | "C" | "D") => {
    const x = g4[p];
    if (!x) throw new Error(`Regra G4 sem o perfil ${p}`);
    return { status: x.status, motivo: x.motivo };
  };

  return {
    p3: { limites: (p3.limites as unknown[]).map((n) => numero(n, "P3", "limites")) },
    g1: { aptoAte: numero(g1.apto_ate, "G1", "apto_ate"), condicionalAte: numero(g1.condicional_ate, "G1", "condicional_ate") },
    g2: {
      mundialAptoAteFracao: numero(g2.mundial_apto_ate_fracao, "G2", "mundial_apto_ate_fracao"),
      sulAmericanoCondicionalAtePosicao: numero(g2.sul_americano_condicional_ate_posicao, "G2", "sul_americano_condicional_ate_posicao"),
      mundialCondicionalAteFracao: numero(g2.mundial_condicional_ate_fracao, "G2", "mundial_condicional_ate_fracao"),
      brasileiroCondicionalAtePosicao: numero(g2.brasileiro_condicional_ate_posicao, "G2", "brasileiro_condicional_ate_posicao"),
    },
    g3: {
      aptoMinEventos: numero(g3.apto_min_eventos, "G3", "apto_min_eventos"),
      condicionalMinEventos: numero(g3.condicional_min_eventos, "G3", "condicional_min_eventos"),
      janelaMeses: numero(g3.janela_meses, "G3", "janela_meses"),
    },
    g4: { A: perfil("A"), B: perfil("B"), C: perfil("C"), D: perfil("D") },
    rankingCbvela: { janelaSemanas: numero(rk.janela_semanas, "RANKING_CBVELA", "janela_semanas") },
  };
}

/** Carrega do banco tudo o que o cálculo precisa: pilares, indicadores, faixas, classes e regras. */
export async function carregarParametros(db: Db): Promise<Parametros> {
  const pilaresRows = (
    await db.query<{ id: string; nome: string; nome_curto: string; peso: string; sensivel: boolean; evidencia_padrao: string }>(
      "select id, nome, nome_curto, peso, sensivel, evidencia_padrao from pilares order by ordem",
    )
  ).rows;
  const indicadoresRows = (
    await db.query<{ id: string; pilar_id: string; nome: string; tipo: TipoIndicador; calculado: boolean }>(
      "select id, pilar_id, nome, tipo, calculado from indicadores order by pilar_id, ordem",
    )
  ).rows;
  const faixasRows = (
    await db.query<{ id: string; nome: string; nome_curto: string; score_min: string }>(
      "select id, nome, nome_curto, score_min from faixas_score order by score_min desc",
    )
  ).rows;
  const classesRows = (
    await db.query<{
      id: string;
      nome: string;
      evento: string;
      posicao: Classe["posicao"];
      peso_min_kg: string;
      peso_medio_kg: string;
      peso_max_kg: string;
    }>("select id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg from classes where ativa order by ordem")
  ).rows;
  const regrasRows = (await db.query<{ codigo: string; valor: ValorRegra }>("select codigo, valor from regras")).rows;

  const pilares: Pilar[] = pilaresRows.map((p) => ({
    id: p.id,
    nome: p.nome,
    nomeCurto: p.nome_curto,
    peso: Number(p.peso),
    sensivel: p.sensivel,
    evidenciaPadrao: p.evidencia_padrao,
    indicadores: indicadoresRows
      .filter((i) => i.pilar_id === p.id)
      .map((i) => ({ id: i.id, pilarId: i.pilar_id, nome: i.nome, tipo: i.tipo, calculado: i.calculado })),
  }));
  const faixas: FaixaScore[] = faixasRows.map((f) => ({
    id: f.id,
    nome: f.nome,
    nomeCurto: f.nome_curto,
    scoreMin: Number(f.score_min),
  }));
  const classes: Classe[] = classesRows.map((c) => ({
    id: c.id,
    nome: c.nome,
    evento: c.evento,
    posicao: c.posicao,
    pesoMinKg: Number(c.peso_min_kg),
    pesoMedioKg: Number(c.peso_medio_kg),
    pesoMaxKg: Number(c.peso_max_kg),
  }));

  return { pilares, faixas, classes, regras: regrasDoBanco(regrasRows) };
}

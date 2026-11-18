import type {
  EntradaCalculo,
  FaixaScore,
  NotasAtuais,
  Parametros,
  Pilar,
  ResultadoRegata,
} from "./tipos.js";
import { distanciaClassFit, notaPeso } from "./classfit.js";
import { dataIso, menosDias, naJanela } from "./datas.js";

/** Notas lançadas + indicadores calculados (cf_peso_kg pela P3). Calculado ignora qualquer lançamento. */
export function notasEfetivas(
  parametros: Parametros,
  entrada: Pick<EntradaCalculo, "classe" | "pesoKg" | "notas">,
): Record<string, number | null> {
  const efetivas: Record<string, number | null> = {};
  for (const [id, valor] of Object.entries(entrada.notas)) efetivas[id] = valor ?? null;
  for (const pilar of parametros.pilares) {
    for (const ind of pilar.indicadores) {
      if (!ind.calculado) continue;
      efetivas[ind.id] =
        ind.id === "cf_peso_kg" && entrada.pesoKg != null
          ? notaPeso(
              distanciaClassFit(entrada.pesoKg, entrada.classe).distanciaRelativa,
              parametros.regras.p3.limites,
            )
          : null;
    }
  }
  return efetivas;
}

/** Média dos indicadores com nota, excluindo tipo R (P2). Nulo se nenhum. */
export function notaPilar(pilar: Pilar, notas: NotasAtuais): number | null {
  const valores = pilar.indicadores
    .filter((i) => i.tipo !== "R")
    .map((i) => notas[i.id])
    .filter((v): v is number => v != null);
  return valores.length ? valores.reduce((s, v) => s + v, 0) / valores.length : null;
}

/** Σ (notaPilar ÷ 5) × peso do pilar; pilar sem nota contribui 0. */
export function calcularScore(pilares: Pilar[], notas: NotasAtuais): number {
  let s = 0;
  for (const p of pilares) {
    const n = notaPilar(p, notas);
    if (n != null) s += (n / 5) * p.peso;
  }
  return s;
}

/** Primeira faixa (maior scoreMin primeiro) com score ≥ scoreMin. */
export function faixaDoScore(score: number, faixas: FaixaScore[]): FaixaScore {
  const ordenadas = [...faixas].sort((a, b) => b.scoreMin - a.scoreMin);
  return (
    ordenadas.find((f) => score >= f.scoreMin) ?? (ordenadas[ordenadas.length - 1] as FaixaScore)
  );
}

/** Soma dos pontos CBVela dos resultados nacionais com data em (referencia − janela, referencia]. */
export function pontosRankingCbvela(
  resultados: ResultadoRegata[],
  referencia: Date,
  janelaSemanas: number,
): number {
  const fim = dataIso(referencia);
  const inicio = menosDias(fim, janelaSemanas * 7);
  return resultados
    .filter((r) => !r.internacional && naJanela(r.data, inicio, fim))
    .reduce((s, r) => s + (r.pontosCbvela ?? 0), 0);
}

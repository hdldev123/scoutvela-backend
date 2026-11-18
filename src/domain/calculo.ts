import type { EntradaCalculo, NotaPilar, Parametros, ResultadoCalculo } from "./tipos.js";
import { distanciaClassFit } from "./classfit.js";
import { aplicarDecisoes, gatesAutomaticos, statusFinal } from "./gates.js";
import {
  calcularScore,
  faixaDoScore,
  notaPilar,
  notasEfetivas,
  pontosRankingCbvela,
} from "./score.js";

export function calcularAtleta(parametros: Parametros, entrada: EntradaCalculo): ResultadoCalculo {
  const notas = notasEfetivas(parametros, entrada);
  const pilares: NotaPilar[] = parametros.pilares.map((p) => {
    const nota = notaPilar(p, notas);
    const pontuam = p.indicadores.filter((i) => i.tipo !== "R");
    return {
      pilarId: p.id,
      nota,
      contribuicao: nota == null ? 0 : (nota / 5) * p.peso,
      preenchidos: pontuam.filter((i) => notas[i.id] != null).length,
      total: pontuam.length,
    };
  });
  const score = calcularScore(parametros.pilares, notas);
  const preenchidos = pilares.reduce((s, p) => s + p.preenchidos, 0);
  const total = pilares.reduce((s, p) => s + p.total, 0);
  const gates = aplicarDecisoes(gatesAutomaticos(parametros, entrada), entrada.decisoesGates);
  return {
    notas,
    pilares,
    score,
    faixa: faixaDoScore(score, parametros.faixas),
    completo: preenchidos === total,
    preenchidos,
    total,
    classFit: entrada.pesoKg == null ? null : distanciaClassFit(entrada.pesoKg, entrada.classe),
    gates,
    statusFinal: statusFinal(gates),
    pontosCbvela: pontosRankingCbvela(
      entrada.resultados,
      entrada.referencia,
      parametros.regras.rankingCbvela.janelaSemanas,
    ),
  };
}

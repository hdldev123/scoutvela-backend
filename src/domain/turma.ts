import { arredondar2, grupoPequeno } from "./evolucao.js";

/**
 * Atleta comparado à média da turma (D13). Funções puras: recebem o que o fechamento congelou
 * (`scores_ciclo`) e devolvem a média por ciclo, a comparação do último ciclo e a tendência.
 */

/** Um ciclo fechado: média bruta do score de todo o piloto e o score do atleta, se ele tem. */
export interface CicloDaTurma {
  cicloId: string;
  ciclo: string;
  /** Média do score de todos os atletas do piloto no ciclo (sem arredondar). */
  media: number;
  atletas: number;
  /** Score congelado do atleta neste ciclo; nulo se ele não tinha score. */
  scoreDoAtleta: number | null;
}

export type PosicaoNaTurma = "acima" | "na_media" | "abaixo";
export type Tendencia = "subindo" | "estavel" | "caindo";

export interface ComparacaoComTurma {
  scoreAtual: number;
  mediaTurma: number;
  diferenca: number;
  posicao: PosicaoNaTurma;
}

export interface ResumoDaTurma {
  mediaTurmaPorCiclo: { cicloId: string; ciclo: string; media: number | null; atletas: number }[];
  comparacaoTurma: ComparacaoComTurma | null;
  tendencia: Tendencia | null;
}

/** Acima ou abaixo da média só quando a diferença chega ao limiar; antes disso, na média. */
export function posicaoNaTurma(diferenca: number, limiar: number): PosicaoNaTurma {
  if (Math.abs(diferenca) < limiar) return "na_media";
  return diferenca > 0 ? "acima" : "abaixo";
}

/**
 * Tendência do atleta: diferença entre os dois últimos scores (do mais antigo ao mais recente) contra
 * o limiar, em pontos de score. Nula com menos de dois ciclos.
 */
export function tendenciaDoAtleta(scores: readonly number[], limiar: number): Tendencia | null {
  if (scores.length < 2) return null;
  const variacao = scores[scores.length - 1]! - scores[scores.length - 2]!;
  if (Math.abs(variacao) < limiar) return "estavel";
  return variacao > 0 ? "subindo" : "caindo";
}

/**
 * Monta o que a ficha mostra, com `ciclos` do mais antigo ao mais recente. `minimo` é o mínimo do
 * IBVAR: grupo menor que ele tem a média nula (e sem comparação); nulo para quem vê tudo.
 */
export function resumoDaTurma(
  ciclos: readonly CicloDaTurma[],
  limiar: number,
  minimo: number | null,
): ResumoDaTurma {
  const mediaTurmaPorCiclo = ciclos.map((c) => ({
    cicloId: c.cicloId,
    ciclo: c.ciclo,
    media: grupoPequeno(c.atletas, minimo) ? null : arredondar2(c.media),
    atletas: c.atletas,
  }));

  const doAtleta = ciclos.flatMap((c, i) =>
    c.scoreDoAtleta === null ? [] : [{ i, score: c.scoreDoAtleta, media: c.media }],
  );
  const ultimo = doAtleta[doAtleta.length - 1];
  let comparacaoTurma: ComparacaoComTurma | null = null;
  if (ultimo && mediaTurmaPorCiclo[ultimo.i]!.media !== null) {
    const diferenca = ultimo.score - ultimo.media;
    comparacaoTurma = {
      scoreAtual: arredondar2(ultimo.score),
      mediaTurma: arredondar2(ultimo.media),
      diferenca: arredondar2(diferenca),
      posicao: posicaoNaTurma(diferenca, limiar),
    };
  }

  return {
    mediaTurmaPorCiclo,
    comparacaoTurma,
    tendencia: tendenciaDoAtleta(
      doAtleta.map((x) => x.score),
      limiar,
    ),
  };
}

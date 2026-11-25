import type { NivelCompeticao } from "./tipos.js";

/**
 * Nota dos indicadores de resultado (D10, decisão E): perf_mundial, perf_continental e perf_nacional
 * saem dos resultados VALIDADOS do atleta pela regra PERF_RESULTADOS. Nunca são digitados.
 */

/** Níveis que geram nota. Estadual, regional e internacional aberto ficam registrados, mas não entram. */
export const NIVEIS_DE_NOTA = ["mundial", "continental", "nacional"] as const;
export type NivelDeNota = (typeof NIVEIS_DE_NOTA)[number];

/** Indicador que recebe a nota de cada nível. */
export const INDICADOR_DO_NIVEL: Record<NivelDeNota, string> = {
  mundial: "perf_mundial",
  continental: "perf_continental",
  nacional: "perf_nacional",
};

/**
 * Nível de nota de um nível de competição de `resultados_regata`:
 * mundial → mundial; sul_americano e continental (inclui o Pan-Americano) → continental;
 * brasileiro → nacional. Os demais (internacional_aberto, estadual, regional) não geram nota.
 */
export function nivelDeNota(nivel: NivelCompeticao): NivelDeNota | null {
  switch (nivel) {
    case "mundial":
      return "mundial";
    case "sul_americano":
    case "continental":
      return "continental";
    case "brasileiro":
      return "nacional";
    default:
      return null;
  }
}

/** Nível de competição gravado para o nível informado pelo atleta. */
export const NIVEL_GRAVADO: Record<NivelDeNota, NivelCompeticao> = {
  mundial: "mundial",
  continental: "continental",
  nacional: "brasileiro",
};

/** Faixa de colocação: vale até `ate` (inclusive); `ate` nulo vale para qualquer colocação. */
export interface FaixaColocacao {
  ate: number | null;
  nota: number;
}

/** Regra PERF_RESULTADOS (tabela `regras`). */
export interface RegraResultados {
  /** Quantos resultados mais recentes de cada nível entram no cálculo. */
  edicoesMax: number;
  niveis: Record<NivelDeNota, FaixaColocacao[]>;
}

/** Resultado validado, no que a nota precisa. */
export interface ResultadoParaNota {
  nivel: NivelCompeticao;
  evento: string;
  /** Ano da edição. */
  edicao: number;
  posicao: number;
  /** AAAA-MM-DD; desempata edições do mesmo ano (a mais recente primeiro). */
  data: string;
}

/** De onde veio a nota de um nível: o resultado que a definiu. */
export interface NotaDeResultado {
  nota: number;
  nivel: NivelDeNota;
  posicao: number;
  edicao: number;
  evento: string;
}

/** Nota de uma colocação: primeira faixa com colocação <= `ate`. Sem faixa que sirva, 0. */
export function notaDaColocacao(posicao: number, faixas: FaixaColocacao[]): number {
  const faixa = faixas.find((f) => f.ate === null || posicao <= f.ate);
  return faixa ? faixa.nota : 0;
}

/**
 * Nota de cada nível pelos resultados validados. Por nível, entram os `edicoesMax` resultados mais
 * recentes (edição, depois data) e vale a MELHOR colocação entre eles; empate de colocação fica com o
 * mais recente. O tamanho da frota não entra. Sem resultado validado no nível, o nível fica nulo
 * (indicador sem nota). Resultado de nível que não gera nota é ignorado.
 */
export function notaDeResultados(
  resultadosValidados: ResultadoParaNota[],
  regra: RegraResultados,
): Record<NivelDeNota, NotaDeResultado | null> {
  const saida: Record<NivelDeNota, NotaDeResultado | null> = {
    mundial: null,
    continental: null,
    nacional: null,
  };
  for (const nivel of NIVEIS_DE_NOTA) {
    const doNivel = resultadosValidados
      .filter((r) => nivelDeNota(r.nivel) === nivel)
      .sort((a, b) => b.edicao - a.edicao || b.data.localeCompare(a.data))
      .slice(0, Math.max(0, regra.edicoesMax));
    // `sort` é estável e a lista já vem da mais recente: o primeiro de menor colocação é o mais recente.
    let melhor: ResultadoParaNota | null = null;
    for (const r of doNivel) if (!melhor || r.posicao < melhor.posicao) melhor = r;
    if (melhor) {
      saida[nivel] = {
        nota: notaDaColocacao(melhor.posicao, regra.niveis[nivel]),
        nivel,
        posicao: melhor.posicao,
        edicao: melhor.edicao,
        evento: melhor.evento,
      };
    }
  }
  return saida;
}

/** Texto curto de onde veio a nota, para a ficha. */
export function explicacaoDaNota(n: NotaDeResultado): string {
  const nome: Record<NivelDeNota, string> = {
    mundial: "Mundial",
    continental: "campeonato continental",
    nacional: "Campeonato Brasileiro",
  };
  return `Melhor colocação validada no ${nome[n.nivel]}: ${n.posicao}º em ${n.edicao} (${n.evento})`;
}

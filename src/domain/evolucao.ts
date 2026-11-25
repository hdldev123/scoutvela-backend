/**
 * Evolução da turma entre ciclos fechados (D12). Funções puras: recebem o que o fechamento congelou
 * e devolvem os agregados; o sigilo do IBVAR (grupo pequeno) é aplicado aqui, com o mínimo vindo da
 * regra MIN_GRUPO_AGREGADO.
 */

/** Um atleta no que o fechamento do ciclo congelou. Pilares são nulos em ciclo antigo. */
export interface LinhaCongelada {
  score: number;
  faixaId: string;
  statusFinal: "apto" | "condicional" | "nao_prioritario" | null;
  /** pilar -> nota; nulo se o ciclo não congelou pilares. */
  pilares: ReadonlyMap<string, number | null> | null;
}

export interface CicloCongeladoEntrada {
  id: string;
  nome: string;
  fechadoEm: string | null;
  congelamentoCompleto: boolean;
  linhas: readonly LinhaCongelada[];
}

export interface EvolucaoDoCiclo {
  ciclo: { id: string; nome: string; fechadoEm: string | null };
  atletas: number;
  scoreMedio: number | null;
  mediaPorPilar: { pilarId: string; nomeCurto: string; media: number | null }[] | null;
  funil: { faixaId: string; nome: string; n: number }[] | null;
  aptosNosGates: number | null;
  congelamentoCompleto: boolean;
  /** true: grupo menor que o mínimo para o IBVAR; os números vêm nulos. */
  suprimido: boolean;
}

export interface MetaDeEvolucao {
  percentual: number;
  cicloBase: { id: string; nome: string } | null;
  cicloAtual: { id: string; nome: string } | null;
  mediaBase: number | null;
  mediaAtual: number | null;
  variacaoPercentual: number | null;
  atingida: boolean | null;
}

/** Duas casas decimais, para a resposta não carregar dízima. */
export function arredondar2(v: number): number {
  return Math.round(v * 100) / 100;
}

/** Média simples; nula para lista vazia. */
export function media(valores: readonly number[]): number | null {
  return valores.length === 0 ? null : valores.reduce((t, v) => t + v, 0) / valores.length;
}

/** O grupo é pequeno demais para o IBVAR ver em agregado? (`minimo` nulo = sem restrição, caso do gestor.) */
export function grupoPequeno(atletas: number, minimo: number | null): boolean {
  return minimo !== null && atletas < minimo;
}

/**
 * Evolução por ciclo fechado, na ordem recebida (mais antigo primeiro). `minimo` é o mínimo do IBVAR;
 * nulo para quem vê tudo.
 */
export function evolucaoDaTurma(
  ciclos: readonly CicloCongeladoEntrada[],
  faixas: readonly { id: string; nome: string }[],
  pilares: readonly { id: string; nomeCurto: string }[],
  minimo: number | null,
): EvolucaoDoCiclo[] {
  return ciclos.map((c) => {
    const n = c.linhas.length;
    const cabecalho = {
      ciclo: { id: c.id, nome: c.nome, fechadoEm: c.fechadoEm },
      atletas: n,
      congelamentoCompleto: c.congelamentoCompleto,
    };
    if (grupoPequeno(n, minimo)) {
      return {
        ...cabecalho,
        scoreMedio: null,
        mediaPorPilar: null,
        funil: null,
        aptosNosGates: null,
        suprimido: true,
      };
    }
    const scoreMedio = media(c.linhas.map((l) => l.score));
    return {
      ...cabecalho,
      scoreMedio: scoreMedio === null ? null : arredondar2(scoreMedio),
      mediaPorPilar: c.congelamentoCompleto
        ? pilares.map((p) => {
            const m = media(
              c.linhas
                .map((l) => l.pilares?.get(p.id) ?? null)
                .filter((v): v is number => v !== null),
            );
            return {
              pilarId: p.id,
              nomeCurto: p.nomeCurto,
              media: m === null ? null : arredondar2(m),
            };
          })
        : null,
      funil: faixas.map((f) => ({
        faixaId: f.id,
        nome: f.nome,
        n: c.linhas.filter((l) => l.faixaId === f.id).length,
      })),
      aptosNosGates: c.congelamentoCompleto
        ? c.linhas.filter((l) => l.statusFinal === "apto").length
        : null,
      suprimido: false,
    };
  });
}

/**
 * Meta da turma: compara a média do score dos dois últimos ciclos fechados (`ciclos` do mais antigo ao
 * mais recente) com a alta esperada. Sem dois ciclos, ou com a média de um deles oculta, os números
 * vêm nulos. Média base zero não tem variação percentual (nula, meta não avaliada).
 */
export function metaDeEvolucao(
  ciclos: readonly Pick<EvolucaoDoCiclo, "ciclo" | "scoreMedio">[],
  percentual: number,
): MetaDeEvolucao {
  const base = ciclos.length >= 2 ? ciclos[ciclos.length - 2]! : null;
  const atual = ciclos.length >= 2 ? ciclos[ciclos.length - 1]! : null;
  const mediaBase = base?.scoreMedio ?? null;
  const mediaAtual = atual?.scoreMedio ?? null;
  const variacao =
    mediaBase !== null && mediaAtual !== null && mediaBase > 0
      ? ((mediaAtual - mediaBase) / mediaBase) * 100
      : null;
  return {
    percentual,
    cicloBase: base ? { id: base.ciclo.id, nome: base.ciclo.nome } : null,
    cicloAtual: atual ? { id: atual.ciclo.id, nome: atual.ciclo.nome } : null,
    mediaBase,
    mediaAtual,
    variacaoPercentual: variacao === null ? null : arredondar2(variacao),
    atingida: variacao === null ? null : variacao >= percentual,
  };
}

/**
 * Tipos do domínio do Scout Vela. As funções de domain/ são puras: recebem
 * parâmetros (vindos do banco) e dados do atleta, e devolvem o cálculo.
 * Nenhum peso, faixa ou limite fica fixo no código.
 */

export type Papel = "gestor" | "treinador" | "atleta" | "ibvar" | "responsavel";

export type TipoIndicador = "T" | "A" | "R";
export type PosicaoClasse = "helm" | "crew" | "ind";
export type Genero = "F" | "M";
export type PerfilSuporte = "A" | "B" | "C" | "D";

/** Status de um gate. */
export type StatusGate = "apto" | "condicional" | "alerta";
/** Status final pelos 4 gates (P7). */
export type StatusFinal = "apto" | "condicional" | "nao_prioritario";

export type NivelCompeticao =
  | "mundial"
  | "sul_americano"
  | "continental"
  | "internacional_aberto"
  | "brasileiro"
  | "estadual"
  | "regional";

export interface Indicador {
  id: string;
  pilarId: string;
  nome: string;
  tipo: TipoIndicador;
  /** Nota derivada pelo sistema (ex.: cf_peso_kg pela P3), nunca digitada. */
  calculado: boolean;
}

export interface Pilar {
  id: string;
  nome: string;
  nomeCurto: string;
  /** Pontos do pilar no score de 100. */
  peso: number;
  sensivel: boolean;
  evidenciaPadrao: string;
  /** Na ordem de exibição. */
  indicadores: Indicador[];
}

export interface Classe {
  id: string;
  nome: string;
  evento: string;
  posicao: PosicaoClasse;
  pesoMinKg: number;
  pesoMedioKg: number;
  pesoMaxKg: number;
}

export interface FaixaScore {
  id: string;
  nome: string;
  nomeCurto: string;
  scoreMin: number;
}

/** Regras provisórias e limites, todos editáveis (tabela `regras`). */
export interface Regras {
  /** P3: nota do peso pela distância relativa à média (|peso − média| ÷ meia faixa).
   *  limites[i] é o teto da nota 5 − i; acima do último, nota 0.
   *  Padrão do Word/protótipo: [0.5, 1, 1.5, 2, 3]. */
  p3: { limites: number[] };
  /** G1 Class Fit pela mesma distância relativa: até aptoAte = apto; até condicionalAte = condicional; acima = alerta. */
  g1: { aptoAte: number; condicionalAte: number };
  /** G2 Evidência competitiva, avaliada em ordem:
   *  1. Mundial com posição/frota ≤ mundialAptoAteFracao → apto
   *  2. Sul-Americano com posição ≤ sulAmericanoCondicionalAtePosicao → condicional
   *  3. Mundial com posição/frota ≤ mundialCondicionalAteFracao → condicional
   *  4. Brasileiro com posição ≤ brasileiroCondicionalAtePosicao → condicional
   *  5. senão → alerta */
  g2: {
    mundialAptoAteFracao: number;
    sulAmericanoCondicionalAtePosicao: number;
    mundialCondicionalAteFracao: number;
    brasileiroCondicionalAtePosicao: number;
  };
  /** G3 Alto rendimento: eventos internacionais na janela. */
  g3: { aptoMinEventos: number; condicionalMinEventos: number; janelaMeses: number };
  /** G4 Campanha pelo perfil de suporte (P8). */
  g4: Record<PerfilSuporte, { status: StatusGate; motivo: string }>;
  /** Janela do Ranking CBVela para somar pontos. */
  rankingCbvela: { janelaSemanas: number };
}

export interface Parametros {
  /** Na ordem: perf, cf, tec, tat, pot, exp, men, amb, car. */
  pilares: Pilar[];
  /** Ordenadas do maior scoreMin para o menor. */
  faixas: FaixaScore[];
  classes: Classe[];
  regras: Regras;
}

export interface ResultadoRegata {
  nivel: NivelCompeticao;
  evento: string;
  /** ISO, AAAA-MM-DD. */
  data: string;
  posicao: number;
  tamanhoFrota: number;
  internacional: boolean;
  /** Pontos do Ranking CBVela (nacionais). Nulo nos internacionais. */
  pontosCbvela: number | null;
}

/** Nota atual de cada indicador (último lançamento). Ausente ou nulo = sem nota. */
export type NotasAtuais = Record<string, number | null | undefined>;

/** Tudo o que o cálculo de um atleta precisa. */
export interface EntradaCalculo {
  classe: Classe;
  /** Peso da última medida. Nulo = sem pesagem (cf_peso_kg fica sem nota; G1 em alerta). */
  pesoKg: number | null;
  /** Notas lançadas (não inclui indicadores calculados; eles são derivados). */
  notas: NotasAtuais;
  resultados: ResultadoRegata[];
  /** Nulo = financeiro ainda não informado (G4 em alerta). */
  perfilSuporte: PerfilSuporte | null;
  /** Decisões do gestor por gate (índice 0 = G1). Nulo = vale a sugestão automática. */
  decisoesGates: (StatusGate | null)[];
  /** Data de referência para janelas (Ranking CBVela, G3). */
  referencia: Date;
}

export interface NotaPilar {
  pilarId: string;
  /** Média dos indicadores com nota (P2), 0 a 5. Nulo se nenhum tiver nota. */
  nota: number | null;
  /** (nota ÷ 5) × peso. Zero sem nota. */
  contribuicao: number;
  preenchidos: number;
  /** Indicadores que pontuam (exclui tipo R). */
  total: number;
}

export interface Gate {
  /** 1 a 4. */
  gate: number;
  status: StatusGate;
  /** Por que a sugestão automática deu esse status. */
  motivo: string;
  sugestaoAutomatica: StatusGate;
  ajustadoPeloGestor: boolean;
}

export interface ResultadoCalculo {
  /** Notas efetivas usadas no cálculo, já com os indicadores calculados. */
  notas: Record<string, number | null>;
  pilares: NotaPilar[];
  score: number;
  faixa: FaixaScore;
  /** true quando todos os indicadores que pontuam têm nota. */
  completo: boolean;
  preenchidos: number;
  total: number;
  classFit: { deltaKg: number; distanciaRelativa: number } | null;
  gates: Gate[];
  statusFinal: StatusFinal;
  pontosCbvela: number;
}

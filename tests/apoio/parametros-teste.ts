import type {
  Classe,
  EntradaCalculo,
  Parametros,
  Pilar,
  PosicaoClasse,
  Regras,
  ResultadoRegata,
  TipoIndicador,
} from "../../src/domain/tipos.js";

type Ind = [id: string, nome: string, tipo: TipoIndicador];

// Valores do protótipo (engine.js), metodologia de 29/09/2026.
const PILARES_BASE: [string, string, string, number, boolean, string, Ind[]][] = [
  [
    "perf",
    "Performance esportiva",
    "Performance",
    20,
    false,
    "Histórico competitivo",
    [
      ["perf_mundial", "Resultados em Mundial e Youth World", "T"],
      ["perf_continental", "Resultados continentais", "T"],
      ["perf_nacional", "Resultados nacionais", "T"],
      ["perf_consistencia", "Consistência", "T"],
      ["perf_nivel_frota", "Nível da classe e da frota", "T"],
    ],
  ],
  [
    "cf",
    "Class Fit / perfil físico",
    "Class Fit",
    20,
    true,
    "Avaliação física",
    [
      ["cf_peso_kg", "Peso", "T"],
      ["cf_altura_cm", "Altura", "T"],
      ["cf_composicao", "Composição corporal", "T"],
      ["cf_potencia", "Potência", "T"],
      ["cf_forca", "Força", "T"],
      ["cf_compatibilidade", "Compatibilidade futura com classe e função", "T"],
    ],
  ],
  [
    "tec",
    "Técnica",
    "Técnica",
    15,
    false,
    "Vídeo de treino",
    [
      ["tec_boat_handling", "Boat handling", "T"],
      ["tec_velocidade", "Velocidade", "T"],
      ["tec_trim", "Trim", "T"],
      ["tec_manobras", "Manobras", "T"],
      ["tec_largada", "Largada", "T"],
      ["tec_adaptacao", "Adaptação a vento e onda", "T"],
    ],
  ],
  [
    "tat",
    "Tática e decisão",
    "Tática",
    10,
    false,
    "Observação em regata",
    [
      ["tat_leitura_vento", "Leitura do vento", "T"],
      ["tat_estrategia", "Estratégia", "T"],
      ["tat_posicionamento", "Posicionamento", "T"],
      ["tat_risco", "Gestão de risco", "T"],
      ["tat_adaptacao", "Adaptação tática", "T"],
    ],
  ],
  [
    "pot",
    "Potencial de desenvolvimento",
    "Potencial",
    5,
    false,
    "Comparação com o ciclo anterior",
    [
      ["pot_aprendizagem", "Taxa de aprendizagem", "T"],
      ["pot_feedback", "Resposta ao feedback", "T"],
      ["pot_evolucao", "Evolução em 12 a 24 meses", "T"],
    ],
  ],
  [
    "exp",
    "Experiência de alto rendimento",
    "Experiência",
    5,
    false,
    "Histórico competitivo",
    [["exp_alto_rendimento", "Experiência de alto rendimento", "T"]],
  ],
  [
    "men",
    "Perfil mental / autonomia",
    "Mental",
    10,
    true,
    "Observação em competição",
    [
      ["men_resiliencia", "Resiliência", "T"],
      ["men_disciplina", "Disciplina", "T"],
      ["men_autonomia", "Autonomia", "T"],
      ["men_competitividade", "Competitividade", "T"],
      ["men_controle_pressao", "Controle sob pressão", "T"],
    ],
  ],
  [
    "amb",
    "Ambiente de desenvolvimento",
    "Ambiente",
    10,
    true,
    "Questionário do atleta",
    [
      ["amb_apoio_familiar", "Apoio familiar ao projeto", "A"],
      ["amb_disponibilidade", "Disponibilidade para viagens e camps", "A"],
      ["amb_estabilidade", "Estabilidade de estudos ou trabalho", "A"],
      ["amb_autonomia", "Autonomia do atleta", "T"],
      ["amb_logistica", "Organização logística", "A"],
      ["amb_historico_familiar", "Histórico familiar de esporte de alto rendimento", "R"],
      ["amb_acesso_estrutura", "Acesso a treinador e estrutura", "A"],
    ],
  ],
  [
    "car",
    "Projeto de carreira",
    "Carreira",
    5,
    false,
    "Conversa de planejamento",
    [
      ["car_compromisso", "Compromisso", "T"],
      ["car_disponibilidade", "Horas disponíveis para a campanha", "A"],
      ["car_equipe_tecnica", "Equipe técnica", "A"],
      ["car_horizonte", "Horizonte de 2 a 4 anos", "T"],
    ],
  ],
];

export function pilaresDeTeste(): Pilar[] {
  return PILARES_BASE.map(([id, nome, nomeCurto, peso, sensivel, evidenciaPadrao, inds]) => ({
    id,
    nome,
    nomeCurto,
    peso,
    sensivel,
    evidenciaPadrao,
    indicadores: inds.map(([iid, inome, tipo]) => ({
      id: iid,
      pilarId: id,
      nome: inome,
      tipo,
      calculado: iid === "cf_peso_kg",
    })),
  }));
}

const CLASSES_BASE: [string, string, string, PosicaoClasse, number, number, number][] = [
  ["470-helm", "470 Helm", "470", "helm", 58.9, 62.5, 66.0],
  ["470-crew", "470 Crew", "470", "crew", 70.4, 73.6, 76.8],
  ["49er-helm", "49er Helm", "49er", "helm", 80.1, 81.7, 83.3],
  ["49er-crew", "49er Crew", "49er", "crew", 82.2, 83.8, 85.3],
  ["fx-helm", "49erFX Helm", "49erFX", "helm", 67.4, 69.3, 71.1],
  ["fx-crew", "49erFX Crew", "49erFX", "crew", 69.3, 71.5, 73.7],
  ["ilca6", "ILCA 6", "ILCA 6", "ind", 68.7, 72.0, 75.4],
  ["ilca7", "ILCA 7", "ILCA 7", "ind", 82.8, 84.5, 87.2],
  ["iqf-m", "iQFOiL M", "iQFOiL", "ind", 88.7, 90.4, 92.1],
  ["iqf-w", "iQFOiL W", "iQFOiL", "ind", 66.8, 70.1, 73.3],
  ["fk-m", "Formula Kite M", "Formula Kite", "ind", 93.3, 97.1, 110.9],
  ["fk-w", "Formula Kite W", "Formula Kite", "ind", 71.7, 75.1, 78.4],
  ["n17-helm", "Nacra 17 Helm", "Nacra 17", "helm", 68.3, 71.7, 75.1],
  ["n17-crew", "Nacra 17 Crew", "Nacra 17", "crew", 68.6, 71.4, 74.1],
];

export const CLASSES_TESTE: Classe[] = CLASSES_BASE.map(
  ([id, nome, evento, posicao, pesoMinKg, pesoMedioKg, pesoMaxKg]) => ({
    id,
    nome,
    evento,
    posicao,
    pesoMinKg,
    pesoMedioKg,
    pesoMaxKg,
  }),
);

export function classeDeTeste(id: string): Classe {
  const c = CLASSES_TESTE.find((x) => x.id === id);
  if (!c) throw new Error(`classe de teste inexistente: ${id}`);
  return c;
}

export const REGRAS_TESTE: Regras = {
  p3: { limites: [0.5, 1, 1.5, 2, 3] },
  g1: { aptoAte: 1, condicionalAte: 2 },
  g2: {
    mundialAptoAteFracao: 0.3,
    sulAmericanoCondicionalAtePosicao: 6,
    mundialCondicionalAteFracao: 0.5,
    brasileiroCondicionalAtePosicao: 3,
  },
  g3: { aptoMinEventos: 3, condicionalMinEventos: 1, janelaMeses: 24 },
  g4: {
    A: { status: "apto", motivo: "Plano e recursos para 36 meses" },
    B: { status: "apto", motivo: "Plano e recursos para 24 meses" },
    C: { status: "condicional", motivo: "Depende de apoio da CBVela" },
    D: { status: "alerta", motivo: "Sem estrutura para campanha internacional" },
  },
  rankingCbvela: { janelaSemanas: 52 },
  perfPontos: { ativa: false, faixas: [] },
};

export function parametrosDeTeste(): Parametros {
  return {
    pilares: pilaresDeTeste(),
    faixas: [
      { id: "f1", nome: "Prioridade de programa", nomeCurto: "Prioridade", scoreMin: 85 },
      { id: "f2", nome: "Alto potencial", nomeCurto: "Alto potencial", scoreMin: 75 },
      { id: "f3", nome: "Em desenvolvimento", nomeCurto: "Em desenvolvimento", scoreMin: 65 },
      { id: "f4", nome: "No radar", nomeCurto: "No radar", scoreMin: 0 },
    ],
    classes: CLASSES_TESTE.map((c) => ({ ...c })),
    regras: structuredClone(REGRAS_TESTE),
  };
}

export const REFERENCIA_TESTE = new Date("2026-11-06T12:00:00-03:00");

/** Todos os indicadores lançáveis (não R, não calculados) com a mesma nota. */
export function notasUniformes(valor: number | null): Record<string, number | null> {
  const notas: Record<string, number | null> = {};
  for (const p of pilaresDeTeste())
    for (const i of p.indicadores) if (i.tipo !== "R" && !i.calculado) notas[i.id] = valor;
  return notas;
}

export function resultadoDeTeste(parcial: Partial<ResultadoRegata> = {}): ResultadoRegata {
  return {
    nivel: "estadual",
    evento: "Evento de teste",
    data: "2026-05-30",
    posicao: 1,
    tamanhoFrota: 10,
    internacional: false,
    pontosCbvela: 0,
    ...parcial,
  };
}

export function entradaDeTeste(parcial: Partial<EntradaCalculo> = {}): EntradaCalculo {
  return {
    classe: classeDeTeste("ilca7"),
    pesoKg: 84.5,
    notas: notasUniformes(4),
    resultados: [],
    perfilSuporte: "B",
    decisoesGates: [null, null, null, null],
    referencia: REFERENCIA_TESTE,
    ...parcial,
  };
}

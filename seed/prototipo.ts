/**
 * Dados fictícios do protótipo (vela-front/src/lib/scout/engine.js, linhas 1-143),
 * portados de forma literal: a ordem das chamadas ao gerador pseudoaleatório e os
 * arredondamentos são idênticos, para reproduzir os mesmos atletas do protótipo.
 * Os parâmetros abaixo existem só para gerar o dado fictício; o sistema lê os
 * parâmetros reais do banco.
 */

export type TipoIndicadorProto = "T" | "A" | "R";
export type PerfilProto = "A" | "B" | "C" | "D";

export interface NotaProto {
  /** Nulo em indicador tipo R (registrado, não pontua). */
  valor: number | null;
  /** DD/MM/AAAA */
  data: string;
  evidencia: string;
  tipo: TipoIndicadorProto;
}

export interface ResultadoProto {
  /** Nome como no protótipo: Mundial, Sul-Americano, Europeu aberto, Brasileiro, Estadual, Regional. */
  nivel: string;
  evento: string;
  /** AAAA-MM-DD */
  data: string;
  posicao: number;
  tamanhoFrota: number;
  internacional: boolean;
  /** Nulo nos internacionais. */
  pontos: number | null;
}

export interface AtletaProto {
  /** a01..a14 */
  id: string;
  nome: string;
  genero: "F" | "M";
  /** AAAA-MM-DD */
  nascimento: string;
  classeId: string;
  clube: string;
  cidade: string;
  uf: string;
  /** Código VelaID (ex.: SC-T01). */
  velaId: string;
  numeroVela: string;
  treinador: string;
  pesoKg: number;
  alturaCm: number;
  perfilSuporte: PerfilProto;
  consentIbvar: boolean;
  emailContato: string;
  /** Só indicadores com lançamento; falta de nota = ausente. */
  notas: Record<string, NotaProto>;
  respostas: Record<string, string | null>;
  resultados: ResultadoProto[];
  /** Set e Out. */
  historico: { ciclo: string; score: number }[];
}

type IndicadorProto = [id: string, tipo: TipoIndicadorProto];
interface PilarProto {
  id: string;
  ind: IndicadorProto[];
}

const PESOS_PADRAO: Record<string, number> = {
  perf: 20,
  cf: 20,
  tec: 15,
  tat: 10,
  pot: 5,
  exp: 5,
  men: 10,
  amb: 10,
  car: 5,
};

const CLASSES = [
  { id: "470-helm", evento: "470", min: 58.9, med: 62.5, max: 66.0 },
  { id: "470-crew", evento: "470", min: 70.4, med: 73.6, max: 76.8 },
  { id: "49er-helm", evento: "49er", min: 80.1, med: 81.7, max: 83.3 },
  { id: "49er-crew", evento: "49er", min: 82.2, med: 83.8, max: 85.3 },
  { id: "fx-helm", evento: "49erFX", min: 67.4, med: 69.3, max: 71.1 },
  { id: "fx-crew", evento: "49erFX", min: 69.3, med: 71.5, max: 73.7 },
  { id: "ilca6", evento: "ILCA 6", min: 68.7, med: 72.0, max: 75.4 },
  { id: "ilca7", evento: "ILCA 7", min: 82.8, med: 84.5, max: 87.2 },
  { id: "iqf-m", evento: "iQFOiL", min: 88.7, med: 90.4, max: 92.1 },
  { id: "iqf-w", evento: "iQFOiL", min: 66.8, med: 70.1, max: 73.3 },
  { id: "fk-m", evento: "Formula Kite", min: 93.3, med: 97.1, max: 110.9 },
  { id: "fk-w", evento: "Formula Kite", min: 71.7, med: 75.1, max: 78.4 },
  { id: "n17-helm", evento: "Nacra 17", min: 68.3, med: 71.7, max: 75.1 },
  { id: "n17-crew", evento: "Nacra 17", min: 68.6, med: 71.4, max: 74.1 },
];

const PILARES: PilarProto[] = [
  {
    id: "perf",
    ind: [
      ["perf_mundial", "T"],
      ["perf_continental", "T"],
      ["perf_nacional", "T"],
      ["perf_consistencia", "T"],
      ["perf_nivel_frota", "T"],
    ],
  },
  {
    id: "cf",
    ind: [
      ["cf_peso_kg", "T"],
      ["cf_altura_cm", "T"],
      ["cf_composicao", "T"],
      ["cf_potencia", "T"],
      ["cf_forca", "T"],
      ["cf_compatibilidade", "T"],
    ],
  },
  {
    id: "tec",
    ind: [
      ["tec_boat_handling", "T"],
      ["tec_velocidade", "T"],
      ["tec_trim", "T"],
      ["tec_manobras", "T"],
      ["tec_largada", "T"],
      ["tec_adaptacao", "T"],
    ],
  },
  {
    id: "tat",
    ind: [
      ["tat_leitura_vento", "T"],
      ["tat_estrategia", "T"],
      ["tat_posicionamento", "T"],
      ["tat_risco", "T"],
      ["tat_adaptacao", "T"],
    ],
  },
  {
    id: "pot",
    ind: [
      ["pot_aprendizagem", "T"],
      ["pot_feedback", "T"],
      ["pot_evolucao", "T"],
    ],
  },
  { id: "exp", ind: [["exp_alto_rendimento", "T"]] },
  {
    id: "men",
    ind: [
      ["men_resiliencia", "T"],
      ["men_disciplina", "T"],
      ["men_autonomia", "T"],
      ["men_competitividade", "T"],
      ["men_controle_pressao", "T"],
    ],
  },
  {
    id: "amb",
    ind: [
      ["amb_apoio_familiar", "A"],
      ["amb_disponibilidade", "A"],
      ["amb_estabilidade", "A"],
      ["amb_autonomia", "T"],
      ["amb_logistica", "A"],
      ["amb_historico_familiar", "R"],
      ["amb_acesso_estrutura", "A"],
    ],
  },
  {
    id: "car",
    ind: [
      ["car_compromisso", "T"],
      ["car_disponibilidade", "A"],
      ["car_equipe_tecnica", "A"],
      ["car_horizonte", "T"],
    ],
  },
];

/** Opções [texto, nota]; nota nula = não pontua. */
const PERGUNTAS: Record<string, [string, number | null][]> = {
  amb_apoio_familiar: [
    ["Apoia totalmente", 5],
    ["Apoia em parte", 3],
    ["Apoia pouco", 1],
  ],
  amb_disponibilidade: [
    ["Sem restrição", 5],
    ["Algumas semanas por ano", 3],
    ["Muito pouco", 1],
  ],
  amb_estabilidade: [
    ["Sim, sem conflito", 5],
    ["Com ajustes", 3],
    ["Há conflito frequente", 1],
  ],
  amb_logistica: [
    ["Resolvo sozinho(a)", 5],
    ["Preciso de ajuda às vezes", 3],
    ["Dependo de outras pessoas", 1],
  ],
  amb_historico_familiar: [
    ["Sim", null],
    ["Não", null],
  ],
  amb_acesso_estrutura: [
    ["Treinador e base fixos", 5],
    ["Treinador eventual", 3],
    ["Sem treinador", 1],
  ],
  car_disponibilidade: [
    ["Mais de 20 h", 5],
    ["10 a 20 h", 3],
    ["Menos de 10 h", 1],
  ],
  car_equipe_tecnica: [
    ["Treinador e preparador físico", 5],
    ["Só treinador", 3],
    ["Ninguém fixo", 1],
  ],
};

const EVID: Record<string, string> = {
  perf: "Histórico competitivo",
  cf: "Avaliação física",
  tec: "Vídeo de treino",
  tat: "Observação em regata",
  pot: "Comparação com o ciclo anterior",
  exp: "Histórico competitivo",
  men: "Observação em competição",
  amb: "Questionário do atleta",
  car: "Conversa de planejamento",
};

type LinhaRaw = [
  id: string,
  nome: string,
  genero: "F" | "M",
  nasc: string,
  classe: string,
  clube: string,
  cidade: string,
  uf: string,
  vela: string,
  numeroVela: string,
  treinador: string,
  peso: number,
  altura: number,
  perfil: PerfilProto,
  base: number[],
];

const RAW: LinhaRaw[] = [
  [
    "a01",
    "Lívia Arruda",
    "F",
    "2006-03-14",
    "ilca6",
    "Clube Náutico Enseada",
    "Florianópolis",
    "SC",
    "SC-T01",
    "BRA 2214",
    "Ana Ribeiro",
    72.4,
    172,
    "B",
    [4.4, 4.6, 4.3, 4.0, 4.5, 3.8, 4.2, 4.0, 4.4],
  ],
  [
    "a02",
    "Caio Tavares",
    "M",
    "2005-07-02",
    "ilca7",
    "Veleiros da Lagoa",
    "Porto Alegre",
    "RS",
    "RS-T02",
    "BRA 2187",
    "Marcos Pires",
    84.1,
    186,
    "A",
    [4.0, 4.4, 4.1, 4.2, 3.6, 4.0, 3.8, 3.5, 4.0],
  ],
  [
    "a03",
    "Bianca Lemos",
    "F",
    "2007-01-20",
    "fx-helm",
    "Iate Clube Ponta Leste",
    "Rio de Janeiro",
    "RJ",
    "RJ-T03",
    "BRA 1903",
    "Ana Ribeiro",
    68.0,
    168,
    "C",
    [3.6, 4.0, 3.8, 3.4, 4.6, 2.8, 4.0, 3.2, 3.6],
  ],
  [
    "a04",
    "Marina Seixas",
    "F",
    "2006-09-11",
    "fx-crew",
    "Iate Clube Ponta Leste",
    "Rio de Janeiro",
    "RJ",
    "RJ-T04",
    "BRA 1903",
    "Ana Ribeiro",
    74.9,
    178,
    "C",
    [3.6, 3.2, 3.9, 3.5, 4.0, 2.8, 3.7, 3.4, 3.5],
  ],
  [
    "a05",
    "Rafael Quintela",
    "M",
    "2004-12-05",
    "49er-helm",
    "Clube de Vela Pedra Branca",
    "Niterói",
    "RJ",
    "RJ-T05",
    "BRA 1766",
    "Marcos Pires",
    81.0,
    182,
    "B",
    [4.2, 4.5, 4.4, 4.3, 3.8, 4.2, 4.1, 3.9, 4.2],
  ],
  [
    "a06",
    "Otávio Brandão",
    "M",
    "2005-04-28",
    "49er-crew",
    "Clube de Vela Pedra Branca",
    "Niterói",
    "RJ",
    "RJ-T06",
    "BRA 1766",
    "Marcos Pires",
    86.8,
    190,
    "B",
    [4.0, 3.6, 4.0, 3.8, 3.5, 4.0, 3.6, 3.4, 3.8],
  ],
  [
    "a07",
    "Helena Vasques",
    "F",
    "2008-02-17",
    "iqf-w",
    "Escola de Vela Maré Alta",
    "Ilhabela",
    "SP",
    "SP-T07",
    "BRA 707",
    "Ana Ribeiro",
    66.2,
    170,
    "C",
    [3.2, 4.3, 3.8, 3.3, 4.7, 2.2, 4.3, 3.0, 4.0],
  ],
  [
    "a08",
    "Davi Moretto",
    "M",
    "2003-10-09",
    "iqf-m",
    "Escola de Vela Maré Alta",
    "Ilhabela",
    "SP",
    "SP-T08",
    "BRA 88",
    "Marcos Pires",
    89.5,
    185,
    "A",
    [4.5, 4.7, 4.5, 4.4, 3.4, 4.6, 4.3, 4.2, 4.5],
  ],
  [
    "a09",
    "Isadora Prates",
    "F",
    "2006-06-23",
    "fk-w",
    "Kite Clube Barra Norte",
    "Fortaleza",
    "CE",
    "CE-T09",
    "BRA 19",
    "Ana Ribeiro",
    69.4,
    167,
    "D",
    [3.4, 2.6, 3.6, 3.2, 4.2, 2.6, 3.8, 2.8, 3.4],
  ],
  [
    "a10",
    "Tomás Albuquerque",
    "M",
    "2004-08-30",
    "fk-m",
    "Kite Clube Barra Norte",
    "Fortaleza",
    "CE",
    "CE-T10",
    "BRA 7",
    "Marcos Pires",
    96.0,
    188,
    "B",
    [3.8, 4.5, 3.9, 3.6, 3.7, 3.4, 3.5, 3.6, 3.7],
  ],
  [
    "a11",
    "Nina Cardoso",
    "F",
    "2005-11-03",
    "470-helm",
    "Iate Clube Lago Sul",
    "Brasília",
    "DF",
    "DF-T11",
    "BRA 470",
    "Ana Ribeiro",
    61.8,
    163,
    "C",
    [3.9, 4.6, 4.0, 4.1, 3.9, 3.5, 4.4, 4.1, 4.3],
  ],
  [
    "a12",
    "Pedro Viana",
    "M",
    "2005-02-14",
    "470-crew",
    "Iate Clube Lago Sul",
    "Brasília",
    "DF",
    "DF-T12",
    "BRA 470",
    "Ana Ribeiro",
    75.5,
    183,
    "B",
    [3.8, 4.5, 3.9, 3.9, 3.6, 3.5, 3.9, 4.0, 3.9],
  ],
  [
    "a13",
    "Larissa Fontes",
    "F",
    "2007-05-08",
    "n17-helm",
    "Veleiros da Lagoa",
    "Porto Alegre",
    "RS",
    "RS-T13",
    "BRA 117",
    "Marcos Pires",
    70.9,
    169,
    "C",
    [3.0, 4.2, 3.4, 3.2, 4.4, 2.4, 3.6, 2.6, 3.4],
  ],
  [
    "a14",
    "Gabriel Teles",
    "M",
    "2006-01-25",
    "n17-crew",
    "Veleiros da Lagoa",
    "Porto Alegre",
    "RS",
    "RS-T14",
    "BRA 117",
    "Marcos Pires",
    79.8,
    184,
    "D",
    [2.8, 2.2, 3.2, 3.0, 3.6, 2.0, 3.3, 3.0, 3.0],
  ],
];

const FALTANDO: Record<string, (id: string, tipo: TipoIndicadorProto) => boolean> = {
  a07: (id, tipo) =>
    (id.startsWith("amb_") || id.startsWith("car_")) && (tipo === "A" || tipo === "R"),
  a13: (id) => id.startsWith("tat_"),
  a09: (id) => id === "tec_trim" || id === "tec_largada",
};

function rng(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const fmt1 = (v: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const notaPeso = (rel: number) =>
  rel <= 0.5 ? 5 : rel <= 1 ? 4 : rel <= 1.5 ? 3 : rel <= 2 ? 2 : rel <= 3 ? 1 : 0;

function classeDe(id: string) {
  const c = CLASSES.find((x) => x.id === id);
  if (!c) throw new Error(`Classe ${id} desconhecida`);
  return c;
}

function distanciaRelativa(classeId: string, peso: number): number {
  const c = classeDe(classeId);
  return Math.abs(peso - c.med) / ((c.max - c.min) / 2);
}

function respostaPara(id: string, nota: number | null, r: () => number): string | null {
  const opcoes = PERGUNTAS[id];
  if (!opcoes) return null;
  if (nota == null) return opcoes[r() < 0.3 ? 0 : 1]![0];
  let melhor = opcoes[0]!;
  opcoes.forEach((o) => {
    if (o[1] != null && melhor[1] != null && Math.abs(o[1] - nota) < Math.abs(melhor[1] - nota))
      melhor = o;
  });
  return melhor[0];
}

function score(a: AtletaProto): number {
  let s = 0;
  PILARES.forEach((p) => {
    const vals = p.ind
      .filter((i) => i[1] !== "R")
      .map((i) => a.notas[i[0]]?.valor)
      .filter((v): v is number => v != null);
    if (vals.length) s += (vals.reduce((x, v) => x + v, 0) / vals.length / 5) * PESOS_PADRAO[p.id]!;
  });
  return s;
}

function gerar(): AtletaProto[] {
  const rascunhos = RAW.map((x, k) => {
    const [
      id,
      nome,
      genero,
      nasc,
      cls,
      clube,
      cidade,
      uf,
      vela,
      velaN,
      treinador,
      peso,
      altura,
      perfil,
      base,
    ] = x;
    const r = rng(1000 + k * 97);
    const a: AtletaProto = {
      id,
      nome,
      genero,
      nascimento: nasc,
      classeId: cls,
      clube,
      cidade,
      uf,
      velaId: vela,
      numeroVela: velaN,
      treinador,
      pesoKg: peso,
      alturaCm: altura,
      perfilSuporte: perfil,
      consentIbvar: id !== "a07",
      emailContato:
        nome.split(" ")[0]!.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "") + "@exemplo.com",
      notas: {},
      respostas: {},
      resultados: [],
      historico: [],
    };
    PILARES.forEach((p, pi) =>
      p.ind.forEach(([iid, tipo]) => {
        const falta = FALTANDO[id] && FALTANDO[id](iid, tipo);
        let v: number | null =
          tipo === "R" ? null : clamp(Math.round(base[pi]! + (r() - 0.5) * 1.6), 0, 5);
        if (iid === "cf_peso_kg") v = notaPeso(distanciaRelativa(cls, peso));
        const dia = 20 + Math.floor(r() * 16);
        const at = dia <= 31 ? `${dia}/10/2026` : `0${dia - 31}/11/2026`;
        if (falta) return;
        a.notas[iid] = {
          valor: v,
          data: at,
          evidencia: iid === "cf_peso_kg" ? `Pesagem: ${fmt1(peso)} kg` : EVID[p.id]!,
          tipo,
        };
        if (tipo === "A" || tipo === "R") a.respostas[iid] = respostaPara(iid, v, r);
      }),
    );
    const perf = base[0]!;
    const exp = base[5]!;
    const nIntl = exp >= 4 ? 3 : exp >= 3 ? 2 : exp >= 2.4 ? 1 : 0;
    const evento = classeDe(cls).evento;
    const nat = [
      {
        nivel: "Brasileiro",
        evento: `Brasileiro de ${evento}`,
        data: "2026-01-24",
        n: 22,
        cat: 200,
      },
      { nivel: "Estadual", evento: `Copa estadual ${uf}`, data: "2026-05-30", n: 14, cat: 100 },
      { nivel: "Regional", evento: "Regata regional · etapa 2", data: "2026-08-22", n: 9, cat: 50 },
    ].map((e) => {
      const pos = clamp(Math.round((5 - perf) * (e.n / 6) + 1 + (r() - 0.5) * 2), 1, e.n);
      return {
        nivel: e.nivel,
        evento: e.evento,
        data: e.data,
        n: e.n,
        pos,
        intl: false,
        pts: (((e.n - pos + 1) / e.n) * e.cat) as number | null,
      };
    });
    const intl = [
      { nivel: "Sul-Americano", evento: `Sul-Americano de ${evento}`, data: "2026-03-14", n: 18 },
      { nivel: "Mundial", evento: `Mundial de ${evento}`, data: "2026-07-18", n: 60 },
      { nivel: "Europeu aberto", evento: `Europeu aberto de ${evento}`, data: "2026-09-12", n: 80 },
    ]
      .slice(0, nIntl)
      .map((e) => {
        const k2 = e.n === 18 ? 4 : e.n === 60 ? 16 : 22;
        const pos = clamp(
          Math.round((5 - perf) * k2 + (e.n === 18 ? 1 : 4) + (r() - 0.5) * 4),
          1,
          e.n,
        );
        return {
          nivel: e.nivel,
          evento: e.evento,
          data: e.data,
          n: e.n,
          pos,
          intl: true,
          pts: null as number | null,
        };
      });
    a.resultados = [...nat, ...intl]
      .sort((p, q) => q.data.localeCompare(p.data))
      .map((e) => ({
        nivel: e.nivel,
        evento: e.evento,
        data: e.data,
        posicao: e.pos,
        tamanhoFrota: e.n,
        internacional: e.intl,
        pontos: e.pts,
      }));
    const d: [number, number] = [r() * 4 - 1, r() * 4 - 1];
    return { a, d };
  });

  return rascunhos.map(({ a, d }) => {
    const s = score(a);
    a.historico = [
      { ciclo: "Set", score: clamp(s - d[0] - d[1], 0, 100) },
      { ciclo: "Out", score: clamp(s - d[0], 0, 100) },
    ];
    return a;
  });
}

export const ATLETAS_PROTOTIPO: AtletaProto[] = gerar();

export const MESES_ASSEGURADOS: Record<PerfilProto, number> = { A: 36, B: 24, C: 12, D: 0 };
export const PATROCINIO: Record<PerfilProto, "sim" | "em_negociacao" | "nao"> = {
  A: "sim",
  B: "em_negociacao",
  C: "nao",
  D: "nao",
};

/** VELAID_MOCK do protótipo: cadastros do VelaID que ainda não estão no piloto (Sofia Lins tem 17 anos). */
export const VELAID_EXTRAS: {
  codigo: string;
  nome: string;
  genero: "F" | "M";
  nascimento: string;
  clube: string;
  cidade: string;
  uf: string;
  wsId: string | null;
  email: string;
}[] = [
  {
    codigo: "MG-T15",
    nome: "Renata Bastos",
    genero: "F",
    nascimento: "2005-08-19",
    clube: "Clube Náutico Lagoa Azul",
    cidade: "Lagoa Santa",
    uf: "MG",
    wsId: "BRARB51",
    email: "renata@exemplo.com",
  },
  {
    codigo: "BA-T16",
    nome: "Felipe Guedes",
    genero: "M",
    nascimento: "2004-03-02",
    clube: "Iate Clube Baía Clara",
    cidade: "Salvador",
    uf: "BA",
    wsId: "BRAFG77",
    email: "felipe@exemplo.com",
  },
  {
    codigo: "PE-T17",
    nome: "Sofia Lins",
    genero: "F",
    nascimento: "2009-06-10",
    clube: "Clube de Vela Recife Antigo",
    cidade: "Recife",
    uf: "PE",
    wsId: null,
    email: "sofia@exemplo.com",
  },
];

/** autonomia(a, i) do protótipo para o componente de custo i (0 a 7), já em minúsculas e sem acento. */
export function autonomiaComponente(
  perfil: PerfilProto,
  i: number,
): { autonomia: "alta" | "parcial" | "baixa"; apoioCbvela: "baixa" | "media" | "alta" } {
  switch (perfil) {
    case "A":
      return { autonomia: "alta", apoioCbvela: "baixa" };
    case "B":
      return i % 3 === 0
        ? { autonomia: "parcial", apoioCbvela: "media" }
        : { autonomia: "alta", apoioCbvela: "baixa" };
    case "C":
      return i % 2
        ? { autonomia: "baixa", apoioCbvela: "alta" }
        : { autonomia: "parcial", apoioCbvela: "media" };
    case "D":
      return { autonomia: "baixa", apoioCbvela: "alta" };
  }
}

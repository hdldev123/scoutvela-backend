import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface AtletaGabarito {
  velaid: string;
  score: number;
  faixa: string;
  notas: Record<string, number | null>;
  resultados: { nivel: string; data: string; posicao: number }[];
  pontosCbvela: number;
  gates: { status: string; motivo: string }[];
  statusFinal: string;
}

const gabarito = JSON.parse(
  readFileSync(new URL("../fixtures/prototipo.json", import.meta.url), "utf8"),
) as {
  atletas: AtletaGabarito[];
};

const STATUS_FINAL: Record<string, string> = {
  apto: "apto",
  cond: "condicional",
  nao: "nao_prioritario",
};
const STATUS_GATE: Record<string, string> = {
  apto: "apto",
  cond: "condicional",
  alerta: "alerta",
  nao: "alerta",
};
// O protótipo escreve "internacionalis" no plural do G3 (erro de grafia); o domínio gera "internacionais".
const corrigir = (motivo: string) => motivo.replace("internacionalis", "internacionais");

/**
 * O protótipo digitava as notas de perf_mundial, perf_continental e perf_nacional; desde a D10 elas saem
 * dos resultados validados (PERF_RESULTADOS, valores provisórios do exemplo da reunião de 23/11). Aqui o
 * score esperado é o do gabarito trocando só essas três notas, recalculadas por um oráculo independente
 * do domínio: melhor colocação entre as 4 edições mais recentes do nível, sem olhar a frota.
 *   mundial e continental: até o 3º = 5, até o 10º = 4, até o 25º = 3, demais = 2
 *   nacional: 1º = 5, 2º = 4, 3º = 3, fora do pódio = 0
 * Sem resultado no nível, o indicador fica sem nota.
 */
const NIVEL_DA_NOTA: Record<string, "mundial" | "continental" | "nacional"> = {
  Mundial: "mundial",
  "Sul-Americano": "continental",
  Brasileiro: "nacional",
};
const TABELA: Record<string, [number, number][]> = {
  mundial: [
    [3, 5],
    [10, 4],
    [25, 3],
  ],
  continental: [
    [3, 5],
    [10, 4],
    [25, 3],
  ],
  nacional: [
    [1, 5],
    [2, 4],
    [3, 3],
  ],
};
const FUNDO: Record<string, number> = { mundial: 2, continental: 2, nacional: 0 };
const INDICADOR: Record<string, string> = {
  mundial: "perf_mundial",
  continental: "perf_continental",
  nacional: "perf_nacional",
};

function notaDoNivel(g: AtletaGabarito, nivel: string): number | null {
  const doNivel = g.resultados
    .filter((r) => NIVEL_DA_NOTA[r.nivel] === nivel)
    .sort((a, b) => b.data.localeCompare(a.data))
    .slice(0, 4);
  if (doNivel.length === 0) return null;
  const melhor = Math.min(...doNivel.map((r) => r.posicao));
  return (TABELA[nivel]!.find(([ate]) => melhor <= ate)?.[1] ?? FUNDO[nivel])!;
}

function scoreEsperado(g: AtletaGabarito): number {
  const PERF = [
    "perf_mundial",
    "perf_continental",
    "perf_nacional",
    "perf_consistencia",
    "perf_nivel_frota",
  ];
  const media = (notas: Record<string, number | null>) => {
    const v = PERF.map((i) => notas[i]).filter((x): x is number => x != null);
    return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
  };
  const novas = { ...g.notas };
  for (const nivel of Object.keys(INDICADOR)) novas[INDICADOR[nivel]!] = notaDoNivel(g, nivel);
  const contrib = (m: number | null) => (m == null ? 0 : (m / 5) * 20);
  return g.score - contrib(media(g.notas)) + contrib(media(novas));
}

const faixaEsperada = (score: number) =>
  score >= 85 ? "f1" : score >= 75 ? "f2" : score >= 65 ? "f3" : "f4";

describe("paridade com o protótipo (via API)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
  });
  afterAll(() => p.encerrar());

  it("ranking do gestor segue a ordem do gabarito", async () => {
    const r = await p.app.inject({
      method: "GET",
      url: "/ranking",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    expect(r.statusCode).toBe(200);
    const itens = r.json().itens as { atleta: { velaid: string } }[];
    const esperada = [...gabarito.atletas]
      .sort((a, b) => scoreEsperado(b) - scoreEsperado(a))
      .map((a) => a.velaid);
    expect(itens.map((i) => i.atleta.velaid)).toEqual(esperada);
  });

  for (const g of gabarito.atletas) {
    it(`${g.velaid}: score, faixa, gates e pontos batem`, async () => {
      const id = await p.idDe(g.velaid);
      const r = await p.app.inject({
        method: "GET",
        url: `/atletas/${id}`,
        headers: await p.como(EMAILS_DEMO.gestor),
      });
      expect(r.statusCode).toBe(200);
      const f = r.json();
      expect(f.score).toBeCloseTo(scoreEsperado(g), 9);
      expect(f.faixa.id).toBe(faixaEsperada(scoreEsperado(g)));
      expect(f.pontosCbvela).toBeCloseTo(g.pontosCbvela, 1); // o banco guarda os pontos de cada regata com 2 casas
      expect(f.gates.statusFinal).toBe(STATUS_FINAL[g.statusFinal] ?? g.statusFinal);
      expect(f.gates.itens).toHaveLength(4);
      f.gates.itens.forEach((item: { status: string; motivo: string }, i: number) => {
        const esperado = g.gates[i]!;
        expect(item.status).toBe(STATUS_GATE[esperado.status] ?? esperado.status);
        expect(item.motivo).toBe(corrigir(esperado.motivo));
      });
    });
  }
});

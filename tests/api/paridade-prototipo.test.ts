import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface AtletaGabarito {
  velaid: string;
  score: number;
  faixa: string;
  pontosCbvela: number;
  gates: { status: string; motivo: string }[];
  statusFinal: string;
}

const gabarito = JSON.parse(readFileSync(new URL("../fixtures/prototipo.json", import.meta.url), "utf8")) as {
  atletas: AtletaGabarito[];
};

const STATUS_FINAL: Record<string, string> = { apto: "apto", cond: "condicional", nao: "nao_prioritario" };
const STATUS_GATE: Record<string, string> = { apto: "apto", cond: "condicional", alerta: "alerta", nao: "alerta" };
// O protótipo escreve "internacionalis" no plural do G3 (erro de grafia); o domínio gera "internacionais".
const corrigir = (motivo: string) => motivo.replace("internacionalis", "internacionais");

describe("paridade com o protótipo (via API)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
  });
  afterAll(() => p.encerrar());

  it("ranking do gestor segue a ordem do gabarito", async () => {
    const r = await p.app.inject({ method: "GET", url: "/ranking", headers: await p.como(EMAILS_DEMO.gestor) });
    expect(r.statusCode).toBe(200);
    const itens = r.json().itens as { atleta: { velaid: string } }[];
    const esperada = [...gabarito.atletas].sort((a, b) => b.score - a.score).map((a) => a.velaid);
    expect(itens.map((i) => i.atleta.velaid)).toEqual(esperada);
  });

  for (const g of gabarito.atletas) {
    it(`${g.velaid}: score, faixa, gates e pontos batem`, async () => {
      const id = await p.idDe(g.velaid);
      const r = await p.app.inject({ method: "GET", url: `/atletas/${id}`, headers: await p.como(EMAILS_DEMO.gestor) });
      expect(r.statusCode).toBe(200);
      const f = r.json();
      expect(f.score).toBeCloseTo(g.score, 9);
      expect(f.faixa.id).toBe(g.faixa);
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

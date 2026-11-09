import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { calcularAtleta } from "../../src/domain/index.js";
import type { NivelCompeticao, PerfilSuporte, ResultadoRegata } from "../../src/domain/index.js";
import { classeDeTeste, parametrosDeTeste, REFERENCIA_TESTE } from "../apoio/parametros-teste.js";

interface AtletaGabarito {
  velaid: string;
  nome: string;
  classe: string;
  peso: number;
  perfilSuporte: PerfilSuporte;
  score: number;
  faixa: string;
  pontosCbvela: number;
  gates: { status: string; motivo: string }[];
  statusFinal: string;
  notas: Record<string, number | null>;
  resultados: {
    nivel: string; evento: string; data: string; posicao: number;
    tamanhoFrota: number; internacional: boolean; pontos: number | null;
  }[];
}

const gabarito = JSON.parse(
  readFileSync(new URL("../fixtures/prototipo.json", import.meta.url), "utf8"),
) as { atletas: AtletaGabarito[] };

const NIVEIS: Record<string, NivelCompeticao> = {
  Mundial: "mundial",
  "Sul-Americano": "sul_americano",
  "Europeu aberto": "internacional_aberto",
  Brasileiro: "brasileiro",
  Estadual: "estadual",
  Regional: "regional",
};
const STATUS_FINAL: Record<string, string> = { apto: "apto", cond: "condicional", nao: "nao_prioritario" };

// O protótipo escreve "internacionalis" no plural do G3 (erro de grafia); a porta usa "internacionais".
const corrigir = (motivo: string) => motivo.replace("internacionalis", "internacionais");

describe("gabarito do protótipo", () => {
  const parametros = parametrosDeTeste();

  it("tem os 14 atletas", () => {
    expect(gabarito.atletas).toHaveLength(14);
  });

  for (const a of gabarito.atletas) {
    it(`${a.velaid} ${a.nome} reproduz o protótipo`, () => {
      const notasLancadas = { ...a.notas };
      delete notasLancadas.cf_peso_kg;
      const resultados: ResultadoRegata[] = a.resultados.map((r) => ({
        nivel: NIVEIS[r.nivel] as NivelCompeticao,
        evento: r.evento,
        data: r.data,
        posicao: r.posicao,
        tamanhoFrota: r.tamanhoFrota,
        internacional: r.internacional,
        pontosCbvela: r.pontos,
      }));

      const r = calcularAtleta(parametros, {
        classe: classeDeTeste(a.classe),
        pesoKg: a.peso,
        notas: notasLancadas,
        resultados,
        perfilSuporte: a.perfilSuporte,
        decisoesGates: [null, null, null, null],
        referencia: REFERENCIA_TESTE,
      });

      expect(r.score).toBeCloseTo(a.score, 9);
      expect(r.faixa.id).toBe(a.faixa);
      expect(r.gates.map((g) => g.status)).toEqual(
        a.gates.map((g) => (g.status === "cond" ? "condicional" : g.status)),
      );
      expect(r.gates.map((g) => g.motivo)).toEqual(a.gates.map((g) => corrigir(g.motivo)));
      expect(r.statusFinal).toBe(STATUS_FINAL[a.statusFinal] ?? a.statusFinal);
      expect(r.pontosCbvela).toBeCloseTo(a.pontosCbvela, 9);
      expect(r.notas.cf_peso_kg).toBe(a.notas.cf_peso_kg);
    });
  }
});

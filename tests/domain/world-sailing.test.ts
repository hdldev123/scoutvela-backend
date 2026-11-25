import { describe, expect, it } from "vitest";
import {
  cortarNoFimDaPalavra,
  linkPerfilWorldSailing,
  nivelDaRegata,
  nomeDoEvento,
  resultadosParaGravar,
  type RegraWsNiveis,
} from "../../src/domain/world-sailing.js";

const REGRA: RegraWsNiveis = {
  niveis: {
    "Olympic Games": "mundial",
    "World Championships": "mundial",
    "Sailing World Championships": "mundial",
    "Youth Sailing World Championships": "mundial",
    Continental: "continental",
    "Campeonato Brasileiro": "brasileiro",
  },
};

describe("domínio World Sailing (D19)", () => {
  describe("nivelDaRegata (regra WS_NIVEIS)", () => {
    it("mapeia o nome do nível pela regra", () => {
      expect(nivelDaRegata("World Championships", REGRA)).toBe("mundial");
      expect(nivelDaRegata("Youth Sailing World Championships", REGRA)).toBe("mundial");
      expect(nivelDaRegata("Continental", REGRA)).toBe("continental");
    });

    it("sem diferença de caixa nem de espaços nas pontas", () => {
      expect(nivelDaRegata("  world championships ", REGRA)).toBe("mundial");
    });

    it("nível nulo, vazio ou fora da regra vira internacional_aberto", () => {
      expect(nivelDaRegata(null, REGRA)).toBe("internacional_aberto");
      expect(nivelDaRegata("", REGRA)).toBe("internacional_aberto");
      expect(nivelDaRegata("Sailing World Cup Series", REGRA)).toBe("internacional_aberto");
      expect(nivelDaRegata("constructor", REGRA)).toBe("internacional_aberto");
      expect(nivelDaRegata("__proto__", REGRA)).toBe("internacional_aberto");
    });
  });

  describe("resultadosParaGravar", () => {
    const perfil = {
      wsId: "BRA TESTE/1",
      resultados: [
        {
          ref: "r1",
          evento: "Mundial  Fictício",
          classe: "ILCA 6",
          nivelWs: "World Championships",
          data: "2025-08-04",
          posicao: 3,
        },
        {
          ref: "r2",
          evento: "Troféu Fictício",
          classe: "ILCA 6",
          nivelWs: null,
          data: "2026-04-05",
          posicao: 5,
        },
        {
          ref: "r3",
          evento: "Brasileiro Fictício",
          classe: "ILCA 6",
          nivelWs: "Campeonato Brasileiro",
          data: "2024-11-10",
          posicao: 1,
        },
        { ref: "r4", evento: "Sem data", classe: "ILCA 6", nivelWs: null, data: "", posicao: 4 },
        {
          ref: "r5",
          evento: "Sem colocação",
          classe: "ILCA 6",
          nivelWs: null,
          data: "2026-01-01",
          posicao: 0,
        },
      ],
    };

    it("monta as linhas com nível, evento '<regata> (<classe>)', edição, frota nula e link do perfil", () => {
      const linhas = resultadosParaGravar(perfil, REGRA);
      expect(linhas).toHaveLength(3);
      expect(linhas[0]).toEqual({
        nivel: "mundial",
        evento: "Mundial Fictício (ILCA 6)",
        data: "2025-08-04",
        edicao: 2025,
        posicao: 3,
        tamanhoFrota: null,
        internacional: true,
        linkOficial: "https://www.sailing.org/sailor/?ref=BRA%20TESTE%2F1",
        fonte: "world_sailing",
        wsRef: "r1",
      });
    });

    it("nível nulo vira internacional_aberto; brasileiro não é internacional", () => {
      const linhas = resultadosParaGravar(perfil, REGRA);
      expect(linhas[1]).toMatchObject({ nivel: "internacional_aberto", internacional: true });
      expect(linhas[2]).toMatchObject({ nivel: "brasileiro", internacional: false });
    });

    it("ignora resultado sem data válida ou sem colocação positiva", () => {
      const refs = resultadosParaGravar(perfil, REGRA).map((l) => l.wsRef);
      expect(refs).toEqual(["r1", "r2", "r3"]);
    });
  });

  it("nomeDoEvento limita o tamanho mantendo a classe", () => {
    const nome = nomeDoEvento("X".repeat(400), "ILCA 6");
    expect(nome.length).toBeLessThanOrEqual(200);
    expect(nome.endsWith(" (ILCA 6)")).toBe(true);
  });

  it("linkPerfilWorldSailing codifica o ID", () => {
    expect(linkPerfilWorldSailing("GBRHM15")).toBe("https://www.sailing.org/sailor/?ref=GBRHM15");
  });

  describe("cortarNoFimDaPalavra", () => {
    it("não mexe em texto curto", () => {
      expect(cortarNoFimDaPalavra("  oi, tudo bem  ", 500)).toBe("oi, tudo bem");
    });

    it("corta no fim de uma palavra, sem passar do limite", () => {
      const texto = "palavra ".repeat(100);
      const cortado = cortarNoFimDaPalavra(texto, 500);
      expect(cortado.length).toBeLessThanOrEqual(500);
      expect(cortado.endsWith("palavra")).toBe(true);
    });

    it("sem espaço aproveitável, corta seco", () => {
      expect(cortarNoFimDaPalavra("a".repeat(900), 500)).toHaveLength(500);
    });
  });
});

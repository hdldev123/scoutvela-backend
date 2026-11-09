import { describe, expect, it } from "vitest";
import {
  aplicarDecisoes,
  calcularAtleta,
  gatesAutomaticos,
  statusFinal,
} from "../../src/domain/index.js";
import type { EntradaCalculo, ResultadoRegata } from "../../src/domain/index.js";
import {
  classeDeTeste,
  entradaDeTeste,
  parametrosDeTeste,
  resultadoDeTeste,
} from "../apoio/parametros-teste.js";

const parametros = parametrosDeTeste();
const gate = (n: number, parcial: Partial<EntradaCalculo> = {}, p = parametros) =>
  gatesAutomaticos(p, entradaDeTeste(parcial))[n - 1]!;

const intl = (nivel: ResultadoRegata["nivel"], posicao: number, tamanhoFrota: number, data = "2026-07-18") =>
  resultadoDeTeste({ nivel, posicao, tamanhoFrota, data, internacional: true, pontosCbvela: null });
const nac = (nivel: ResultadoRegata["nivel"], posicao: number, data = "2026-01-24") =>
  resultadoDeTeste({ nivel, posicao, tamanhoFrota: 20, data });

describe("G1 Class Fit", () => {
  // ILCA 7: média 84,5; meia faixa 2,2
  it("apto dentro da faixa, com delta e sinal +", () => {
    expect(gate(1, { pesoKg: 85.7 })).toEqual({
      gate: 1, status: "apto", motivo: "Dentro da faixa da classe (+1,2 kg da média)",
    });
  });
  it("apto no limite (rel = 1)", () => {
    expect(gate(1, { pesoKg: 86.7 }).status).toBe("apto");
  });
  it("condicional com leve desvio", () => {
    expect(gate(1, { pesoKg: 87.0 })).toMatchObject({
      status: "condicional", motivo: "Leve desvio: +2,5 kg da média da classe",
    });
  });
  it("alerta fora da faixa, com sinal de menos (U+2212)", () => {
    expect(gate(1, { pesoKg: 79.5 })).toMatchObject({
      status: "alerta", motivo: "Fora da faixa: −5,0 kg da média da classe",
    });
  });
  it("sem peso, alerta", () => {
    expect(gate(1, { pesoKg: null })).toMatchObject({ status: "alerta", motivo: "Sem pesagem registrada" });
  });
  it("usa os limites dos parâmetros", () => {
    const p = parametrosDeTeste();
    p.regras.g1 = { aptoAte: 0.1, condicionalAte: 0.2 };
    expect(gate(1, { pesoKg: 85.7 }, p).status).toBe("alerta");
  });
});

describe("G2 Evidência competitiva", () => {
  it("apto: Mundial no terço superior (≤ 30% da frota)", () => {
    expect(gate(2, { resultados: [intl("mundial", 18, 60)] })).toMatchObject({
      status: "apto", motivo: "18º de 60 no Mundial da classe",
    });
  });
  it("condicional: Sul-Americano até a 6ª posição", () => {
    expect(gate(2, { resultados: [intl("sul_americano", 6, 18)] })).toMatchObject({
      status: "condicional", motivo: "6º no Sul-Americano",
    });
  });
  it("Sul-Americano vem antes do Mundial condicional", () => {
    const r = [intl("mundial", 30, 60), intl("sul_americano", 2, 18, "2026-03-14")];
    expect(gate(2, { resultados: r }).motivo).toBe("2º no Sul-Americano");
  });
  it("condicional: Mundial até a metade da frota", () => {
    expect(gate(2, { resultados: [intl("mundial", 30, 60)] })).toMatchObject({
      status: "condicional", motivo: "30º de 60 no Mundial",
    });
  });
  it("condicional: Brasileiro até 3º, sem experiência internacional", () => {
    expect(gate(2, { resultados: [nac("brasileiro", 3)] })).toMatchObject({
      status: "condicional", motivo: "3º no Brasileiro",
    });
  });
  it("Brasileiro com experiência internacional", () => {
    const r = [nac("brasileiro", 2), intl("internacional_aberto", 40, 80)];
    expect(gate(2, { resultados: r }).motivo).toBe("2º no Brasileiro, com experiência internacional");
  });
  it("alerta sem evidência relevante", () => {
    const r = [nac("brasileiro", 4), intl("mundial", 40, 60), intl("sul_americano", 7, 18)];
    expect(gate(2, { resultados: r })).toMatchObject({
      status: "alerta", motivo: "Sem evidência relevante fora do circuito nacional",
    });
  });
  it("usa o resultado mais recente de cada nível", () => {
    const r = [intl("mundial", 50, 60, "2025-07-18"), intl("mundial", 10, 60, "2026-07-18")];
    expect(gate(2, { resultados: r }).motivo).toBe("10º de 60 no Mundial da classe");
    expect(gate(2, { resultados: [...r].reverse() }).motivo).toBe("10º de 60 no Mundial da classe");
  });
  it("usa os limites dos parâmetros", () => {
    const p = parametrosDeTeste();
    p.regras.g2.mundialAptoAteFracao = 0.1;
    expect(gate(2, { resultados: [intl("mundial", 18, 60)] }, p).status).toBe("condicional");
  });
});

describe("G3 Alto rendimento", () => {
  const eventos = (n: number) =>
    Array.from({ length: n }, (_, i) => intl("internacional_aberto", 10, 50, `2026-0${i + 1}-15`));
  it("apto com 3 eventos", () => {
    expect(gate(3, { resultados: eventos(3) })).toMatchObject({
      status: "apto", motivo: "3 eventos internacionais em 24 meses",
    });
  });
  it("condicional com 1 e com 2 eventos (singular e plural)", () => {
    expect(gate(3, { resultados: eventos(1) })).toMatchObject({
      status: "condicional", motivo: "1 evento internacional em 24 meses",
    });
    expect(gate(3, { resultados: eventos(2) })).toMatchObject({
      status: "condicional", motivo: "2 eventos internacionais em 24 meses",
    });
  });
  it("alerta sem eventos; nacionais não contam", () => {
    expect(gate(3, { resultados: [nac("brasileiro", 1)] })).toMatchObject({
      status: "alerta", motivo: "Nenhum evento internacional em 24 meses",
    });
  });
  it("janela de 24 meses: início exclusivo, fim inclusivo", () => {
    // referência 2026-11-06 → início 2024-11-06 (exclusivo)
    const dentro = intl("mundial", 1, 10, "2024-11-07");
    const borda = intl("mundial", 1, 10, "2024-11-06");
    const fora = intl("mundial", 1, 10, "2024-11-05");
    const hoje = intl("mundial", 1, 10, "2026-11-06");
    const futuro = intl("mundial", 1, 10, "2026-11-07");
    expect(gate(3, { resultados: [dentro] }).status).toBe("condicional");
    expect(gate(3, { resultados: [borda, fora] }).status).toBe("alerta");
    expect(gate(3, { resultados: [hoje] }).status).toBe("condicional");
    expect(gate(3, { resultados: [futuro] }).status).toBe("alerta");
  });
  it("usa a janela e os mínimos dos parâmetros", () => {
    const p = parametrosDeTeste();
    p.regras.g3 = { aptoMinEventos: 2, condicionalMinEventos: 1, janelaMeses: 6 };
    const r = [intl("mundial", 1, 10, "2026-09-01"), intl("mundial", 1, 10, "2026-07-01"), intl("mundial", 1, 10, "2025-01-01")];
    expect(gate(3, { resultados: r }, p)).toMatchObject({
      status: "apto", motivo: "2 eventos internacionais em 6 meses",
    });
  });
});

describe("G4 Campanha", () => {
  it("segue o perfil de suporte configurado", () => {
    expect(gate(4, { perfilSuporte: "A" })).toMatchObject({ status: "apto", motivo: "Plano e recursos para 36 meses" });
    expect(gate(4, { perfilSuporte: "B" })).toMatchObject({ status: "apto", motivo: "Plano e recursos para 24 meses" });
    expect(gate(4, { perfilSuporte: "C" })).toMatchObject({ status: "condicional", motivo: "Depende de apoio da CBVela" });
    expect(gate(4, { perfilSuporte: "D" })).toMatchObject({ status: "alerta", motivo: "Sem estrutura para campanha internacional" });
  });
  it("sem perfil, alerta", () => {
    expect(gate(4, { perfilSuporte: null })).toMatchObject({
      status: "alerta", motivo: "Financeiro da campanha ainda não informado",
    });
  });
  it("devolve sempre 4 gates numerados", () => {
    expect(gatesAutomaticos(parametros, entradaDeTeste()).map((g) => g.gate)).toEqual([1, 2, 3, 4]);
  });
});

describe("aplicarDecisoes", () => {
  const sugestoes = gatesAutomaticos(parametros, entradaDeTeste({ perfilSuporte: "D" }));
  it("decisão do gestor substitui o status e preserva motivo e sugestão", () => {
    const g = aplicarDecisoes(sugestoes, [null, null, null, "apto"]);
    expect(g[3]).toEqual({
      gate: 4, status: "apto", motivo: "Sem estrutura para campanha internacional",
      sugestaoAutomatica: "alerta", ajustadoPeloGestor: true,
    });
    expect(g[0]).toMatchObject({ ajustadoPeloGestor: false, sugestaoAutomatica: g[0]!.status });
  });
  it("decisão muda o status final no cálculo do atleta", () => {
    const base = entradaDeTeste({ perfilSuporte: "D" });
    expect(calcularAtleta(parametros, base).statusFinal).toBe("nao_prioritario");
    const r = calcularAtleta(parametros, { ...base, decisoesGates: [null, "apto", "apto", "apto"] });
    expect(r.statusFinal).toBe("apto");
    expect(r.gates[1]!.ajustadoPeloGestor).toBe(true);
  });
});

describe("statusFinal (P7)", () => {
  const g = (...s: ("apto" | "condicional" | "alerta")[]) => s.map((status) => ({ status }));
  it("qualquer alerta → não prioritário", () => {
    expect(statusFinal(g("apto", "condicional", "alerta", "apto"))).toBe("nao_prioritario");
  });
  it("sem alerta e com condicional → condicional", () => {
    expect(statusFinal(g("apto", "condicional", "apto", "apto"))).toBe("condicional");
  });
  it("todos aptos → apto", () => {
    expect(statusFinal(g("apto", "apto", "apto", "apto"))).toBe("apto");
  });
});

describe("classe do atleta nos gates", () => {
  it("G1 usa a classe recebida", () => {
    const g = gate(1, { classe: classeDeTeste("fk-m"), pesoKg: 97.1 });
    expect(g.motivo).toBe("Dentro da faixa da classe (+0,0 kg da média)");
  });
});

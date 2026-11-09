import { describe, expect, it } from "vitest";
import { sugerirPlano, type EntradaSugestaoPlano } from "../../src/domain/index.js";

const base: EntradaSugestaoPlano = {
  pilares: [
    { nome: "Performance esportiva", nota: 4 },
    { nome: "Class Fit", nota: 5 },
    { nome: "Técnica", nota: 2 },
    { nome: "Tática e decisão", nota: 3 },
    { nome: "Potencial", nota: 1 },
  ],
  temResultadoMundial: false,
  statusFinal: "condicional",
  gatesNaoAptos: ["Class Fit", "Campanha"],
  perfilSuporte: "B",
  faixaNome: "Alto potencial",
};

describe("sugerirPlano", () => {
  it("forças são os 2 pilares de maior nota e lacunas os 2 de menor", () => {
    const p = sugerirPlano(base);
    expect(p.forcas).toBe("Class Fit, Performance esportiva");
    expect(p.lacunas).toBe("Potencial, Técnica");
  });

  it("meta de 12 meses depende de resultado de nível 'mundial'", () => {
    expect(sugerirPlano({ ...base, temResultadoMundial: true }).meta12m).toBe("Top 10 no Mundial da classe");
    expect(sugerirPlano(base).meta12m).toBe("Primeiro Mundial da classe, top 50%");
  });

  it("meta de 24 meses: campanha completa se apto, senão fechar os gates abertos", () => {
    expect(sugerirPlano({ ...base, statusFinal: "apto", gatesNaoAptos: [] }).meta24m).toBe(
      "Campanha completa no circuito internacional",
    );
    expect(sugerirPlano(base).meta24m).toBe("Fechar os gates em aberto: Class Fit, Campanha");
  });

  it("recomendação inclui apoio para perfil C ou D", () => {
    expect(sugerirPlano(base).recomendacao).toBe("Alto potencial");
    expect(sugerirPlano({ ...base, perfilSuporte: "C" }).recomendacao).toBe(
      "Alto potencial, com apoio para viagens e equipamento",
    );
    expect(sugerirPlano({ ...base, perfilSuporte: "D" }).recomendacao).toContain("com apoio para viagens");
    expect(sugerirPlano({ ...base, perfilSuporte: null }).recomendacao).toBe("Alto potencial");
  });

  it("sem nenhuma nota, aguarda a primeira avaliação", () => {
    const p = sugerirPlano({ ...base, pilares: base.pilares.map((x) => ({ ...x, nota: null })) });
    expect(p.forcas).toBe("Aguardando a primeira avaliação");
    expect(p.lacunas).toBe("Aguardando a primeira avaliação");
  });

  it("poucas notas: lacunas não repetem as forças", () => {
    const p = sugerirPlano({ ...base, pilares: [{ nome: "A", nota: 3 }, { nome: "B", nota: 4 }, { nome: "C", nota: null }] });
    expect(p.forcas).toBe("B, A");
    expect(p.lacunas).toBe("Aguardando mais avaliações");
  });
});

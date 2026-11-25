import { describe, expect, it } from "vitest";
import { mesPassaporteValido, normalizarTelefone, ultimoDiaDoMes } from "../../src/domain/index.js";

describe("telefone E.164", () => {
  it("remove espaços, parênteses, traços e pontos", () => {
    expect(normalizarTelefone("+55 (11) 99999-8888")).toBe("+5511999998888");
    expect(normalizarTelefone("+1 415.555.2671")).toBe("+14155552671");
  });

  it("só com DDD brasileiro, prefixa +55", () => {
    expect(normalizarTelefone("(11) 99999-8888")).toBe("+5511999998888");
    expect(normalizarTelefone("21 3333-4444")).toBe("+552133334444");
  });

  it("recusa o que não é telefone", () => {
    for (const t of [
      "",
      "abc",
      "123",
      "+0123456789",
      "+55",
      "99999-8888",
      "+55 11 9999a8888",
      "+1234567890123456",
    ]) {
      expect(normalizarTelefone(t), t).toBeNull();
    }
  });
});

describe("validade do passaporte", () => {
  it("aceita AAAA-MM e recusa mês fora de 01 a 12", () => {
    expect(mesPassaporteValido("2027-03")).toBe(true);
    expect(mesPassaporteValido("2027-00")).toBe(false);
    expect(mesPassaporteValido("2027-13")).toBe(false);
    expect(mesPassaporteValido("2027-3")).toBe(false);
    expect(mesPassaporteValido("2027-03-31")).toBe(false);
    expect(mesPassaporteValido("1999-12")).toBe(false);
  });

  it("grava o último dia do mês, inclusive em ano bissexto", () => {
    expect(ultimoDiaDoMes("2027-03")).toBe("2027-03-31");
    expect(ultimoDiaDoMes("2028-02")).toBe("2028-02-29");
    expect(ultimoDiaDoMes("2027-02")).toBe("2027-02-28");
    expect(ultimoDiaDoMes("2027-04")).toBe("2027-04-30");
    expect(ultimoDiaDoMes("2027-12")).toBe("2027-12-31");
  });
});

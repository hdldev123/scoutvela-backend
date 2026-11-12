import { describe, expect, it } from "vitest";
import { base32Codificar, base32Decodificar, hotp, novoSegredoTotp, totp, verificarTotp } from "../../dev/totp.js";

const SEGREDO = Buffer.from("12345678901234567890", "ascii");

describe("HOTP (RFC 4226)", () => {
  it("bate com os vetores do apêndice D", () => {
    const esperado = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
    esperado.forEach((codigo, i) => expect(hotp(SEGREDO, i)).toBe(codigo));
  });
});

describe("TOTP (RFC 6238, SHA-1, 8 dígitos)", () => {
  it("bate com os vetores do apêndice B", () => {
    const vetores: Array<[number, string]> = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [t, codigo] of vetores) expect(totp(SEGREDO, t * 1000, { digitos: 8 })).toBe(codigo);
  });
});

describe("base32 (RFC 4648)", () => {
  it("codifica e decodifica os vetores da RFC", () => {
    const vetores: Array<[string, string]> = [
      ["f", "MY"],
      ["fo", "MZXQ"],
      ["foo", "MZXW6"],
      ["foob", "MZXW6YQ"],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI"],
    ];
    for (const [txt, b32] of vetores) {
      expect(base32Codificar(Buffer.from(txt))).toBe(b32);
      expect(base32Decodificar(b32).toString()).toBe(txt);
    }
  });

  it("ida e volta com bytes aleatórios; decodificação ignora caixa", () => {
    const seg = novoSegredoTotp();
    expect(seg).toHaveLength(20);
    const b32 = base32Codificar(seg);
    expect(base32Decodificar(b32.toLowerCase()).equals(seg)).toBe(true);
  });

  it("rejeita caractere inválido", () => {
    expect(() => base32Decodificar("MZXW6!")).toThrow();
    expect(() => base32Decodificar("MZXW1")).toThrow();
  });
});

describe("verificarTotp", () => {
  const t0 = 1_700_000_000_000;
  const passoDe = (ms: number) => Math.floor(ms / 30000);

  it("aceita o passo atual e ±1 e devolve o número do passo", () => {
    expect(verificarTotp(SEGREDO, totp(SEGREDO, t0), t0)).toBe(passoDe(t0));
    expect(verificarTotp(SEGREDO, totp(SEGREDO, t0 - 30000), t0)).toBe(passoDe(t0) - 1);
    expect(verificarTotp(SEGREDO, totp(SEGREDO, t0 + 30000), t0)).toBe(passoDe(t0) + 1);
  });

  it("recusa ±2 passos", () => {
    expect(verificarTotp(SEGREDO, totp(SEGREDO, t0 - 60000), t0)).toBeNull();
    expect(verificarTotp(SEGREDO, totp(SEGREDO, t0 + 60000), t0)).toBeNull();
  });

  it("recusa código malformado", () => {
    for (const c of ["", "12345", "1234567", "abcdef", "12 456", "١٢٣٤٥٦"]) {
      expect(verificarTotp(SEGREDO, c, t0)).toBeNull();
    }
  });
});

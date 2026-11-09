import { describe, expect, it } from "vitest";
import { colunasProibidas, ErroCsv, lerCsv, linhaComoObjeto, normalizarColuna } from "../../src/importacao/csv.js";
import { lerData } from "../../src/importacao/comum.js";
import { validarLinhaRanking } from "../../src/importacao/ranking.js";
import { validarLinhaVelaId } from "../../src/importacao/velaid.js";

describe("lerCsv", () => {
  it("detecta ';' e ','", () => {
    expect(lerCsv("a;b;c\n1;2;3").separador).toBe(";");
    expect(lerCsv("a,b,c\n1,2,3").separador).toBe(",");
    expect(lerCsv("a;b;c\n1;2;3").linhas).toEqual([["1", "2", "3"]]);
  });

  it("aceita BOM, CRLF, CR e linhas em branco; último registro sem quebra", () => {
    const r = lerCsv("﻿a;b\r\n1;2\r\n\r\n3;4\r5;6");
    expect(r.cabecalho).toEqual(["a", "b"]);
    expect(r.linhas).toEqual([["1", "2"], ["3", "4"], ["5", "6"]]);
  });

  it("aspas: separador e quebra dentro do campo, e escape com aspas duplas", () => {
    const r = lerCsv('a,b\n"x, y","diz ""oi"""\n"linha1\nlinha2",z');
    expect(r.linhas).toEqual([["x, y", 'diz "oi"'], ["linha1\nlinha2", "z"]]);
  });

  it("apara espaços fora de aspas e preserva dentro", () => {
    expect(lerCsv("a;b\n  x  ;\"  y  \"").linhas).toEqual([["x", "  y  "]]);
  });

  it("células vazias e linhas curtas", () => {
    const r = lerCsv("a;b;c\n1;;3\n4");
    expect(r.linhas).toEqual([["1", "", "3"], ["4"]]);
    expect(linhaComoObjeto(r.cabecalho, r.linhas[1]!)).toEqual({ a: "4", b: "", c: "" });
  });

  it("normaliza o cabeçalho (caixa, acento, espaço)", () => {
    expect(lerCsv("Código;Data Nascimento;E-mail\n").cabecalho).toEqual(["codigo", "data_nascimento", "e_mail"]);
    expect(normalizarColuna("  Endereço ")).toBe("endereco");
  });

  it("rejeita vazio, aspas abertas, coluna sem nome e repetida", () => {
    expect(() => lerCsv("")).toThrow(ErroCsv);
    expect(() => lerCsv(" \n ")).toThrow(ErroCsv);
    expect(() => lerCsv('a;b\n"abc;1')).toThrow(/aspas/);
    expect(() => lerCsv("a;;c\n1;2;3")).toThrow(/sem nome/);
    expect(() => lerCsv("a;A;c\n1;2;3")).toThrow(/repetidas/);
  });

  it("só cabeçalho -> nenhuma linha", () => {
    expect(lerCsv("a;b\n").linhas).toEqual([]);
  });
});

describe("colunasProibidas", () => {
  it("acha cpf, rg, documento, endereço e renda em qualquer caixa e com acento", () => {
    const cab = lerCsv("CPF;Rg;Documento;Endereço;RENDA;nome\n").cabecalho;
    expect(colunasProibidas(cab)).toEqual(["cpf", "rg", "documento", "endereco", "renda"]);
    expect(colunasProibidas(["nome", "cidade"])).toEqual([]);
  });
});

describe("lerData", () => {
  it("aceita as duas formas e recusa datas impossíveis", () => {
    expect(lerData("2026-10-31")).toBe("2026-10-31");
    expect(lerData("31/10/2026")).toBe("2026-10-31");
    expect(lerData("29/02/2024")).toBe("2024-02-29");
    for (const ruim of ["31/02/2026", "2026-13-01", "2026/10/31", "1/1/2026", "", "abc"]) expect(lerData(ruim), ruim).toBeNull();
  });
});

describe("validação de linhas", () => {
  const hoje = "2026-11-06";
  const velaid = { codigo: "mg-t15", nome: "Ana", genero: "feminino", data_nascimento: "01/02/2000" };

  it("VelaID: normaliza e valida", () => {
    expect(validarLinhaVelaId(velaid, hoje)).toMatchObject({ codigo: "MG-T15", genero: "F", dataNascimento: "2000-02-01", clube: null, uf: null });
    expect(validarLinhaVelaId({ ...velaid, genero: "x" }, hoje)).toMatch(/Gênero/);
    expect(validarLinhaVelaId({ ...velaid, data_nascimento: "2030-01-01" }, hoje)).toMatch(/fora do intervalo/);
    expect(validarLinhaVelaId({ ...velaid, uf: "RIO" }, hoje)).toMatch(/UF/);
    expect(validarLinhaVelaId({ ...velaid, email: "sem-arroba" }, hoje)).toMatch(/E-mail/);
    expect(validarLinhaVelaId({ ...velaid, nome: "A" }, hoje)).toMatch(/Nome/);
  });

  const rk = { velaid: "sc-t01", nivel: "Brasileiro", evento: "Campeonato", data: "10/10/2026", posicao: "3", tamanho_frota: "20", pontos: "12,5" };

  it("Ranking: normaliza e valida", () => {
    expect(validarLinhaRanking(rk, hoje)).toEqual({ velaid: "SC-T01", nivel: "brasileiro", evento: "Campeonato", data: "2026-10-10", posicao: 3, tamanhoFrota: 20, pontos: 12.5 });
    expect(validarLinhaRanking({ ...rk, nivel: "mundial" }, hoje)).toMatch(/Nível/);
    expect(validarLinhaRanking({ ...rk, posicao: "21" }, hoje)).toMatch(/maior que o tamanho/);
    expect(validarLinhaRanking({ ...rk, posicao: "0" }, hoje)).toMatch(/Posição/);
    expect(validarLinhaRanking({ ...rk, pontos: "-1" }, hoje)).toMatch(/Pontos/);
    expect(validarLinhaRanking({ ...rk, data: "2027-01-01" }, hoje)).toMatch(/futuro/);
  });
});

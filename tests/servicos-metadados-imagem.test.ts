import { describe, expect, it } from "vitest";
import {
  ImagemInvalida,
  removerMetadadosImagem,
  removerMetadadosJpeg,
  removerMetadadosPng,
} from "../src/servicos/metadados-imagem.js";
import { chunkPng, jpegValido, pngValido, segmentoJpeg } from "./apoio/imagens.js";

const GPS = "GPS -22.9068 -43.1729 Niteroi";
const exif = () => segmentoJpeg(0xe1, Buffer.from(`Exif\0\0${GPS}`, "latin1"));
const xmp = () =>
  segmentoJpeg(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${GPS}`, "latin1"));
const iptc = () => segmentoJpeg(0xed, Buffer.from(`Photoshop 3.0\0${GPS}`, "latin1"));
const comentario = () => segmentoJpeg(0xfe, Buffer.from(GPS, "latin1"));
const icc = () => segmentoJpeg(0xe2, Buffer.from("ICC_PROFILE\0perfil", "latin1"));

describe("removerMetadadosJpeg", () => {
  it("remove APP1 (Exif e XMP), APP13 e COM, e preserva o resto da imagem", () => {
    const original = jpegValido({ extras: [exif(), xmp(), icc(), iptc(), comentario()] });
    expect(original.includes(GPS)).toBe(true);
    const limpo = Buffer.from(removerMetadadosJpeg(original));
    expect(limpo.includes("GPS")).toBe(false);
    expect(limpo.includes("Exif")).toBe(false);
    expect(limpo.includes("Photoshop")).toBe(false);
    // A assinatura continua válida e o perfil ICC segue lá.
    expect([...limpo.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
    expect(limpo.includes("ICC_PROFILE")).toBe(true);
    // Sem metadados, a saída é igual a uma imagem que nunca os teve (pixels e tabelas idênticos).
    const semNada = jpegValido({ extras: [icc()] });
    expect(limpo.equals(Buffer.from(removerMetadadosJpeg(semNada)))).toBe(true);
    expect(limpo.equals(semNada)).toBe(true);
    // Termina no EOI.
    expect([...limpo.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("descarta o que vem depois do EOI (miniatura ou dado escondido)", () => {
    const original = jpegValido({ depoisDoEoi: Buffer.from(`${GPS} escondido`) });
    const limpo = Buffer.from(removerMetadadosJpeg(original));
    expect(limpo.includes("escondido")).toBe(false);
    expect([...limpo.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it("não confunde FF 00 dos dados da varredura com marcador", () => {
    const original = jpegValido({ tamanho: 200 });
    const limpo = Buffer.from(removerMetadadosJpeg(original));
    expect(limpo.equals(original)).toBe(true);
  });

  it("recusa arquivo que não é JPEG ou está truncado", () => {
    expect(() =>
      removerMetadadosJpeg(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a])),
    ).toThrow(ImagemInvalida);
    expect(() => removerMetadadosJpeg(Buffer.from("GIF89a....."))).toThrow(ImagemInvalida);
  });
});

describe("removerMetadadosPng", () => {
  it("remove eXIf, tEXt, iTXt e zTXt, mantendo os demais chunks com o CRC original", () => {
    const original = pngValido({
      extras: [
        chunkPng("eXIf", Buffer.from(GPS)),
        chunkPng("tEXt", Buffer.from(`Comment\0${GPS}`)),
        chunkPng("iTXt", Buffer.from(`XML:com.adobe.xmp\0${GPS}`)),
        chunkPng("zTXt", Buffer.from(`Comment\0\0${GPS}`)),
        chunkPng("gAMA", Buffer.from([0, 1, 0x86, 0xa0])),
      ],
    });
    expect(original.includes("GPS")).toBe(true);
    const limpo = Buffer.from(removerMetadadosPng(original));
    expect(limpo.includes("GPS")).toBe(false);
    for (const t of ["eXIf", "tEXt", "iTXt", "zTXt"]) expect(limpo.includes(t)).toBe(false);
    expect([...limpo.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    // Igual a um PNG sem os chunks de metadado (gAMA e seu CRC intactos).
    const esperado = pngValido({ extras: [chunkPng("gAMA", Buffer.from([0, 1, 0x86, 0xa0]))] });
    expect(limpo.equals(esperado)).toBe(true);
  });

  it("descarta o que vem depois do IEND e recusa PNG truncado", () => {
    const limpo = Buffer.from(removerMetadadosPng(pngValido({ depoisDoIend: Buffer.from(GPS) })));
    expect(limpo.includes("GPS")).toBe(false);
    expect(() => removerMetadadosPng(pngValido().subarray(0, 40))).toThrow(ImagemInvalida);
  });
});

describe("removerMetadadosImagem", () => {
  it("PDF não é alterado", () => {
    const pdf = Buffer.from("%PDF-1.7\n/Author (Fulana)\n");
    expect(removerMetadadosImagem(pdf, "application/pdf")).toBe(pdf);
  });
});

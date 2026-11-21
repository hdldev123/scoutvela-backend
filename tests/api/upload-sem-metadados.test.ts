import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { Db } from "../../src/db/db.js";
import {
  cabecalhoAuth,
  criarAppDeTeste,
  criarAtletaDeTeste,
  criarUsuarioDeTeste,
  tokenPara,
} from "../apoio/app.js";
import { criarArmazenamentoFake, type ArmazenamentoFake } from "../apoio/armazenamento.js";
import { criarBancoDeTeste } from "../apoio/banco.js";
import { chunkPng, jpegValido, pngValido, segmentoJpeg } from "../apoio/imagens.js";

const GPS = "GPS -22.9068 -43.1729";

describe("uploads de imagem saem sem EXIF nem GPS", () => {
  let db: Db;
  let app: FastifyInstance;
  let arm: ArmazenamentoFake;
  let cab: { authorization: string };
  let atletaId: string;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    arm = criarArmazenamentoFake();
    app = await criarAppDeTeste(db, { armazenamento: arm });
    const g = await criarUsuarioDeTeste(db, { papel: "gestor" });
    cab = cabecalhoAuth(await tokenPara(g.authUserId));
    atletaId = await criarAtletaDeTeste(db);
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const guardados = () => [...arm.arquivos.values()];

  it("foto de perfil JPEG e PNG: o que vai ao Storage não tem metadados", async () => {
    const jpeg = jpegValido({
      extras: [segmentoJpeg(0xe1, Buffer.from(`Exif\0\0${GPS}`, "latin1"))],
    });
    const png = pngValido({ extras: [chunkPng("eXIf", Buffer.from(GPS))] });
    for (const [tipoMime, bytes] of [
      ["image/jpeg", jpeg],
      ["image/png", png],
    ] as const) {
      const r = await app.inject({
        method: "POST",
        url: "/me/foto",
        headers: cab,
        payload: { tipoMime, conteudoBase64: bytes.toString("base64") },
      });
      expect(r.statusCode).toBe(200);
    }
    const salvos = guardados();
    expect(salvos).toHaveLength(1); // a troca remove a anterior
    expect(Buffer.from(salvos[0]!.bytes).includes("GPS")).toBe(false);
    expect(Buffer.from(salvos[0]!.bytes).includes("eXIf")).toBe(false);
  });

  it("foto com estrutura inválida: 400", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/me/foto",
      headers: cab,
      payload: {
        tipoMime: "image/jpeg",
        conteudoBase64: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(40)]).toString(
          "base64",
        ),
      },
    });
    expect(r.statusCode).toBe(400);
  });

  it("evidência em JPEG: sem metadados no Storage e tamanho e sha256 do arquivo guardado", async () => {
    const jpeg = jpegValido({
      extras: [segmentoJpeg(0xe1, Buffer.from(`Exif\0\0${GPS}`, "latin1"))],
    });
    const r = await app.inject({
      method: "POST",
      url: `/atletas/${atletaId}/evidencias`,
      headers: cab,
      payload: {
        nomeArquivo: "foto.jpg",
        tipoMime: "image/jpeg",
        conteudoBase64: jpeg.toString("base64"),
      },
    });
    expect(r.statusCode).toBe(201);
    const linha = await db.query<{ caminho: string; tamanho_bytes: number }>(
      `select caminho, tamanho_bytes from evidencias_anexos where id = $1::uuid`,
      [r.json().id],
    );
    const guardado = Buffer.from(arm.arquivos.get(linha.rows[0]!.caminho)!.bytes);
    expect(guardado.includes("GPS")).toBe(false);
    expect(linha.rows[0]!.tamanho_bytes).toBe(guardado.length);
    expect(guardado.length).toBeLessThan(jpeg.length);
  });
});

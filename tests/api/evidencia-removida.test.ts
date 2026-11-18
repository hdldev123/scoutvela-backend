import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("evidência removida", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const chamar = async (metodo: "GET" | "POST", url: string, corpo?: unknown) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: await p.como(EMAILS_DEMO.gestor),
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("evidência removida: lista com removidoEm e o link devolve 410 sem chamar o Storage", async () => {
    const id = await p.idDe("RJ-T05");
    const enviado = await chamar("POST", `/atletas/${id}/evidencias`, {
      nomeArquivo: "laudo.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
    });
    expect(enviado.status).toBe(201);
    const anexo = enviado.corpo.id as string;
    const lista = await chamar("GET", `/atletas/${id}/evidencias`);
    expect(lista.corpo.anexos[0].removidoEm).toBeNull();

    await p.db.query(
      "update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido' where id = $1",
      [anexo],
    );
    const depois = await chamar("GET", `/atletas/${id}/evidencias`);
    expect(depois.corpo.anexos[0]).toMatchObject({ nomeArquivo: "removido" });
    expect(depois.corpo.anexos[0].removidoEm).toEqual(expect.any(String));

    // Se o Storage fosse chamado, o fake responderia 503.
    p.armazenamento.falhar = true;
    const link = await chamar("GET", `/evidencias/${anexo}/link`);
    p.armazenamento.falhar = false;
    expect(link.status).toBe(410);
    expect(link.corpo.erro).toBe("evidencia_removida");
  });
});

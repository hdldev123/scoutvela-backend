import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";
import { jpegValido, pngValido } from "../apoio/imagens.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]); // 73 bytes
const TAMANHO_PDF = 73;
// Cota de teste: cabem 3 PDFs de 73 bytes (219), o quarto passa de 230.
const COTA = 230;

describe("D11: atleta anexa arquivos", () => {
  let p: Piloto;
  let helena: string; // SP-T07, conta de atleta, da treinadora Ana
  let livia: string; // SC-T01, da Ana, outro atleta

  beforeAll(async () => {
    p = await criarPiloto(AGORA, { config: { COTA_ANEXOS_BYTES: COTA } });
    [helena, livia] = await Promise.all([p.idDe("SP-T07"), p.idDe("SC-T01")]);
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    metodo: "GET" | "POST" | "DELETE",
    url: string,
    corpo?: object,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: email ? await p.como(email) : {},
      ...(corpo ? { payload: corpo } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const enviar = (email: string | null, id: string, extra: Record<string, unknown> = {}) =>
    chamar(email, "POST", `/atletas/${id}/evidencias`, {
      nomeArquivo: "doc.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
      ...extra,
    });
  const apagarTudoDe = async (id: string) => {
    const lista = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}/evidencias`);
    for (const a of lista.corpo.anexos) {
      if (!a.removidoEm) await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${a.id}`);
    }
  };

  it("atleta envia no próprio cadastro (201), com categoria padrão e papel de quem enviou", async () => {
    const r = await enviar(EMAILS_DEMO.atleta, helena);
    expect(r.status).toBe(201);
    expect(r.corpo).toMatchObject({ categoria: "evidencia", enviadoPor: { papel: "atleta" } });
    expect(JSON.stringify(r.corpo)).not.toContain("@");
    const caminho = (
      await p.db.query<{ caminho: string }>("select caminho from evidencias_anexos where id = $1", [
        r.corpo.id,
      ])
    ).rows[0]!.caminho;
    expect(caminho.startsWith(`${helena}/`)).toBe(true);
    expect(p.armazenamento.arquivos.has(caminho)).toBe(true);
    await apagarTudoDe(helena);
  });

  it("atleta no cadastro de outro atleta: 404; IBVAR 403; sem token 401; categoria inválida 400", async () => {
    expect((await enviar(EMAILS_DEMO.atleta, livia)).status).toBe(404);
    expect((await enviar(EMAILS_DEMO.ibvar, helena)).status).toBe(403);
    expect((await enviar(null, helena)).status).toBe(401);
    const invalida = await enviar(EMAILS_DEMO.atleta, helena, { categoria: "documento" });
    expect(invalida.status).toBe(400);
    expect(invalida.corpo.campos[0].campo).toBe("categoria");
    const n = await p.db.query<{ n: string }>(
      "select count(*)::text as n from evidencias_anexos where atleta_id in ($1, $2) and removido_em is null",
      [helena, livia],
    );
    expect(n.rows[0]!.n).toBe("0");
  });

  it("mantém as proteções: assinatura conferida, EXIF removido, tamanho máximo", async () => {
    const falso = await enviar(EMAILS_DEMO.atleta, helena, {
      conteudoBase64: Buffer.from("nao e pdf").toString("base64"),
    });
    expect(falso.status).toBe(400);
    const png = await enviar(EMAILS_DEMO.atleta, helena, {
      nomeArquivo: "balanca.png",
      tipoMime: "image/png",
      conteudoBase64: pngValido().toString("base64"),
      categoria: "balanca",
    });
    expect(png.status).toBe(201);
    expect(png.corpo.categoria).toBe("balanca");
    const jpg = await enviar(EMAILS_DEMO.atleta, helena, {
      nomeArquivo: "sumula.jpg",
      tipoMime: "image/jpeg",
      conteudoBase64: jpegValido().toString("base64"),
      categoria: "sumula",
    });
    expect(jpg.status).toBe(201);
    await apagarTudoDe(helena);
  });

  it("auditoria do envio do atleta leva só ids, categoria, tipo e tamanho", async () => {
    const r = await enviar(EMAILS_DEMO.atleta, helena, { categoria: "sumula" });
    expect(r.status).toBe(201);
    const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
      "select detalhes from auditoria where acao = 'anexar_evidencia' and entidade_id = $1 order by id desc limit 1",
      [helena],
    );
    expect(aud.rows[0]!.detalhes).toEqual({
      anexoId: r.corpo.id,
      tipoMime: "application/pdf",
      tamanhoBytes: TAMANHO_PDF,
      categoria: "sumula",
      indicadorId: null,
    });
    await apagarTudoDe(helena);
  });

  it("cota por atleta: acima dela, 413 cota_excedida; remover libera espaço; outro atleta não é afetado", async () => {
    const a = await enviar(EMAILS_DEMO.atleta, helena);
    const b = await enviar(EMAILS_DEMO.gestor, helena); // a cota conta todos os anexos do atleta
    const b2 = await enviar(EMAILS_DEMO.treinadora, helena);
    expect([a.status, b.status, b2.status]).toEqual([201, 201, 201]);
    const c = await enviar(EMAILS_DEMO.atleta, helena);
    expect(c.status).toBe(413);
    expect(c.corpo.erro).toBe("cota_excedida");
    expect(c.corpo.mensagem).toMatch(/limite de \d+ MB/);
    const total = await p.db.query<{ n: string }>(
      "select count(*)::text as n from evidencias_anexos where atleta_id = $1 and removido_em is null",
      [helena],
    );
    expect(total.rows[0]!.n).toBe("3");

    const outro = await enviar(EMAILS_DEMO.gestor, livia);
    expect(outro.status).toBe(201);

    const lista = await chamar(EMAILS_DEMO.atleta, "GET", `/atletas/${helena}/evidencias`);
    expect(lista.corpo).toMatchObject({ usoBytes: 3 * TAMANHO_PDF, cotaBytes: COTA });

    expect((await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${a.corpo.id}`)).status).toBe(
      204,
    );
    expect((await enviar(EMAILS_DEMO.atleta, helena)).status).toBe(201);
    await apagarTudoDe(helena);
    await apagarTudoDe(livia);
  });

  it("remoção pelo atleta: livre 204; ligada a nota 409; anexo de outro atleta 404; enviado por outra pessoa 403", async () => {
    const livre = await enviar(EMAILS_DEMO.atleta, helena);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${livre.corpo.id}`)).status,
    ).toBe(204);
    const removido = await p.db.query<{ removido_em: Date | null; nome_arquivo: string }>(
      "select removido_em, nome_arquivo from evidencias_anexos where id = $1",
      [livre.corpo.id],
    );
    expect(removido.rows[0]!.removido_em).not.toBeNull();
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'remover_anexo' and entidade_id = $1 order by id desc limit 1",
      [helena],
    );
    expect(aud.rows[0]!.detalhes).toEqual({ anexoId: livre.corpo.id, origem: "usuario" });

    const ligada = await enviar(EMAILS_DEMO.atleta, helena);
    const nota = await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${helena}/avaliacoes`, {
      notas: [{ indicadorId: "tec_largada", valor: 4, anexoId: ligada.corpo.id }],
    });
    expect(nota.status).toBe(201);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${ligada.corpo.id}`)).status,
    ).toBe(409);

    const deOutro = await enviar(EMAILS_DEMO.gestor, livia);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${deOutro.corpo.id}`)).status,
    ).toBe(404);

    const doGestor = await enviar(EMAILS_DEMO.gestor, helena);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${doGestor.corpo.id}`)).status,
    ).toBe(403);
    expect(
      (await chamar(EMAILS_DEMO.ibvar, "DELETE", `/evidencias/${doGestor.corpo.id}`)).status,
    ).toBe(403);
    await apagarTudoDe(livia);
  });

  it("listagem traz categoria e quem enviou (papel), aceita filtro e recusa categoria inválida; IBVAR 403", async () => {
    await apagarTudoDe(helena);
    await enviar(EMAILS_DEMO.atleta, helena, { categoria: "balanca" });
    await enviar(EMAILS_DEMO.gestor, helena, { categoria: "sumula" });
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
      const todos = await chamar(email, "GET", `/atletas/${helena}/evidencias`);
      expect(todos.status).toBe(200);
      const ativos = todos.corpo.anexos.filter((a: { removidoEm: string | null }) => !a.removidoEm);
      expect(
        ativos.map((a: { categoria: string; enviadoPor: { papel: string } }) => [
          a.categoria,
          a.enviadoPor.papel,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["balanca", "atleta"],
          ["sumula", "gestor"],
        ]),
      );
      expect(JSON.stringify(todos.corpo)).not.toContain("@");

      const filtrados = await chamar(
        email,
        "GET",
        `/atletas/${helena}/evidencias?categoria=balanca`,
      );
      expect(filtrados.status).toBe(200);
      expect(
        filtrados.corpo.anexos.every((a: { categoria: string }) => a.categoria === "balanca"),
      ).toBe(true);
      expect(filtrados.corpo.anexos.length).toBeGreaterThan(0);
    }
    expect(
      (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${helena}/evidencias?categoria=x`)).status,
    ).toBe(400);
    expect((await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${helena}/evidencias`)).status).toBe(
      403,
    );
    expect((await chamar(EMAILS_DEMO.atleta, "GET", `/atletas/${livia}/evidencias`)).status).toBe(
      404,
    );
    expect((await chamar(null, "GET", `/atletas/${helena}/evidencias`)).status).toBe(401);
  });

  it("o atleta abre o link do próprio anexo; o de outro atleta dá 404", async () => {
    await apagarTudoDe(helena);
    await apagarTudoDe(livia);
    const meu = await enviar(EMAILS_DEMO.atleta, helena);
    const dele = await enviar(EMAILS_DEMO.gestor, livia);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "GET", `/evidencias/${meu.corpo.id}/link`)).status,
    ).toBe(200);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "GET", `/evidencias/${dele.corpo.id}/link`)).status,
    ).toBe(404);
    await apagarTudoDe(helena);
    await apagarTudoDe(livia);
  });

  it("a limpeza diária não apaga anexo enviado pelo atleta nem de outra categoria", async () => {
    const { limparAnexosNaoVinculados } = await import("../../src/jobs/limpar-anexos.js");
    await apagarTudoDe(helena);
    const doAtleta = await enviar(EMAILS_DEMO.atleta, helena);
    const sumula = await enviar(EMAILS_DEMO.gestor, helena, { categoria: "sumula" });
    const evidencia = await enviar(EMAILS_DEMO.gestor, livia);
    const r = await limparAnexosNaoVinculados({
      db: p.db,
      armazenamento: p.armazenamento,
      agora: new Date("2026-11-08T12:00:00-03:00"),
    });
    expect(r.removidos).toBeGreaterThanOrEqual(1);
    const estado = async (id: string) =>
      (
        await p.db.query<{ removido_em: Date | null }>(
          "select removido_em from evidencias_anexos where id = $1",
          [id],
        )
      ).rows[0]!.removido_em;
    expect(await estado(doAtleta.corpo.id)).toBeNull();
    expect(await estado(sumula.corpo.id)).toBeNull();
    expect(await estado(evidencia.corpo.id)).not.toBeNull();
    await apagarTudoDe(helena);
    await apagarTudoDe(livia);
  });
});

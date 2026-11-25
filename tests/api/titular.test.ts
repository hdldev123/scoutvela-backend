import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { jpegValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("direitos do titular (LGPD)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    metodo: "GET" | "POST" | "PUT",
    url: string,
    corpo?: unknown,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: await p.como(email),
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.json(), headers: r.headers, texto: r.body };
  };

  it("exporta os dados do próprio atleta como anexo e audita", async () => {
    const r = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toBe(
      'attachment; filename="meus-dados-scout-vela.json"',
    );
    expect(r.corpo.atleta.nome).toBe("Helena Vasques");
    expect(r.corpo.consentimentos.length).toBeGreaterThan(0);
    expect(r.corpo.notas.length).toBeGreaterThan(0);
    expect(r.corpo.notas[0]).toEqual(
      expect.objectContaining({
        indicador: expect.any(String),
        valor: expect.any(Number),
        evidencia: expect.any(String),
        lancadoEm: expect.any(String),
      }),
    );
    expect(r.corpo.medidas.length).toBeGreaterThan(0);
    expect(r.corpo.resultados.length).toBeGreaterThan(0);
    expect(r.corpo.financeiro[0].componentes.length).toBeGreaterThan(0);
    // Só dela: nenhum outro atleta no arquivo.
    const outros = (
      await p.db.query<{ nome: string }>("select nome from atletas where nome <> 'Helena Vasques'")
    ).rows;
    for (const o of outros) expect(r.texto).not.toContain(o.nome);
    const aud = await p.db.query("select 1 from auditoria where acao = 'exportar_dados'");
    expect(aud.rows).toHaveLength(1);
  });

  it("exporta também a foto de perfil, as evidências anexadas e o plano individual", async () => {
    const idAtleta = await p.idDe("SP-T07");
    const vazio = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(vazio.corpo.foto).toBeNull();
    expect(vazio.corpo.evidencias).toEqual([]);
    expect(vazio.corpo.plano).toEqual([]);

    const foto = await p.app.inject({
      method: "POST",
      url: "/me/foto",
      headers: await p.como(EMAILS_DEMO.atleta),
      payload: { tipoMime: "image/jpeg", conteudoBase64: jpegValido().toString("base64") },
    });
    expect(foto.statusCode).toBe(200);
    const anexo = await p.app.inject({
      method: "POST",
      url: `/atletas/${idAtleta}/evidencias`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: {
        nomeArquivo: "laudo-pesagem.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]).toString(
          "base64",
        ),
      },
    });
    expect(anexo.statusCode).toBe(201);
    const plano = await p.app.inject({
      method: "PUT",
      url: `/atletas/${idAtleta}/plano`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: {
        forcas: "Leitura de vento",
        lacunas: "Largadas",
        meta12m: "Top 20",
        meta24m: "Campanha completa",
        recomendacao: "Manter o ciclo",
      },
    });
    expect([200, 201]).toContain(plano.statusCode);

    const r = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(r.status).toBe(200);
    expect(r.corpo.foto).toEqual({
      tipoMime: "image/jpeg",
      url: expect.stringContaining("https://"),
    });
    expect(r.corpo.evidencias).toEqual([
      expect.objectContaining({
        id: anexo.json().id,
        nomeArquivo: "laudo-pesagem.pdf",
        tipoMime: "application/pdf",
        tamanhoBytes: expect.any(Number),
        enviadoEm: expect.any(String),
        removida: false,
        removidoEm: null,
      }),
    ]);
    expect(r.texto).not.toMatch(/[0-9a-f-]{36}\.pdf/);
    expect(r.corpo.plano).toEqual([
      expect.objectContaining({
        forcas: "Leitura de vento",
        meta12m: "Top 20",
        registradoPor: expect.any(String),
        registradoEm: expect.any(String),
      }),
    ]);
  });

  it("exporta as pesagens informadas e os pedidos de ajuste recebidos (D9, D8)", async () => {
    const idAtleta = await p.idDe("SP-T07");
    const antes = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(antes.corpo.pesagens).toEqual([]);
    expect(antes.corpo.pedidosAjuste).toEqual([]);

    const pedido = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${idAtleta}/pedidos-ajuste`, {
      mensagem: "Revise a estratégia que você informou.",
      indicadorId: "tat_estrategia",
    });
    expect(pedido.status).toBe(201);

    const depois = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(depois.corpo.pedidosAjuste).toEqual([
      expect.objectContaining({
        mensagem: "Revise a estratégia que você informou.",
        indicador: "Estratégia",
        pedidoPor: expect.any(String),
        criadoEm: expect.any(String),
      }),
    ]);
  });

  it("só o atleta exporta", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "GET", "/meus-dados")).status).toBe(403);
    }
    const sem = await p.app.inject({ method: "GET", url: "/meus-dados" });
    expect(sem.statusCode).toBe(401);
  });

  it("atleta registra pedido; gestor lista, responde; segunda resposta dá 409", async () => {
    const c = await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
      tipo: "correcao",
      descricao: "Quero corrigir o clube do meu cadastro.",
    });
    expect(c.status).toBe(201);
    expect(c.corpo.status).toBe("aberto");

    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
          tipo: "acesso",
          descricao: "curto",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
          tipo: "outro",
          descricao: "Descrição válida longa",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", "/pedidos-titular", {
          tipo: "acesso",
          descricao: "Descrição válida longa",
        })
      ).status,
    ).toBe(403);

    const lista = await chamar(EMAILS_DEMO.gestor, "GET", "/pedidos-titular");
    expect(lista.status).toBe(200);
    expect(lista.corpo[0]).toEqual(
      expect.objectContaining({ id: c.corpo.id, tipo: "correcao", status: "aberto" }),
    );
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/pedidos-titular")).corpo).toHaveLength(1);
    expect((await chamar(EMAILS_DEMO.treinadora, "GET", "/pedidos-titular")).status).toBe(403);

    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "PUT", `/pedidos-titular/${c.corpo.id}`, {
          resposta: "Em análise.",
        })
      ).status,
    ).toBe(403);
    const ok = await chamar(EMAILS_DEMO.gestor, "PUT", `/pedidos-titular/${c.corpo.id}`, {
      resposta: "Correção feita pelo gestor.",
    });
    expect(ok.status).toBe(200);
    expect(ok.corpo.status).toBe("respondido");
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", `/pedidos-titular/${c.corpo.id}`, {
          resposta: "De novo.",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", "/pedidos-titular/999999", {
          resposta: "Sem pedido.",
        })
      ).status,
    ).toBe(404);

    // Pedidos aparecem na exportação.
    const exp = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(exp.corpo.pedidosTitular).toHaveLength(1);

    // Auditoria sem texto do pedido.
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao in ('pedir_titular', 'responder_titular')",
    );
    expect(aud.rows).toHaveLength(2);
    expect(JSON.stringify(aud.rows)).not.toContain("corrigir o clube");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAdminAuthFalso, tokenPara } from "../apoio/app.js";
import { jpegValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};

interface Pesagem {
  id: string;
  pesoKg: number;
  status: string;
  enviadoEm: string;
  motivo: string | null;
  decididoPor: { id: string; nome: string } | null;
  decididoEm: string | null;
  anexoId: string | null;
}

describe("D9: peso informado pelo atleta", () => {
  let p: Piloto;
  let helena: string; // SP-T07, conta de atleta, da treinadora Ana
  let livia: string; // SC-T01, da Ana
  let marcosAtleta: string; // RS-T02, de outro treinador
  let authMarcos: { authorization: string };

  beforeAll(async () => {
    p = await criarPiloto(() => agora, { adminAuth: criarAdminAuthFalso() });
    [helena, livia, marcosAtleta] = await Promise.all([
      p.idDe("SP-T07"),
      p.idDe("SC-T01"),
      p.idDe("RS-T02"),
    ]);
    const marcosId = (
      await p.db.query<{ treinador_id: string }>("select treinador_id from atletas where id = $1", [
        marcosAtleta,
      ])
    ).rows[0]!.treinador_id;
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authUserId, marcosId]);
    authMarcos = cabecalhoAuth(await tokenPara(authUserId));
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    quem: string | { authorization: string } | null,
    metodo: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    corpo?: unknown,
  ) => {
    const headers = quem === null ? {} : typeof quem === "string" ? await p.como(quem) : quem;
    const r = await p.app.inject({
      method: metodo,
      url,
      headers,
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const foto = async (
    quem: string | null,
    atleta = helena,
    extra: Record<string, unknown> = { categoria: "balanca" },
  ) =>
    chamar(quem, "POST", `/atletas/${atleta}/evidencias`, {
      nomeArquivo: "balanca.jpg",
      tipoMime: "image/jpeg",
      conteudoBase64: jpegValido().toString("base64"),
      ...extra,
    });
  const enviar = (quem: string | null, corpo: unknown) =>
    chamar(quem, "POST", "/me/pesagens", corpo);
  const decidir = (quem: string | { authorization: string } | null, id: string, corpo: unknown) =>
    chamar(quem, "PUT", `/pesagens/${id}/validacao`, corpo);
  const listar = async (quem: string | { authorization: string } | null, id = helena) =>
    chamar(quem, "GET", `/atletas/${id}/pesagens`);
  const classFit = async () =>
    (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${helena}`)).corpo;
  const avisosDe = async (quem: string | { authorization: string }) =>
    (await chamar(quem, "GET", "/me/avisos")).corpo.itens as {
      tipo: string;
      referencia: Record<string, unknown>;
    }[];
  const caminhoDo = async (anexoId: string) =>
    (
      await p.db.query<{ caminho: string; removido_em: Date | null }>(
        "select caminho, removido_em from evidencias_anexos where id = $1",
        [anexoId],
      )
    ).rows[0]!;

  /** Anexa a foto e envia a pesagem do atleta; devolve o envio. */
  async function enviarPesagem(pesoKg: number) {
    const f = await foto(EMAILS_DEMO.atleta);
    expect(f.status).toBe(201);
    const r = await enviar(EMAILS_DEMO.atleta, { pesoKg, anexoId: f.corpo.id });
    return { anexoId: f.corpo.id as string, r };
  }

  it("envio inválido: sem foto, anexo errado, peso fora da faixa, campo extra, papel e token", async () => {
    expect((await enviar(EMAILS_DEMO.atleta, { pesoKg: 70 })).corpo.campos[0].campo).toBe(
      "anexoId",
    );
    const semFoto = await enviar(EMAILS_DEMO.atleta, { pesoKg: 70, anexoId: crypto.randomUUID() });
    expect(semFoto.status).toBe(400);
    expect(semFoto.corpo.campos[0].campo).toBe("anexoId");

    // Categoria diferente de balanca e anexo de outro atleta.
    const comum = await foto(EMAILS_DEMO.atleta, helena, { categoria: "evidencia" });
    const errada = await enviar(EMAILS_DEMO.atleta, { pesoKg: 70, anexoId: comum.corpo.id });
    expect(errada.status).toBe(400);
    expect(errada.corpo.campos[0].campo).toBe("anexoId");
    const alheia = await foto(EMAILS_DEMO.gestor, livia);
    const deOutro = await enviar(EMAILS_DEMO.atleta, { pesoKg: 70, anexoId: alheia.corpo.id });
    expect(deOutro.status).toBe(400);
    expect(deOutro.corpo.campos[0].campo).toBe("anexoId");

    const ok = await foto(EMAILS_DEMO.atleta);
    for (const pesoKg of [29.9, 160.1, "70"]) {
      const r = await enviar(EMAILS_DEMO.atleta, { pesoKg, anexoId: ok.corpo.id });
      expect(r.status, String(pesoKg)).toBe(400);
      expect(r.corpo.campos[0].campo).toBe("pesoKg");
    }
    expect(
      (await enviar(EMAILS_DEMO.atleta, { pesoKg: 70, anexoId: ok.corpo.id, x: 1 })).status,
    ).toBe(400);

    for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await enviar(quem, { pesoKg: 70, anexoId: ok.corpo.id })).status).toBe(403);
    }
    expect((await enviar(null, { pesoKg: 70, anexoId: ok.corpo.id })).status).toBe(401);
    const n = await p.db.query<{ n: string }>("select count(*)::text as n from pesagens_atleta");
    expect(n.rows[0]!.n).toBe("0");
    // Limpa as fotos de teste para não pesar na próxima etapa.
    for (const a of [comum.corpo.id, ok.corpo.id]) {
      await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${a}`);
    }
    await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${alheia.corpo.id}`);
  });

  let pendente: Pesagem;
  let anexoPendente: string;
  let pesoAntes: number | null;

  it("o envio fica pendente, avisa o treinador e NÃO muda o Class Fit nem o G1", async () => {
    const antes = await classFit();
    pesoAntes = antes.classFit?.pesoKg ?? null;
    avancar(1);
    const { anexoId, r } = await enviarPesagem(77.46);
    expect(r.status).toBe(201);
    anexoPendente = anexoId;
    pendente = r.corpo as Pesagem;
    expect(pendente).toMatchObject({
      status: "pendente",
      pesoKg: 77.5,
      motivo: null,
      decididoPor: null,
      decididoEm: null,
      anexoId,
    });

    const depois = await classFit();
    expect(depois.classFit).toEqual(antes.classFit);
    expect(depois.gates).toEqual(antes.gates);
    expect(depois.score).toBe(antes.score);
    const medidas = await p.db.query<{ n: string }>(
      "select count(*)::text as n from medidas_corporais where atleta_id = $1 and peso_kg = 77.5",
      [helena],
    );
    expect(medidas.rows[0]!.n).toBe("0");

    const avisos = (await avisosDe(EMAILS_DEMO.treinadora)).filter(
      (a) => a.tipo === "atleta_enviou_pesagem",
    );
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.referencia).toEqual({ pesagemId: pendente.id });

    // Auditoria sem o peso.
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'enviar_pesagem' order by id desc limit 1",
    );
    expect(Object.keys(aud.rows[0]!.detalhes as object).sort()).toEqual(["anexoId", "pesagemId"]);
  });

  it("segunda pesagem com uma pendente: 409; a foto da pendente não sai pelo DELETE (409)", async () => {
    const f = await foto(EMAILS_DEMO.atleta);
    const r = await enviar(EMAILS_DEMO.atleta, { pesoKg: 70, anexoId: f.corpo.id });
    expect(r.status).toBe(409);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${anexoPendente}`)).status,
    ).toBe(409);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${anexoPendente}`)).status,
    ).toBe(409);
    await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${f.corpo.id}`);
  });

  it("leitura: gestor, treinador e o próprio atleta; IBVAR 403, outro treinador e outro atleta 404", async () => {
    for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
      const r = await listar(quem);
      expect(r.status).toBe(200);
      expect(r.corpo.itens).toEqual([pendente]);
    }
    expect((await listar(EMAILS_DEMO.ibvar)).status).toBe(403);
    expect((await listar(EMAILS_DEMO.ibvar, livia)).status).toBe(403);
    expect((await listar(null)).status).toBe(401);
    expect((await listar(authMarcos)).status).toBe(404);
    expect((await listar(EMAILS_DEMO.atleta, livia)).status).toBe(404);
    // A foto pendente abre para quem valida.
    expect(
      (await chamar(EMAILS_DEMO.treinadora, "GET", `/evidencias/${anexoPendente}/link`)).status,
    ).toBe(200);
  });

  it("decisão: atleta e IBVAR 403, sem token 401, outro treinador e id inexistente 404, corpo inválido 400", async () => {
    const corpo = { decisao: "validar" };
    expect((await decidir(EMAILS_DEMO.atleta, pendente.id, corpo)).status).toBe(403);
    expect((await decidir(EMAILS_DEMO.ibvar, pendente.id, corpo)).status).toBe(403);
    expect((await decidir(null, pendente.id, corpo)).status).toBe(401);
    expect((await decidir(authMarcos, pendente.id, corpo)).status).toBe(404);
    expect((await decidir(EMAILS_DEMO.gestor, "999999", corpo)).status).toBe(404);
    expect((await decidir(EMAILS_DEMO.gestor, "abc", corpo)).status).toBe(400);
    expect((await decidir(EMAILS_DEMO.gestor, pendente.id, { decisao: "talvez" })).status).toBe(
      400,
    );
    expect((await decidir(EMAILS_DEMO.gestor, pendente.id, { ...corpo, x: 1 })).status).toBe(400);
    // Recusar sem motivo (ou só com espaços): 400 no campo `motivo`; motivo longo também.
    for (const motivo of [undefined, "   ", "x".repeat(301)]) {
      const r = await decidir(EMAILS_DEMO.treinadora, pendente.id, { decisao: "recusar", motivo });
      expect(r.status).toBe(400);
      expect(r.corpo.campos[0].campo).toBe("motivo");
    }
    // Nada mudou.
    expect((await listar(EMAILS_DEMO.gestor)).corpo.itens[0].status).toBe("pendente");
  });

  it("recusar: grava o motivo, não cria medida, remove a foto, avisa o atleta; decidir de novo dá 409", async () => {
    avancar(1);
    const r = await decidir(EMAILS_DEMO.treinadora, pendente.id, {
      decisao: "recusar",
      motivo: "Visor ilegível",
    });
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({
      status: "recusada",
      motivo: "Visor ilegível",
      decididoPor: { nome: expect.any(String) },
      decididoEm: agora.toISOString(),
      anexoId: null,
    });
    const medidas = await p.db.query<{ n: string }>(
      "select count(*)::text as n from medidas_corporais where atleta_id = $1 and peso_kg = 77.5",
      [helena],
    );
    expect(medidas.rows[0]!.n).toBe("0");
    expect((await classFit()).classFit?.pesoKg ?? null).toBe(pesoAntes);

    const a = await caminhoDo(anexoPendente);
    expect(a.removido_em).not.toBeNull();
    expect(p.armazenamento.arquivos.has(a.caminho)).toBe(false);
    expect(
      (await avisosDe(EMAILS_DEMO.atleta)).filter((x) => x.tipo === "pesagem_recusada"),
    ).toMatchObject([{ referencia: { pesagemId: pendente.id } }]);
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'decidir_pesagem' order by id desc limit 1",
    );
    expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("Visor");

    const de = await decidir(EMAILS_DEMO.gestor, pendente.id, { decisao: "validar" });
    expect(de.status).toBe(409);
    // Foto removida: o link não abre mais.
    expect(
      (await chamar(EMAILS_DEMO.treinadora, "GET", `/evidencias/${anexoPendente}/link`)).status,
    ).toBe(410);
  });

  it("validar (treinador): cria a medida na mesma decisão e o peso passa a valer no Class Fit e no G1", async () => {
    avancar(1);
    const { anexoId, r } = await enviarPesagem(80.3);
    expect(r.status).toBe(201);
    const id = r.corpo.id as string;
    const enviadoEm = r.corpo.enviadoEm as string;
    avancar(5);
    const v = await decidir(EMAILS_DEMO.treinadora, id, { decisao: "validar" });
    expect(v.status).toBe(200);
    expect(v.corpo).toMatchObject({ status: "validada", motivo: null, anexoId: null });

    const medida = await p.db.query<{
      peso_kg: string;
      medido_em: Date;
      evidencia: string;
      registrado_por: string;
      decidido_por: string;
      medida_id: string;
      id: string;
    }>(
      `select m.id::text as id, m.peso_kg, m.medido_em, m.evidencia, m.registrado_por::text as registrado_por,
              pe.decidido_por::text as decidido_por, pe.medida_id::text as medida_id
         from pesagens_atleta pe join medidas_corporais m on m.id = pe.medida_id
        where pe.id = $1`,
      [id],
    );
    expect(medida.rows).toHaveLength(1);
    const m = medida.rows[0]!;
    expect(Number(m.peso_kg)).toBe(80.3);
    expect(m.medido_em.toISOString()).toBe(enviadoEm);
    expect(m.evidencia).toBe("Pesagem informada pelo atleta e validada");
    expect(m.registrado_por).toBe(m.decidido_por);
    expect(m.medida_id).toBe(m.id);

    expect((await classFit()).classFit.pesoKg).toBe(80.3);
    const a = await caminhoDo(anexoId);
    expect(a.removido_em).not.toBeNull();
    expect(p.armazenamento.arquivos.has(a.caminho)).toBe(false);
    expect(
      (await avisosDe(EMAILS_DEMO.atleta)).filter((x) => x.tipo === "pesagem_validada"),
    ).toHaveLength(1);

    // Lista: da mais nova para a mais antiga, com quem decidiu.
    const lista = (await listar(EMAILS_DEMO.atleta)).corpo.itens as Pesagem[];
    expect(lista.map((x) => x.status)).toEqual(["validada", "recusada"]);
  });

  it("o gestor valida pesagem de qualquer atleta; o treinador continua lançando a pesagem direto", async () => {
    avancar(1);
    const { r } = await enviarPesagem(79.1);
    expect(r.status).toBe(201);
    avancar(1);
    const v = await decidir(EMAILS_DEMO.gestor, r.corpo.id, { decisao: "validar" });
    expect(v.status).toBe(200);
    expect((await classFit()).classFit.pesoKg).toBe(79.1);

    avancar(1);
    const direto = await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${helena}/avaliacoes`, {
      medida: { pesoKg: 78.4 },
    });
    expect(direto.status).toBe(201);
    expect((await classFit()).classFit.pesoKg).toBe(78.4);
  });

  it("falha no Storage depois da decisão: a decisão fica e o arquivo vira pendência de limpeza", async () => {
    avancar(1);
    const { anexoId, r } = await enviarPesagem(77.7);
    const caminho = (await caminhoDo(anexoId)).caminho;
    p.armazenamento.falharCaminhos.add(caminho);
    try {
      avancar(1);
      const v = await decidir(EMAILS_DEMO.treinadora, r.corpo.id, { decisao: "validar" });
      expect(v.status).toBe(200);
      expect(v.corpo.status).toBe("validada");
      const pend = await p.db.query<{ motivo: string }>(
        "select motivo from arquivos_pendentes where caminho = $1",
        [caminho],
      );
      expect(pend.rows[0]!.motivo).toBe("pesagem_decidida");
      expect((await caminhoDo(anexoId)).removido_em).not.toBeNull();
    } finally {
      p.armazenamento.falharCaminhos.delete(caminho);
    }
  });

  it("o banco recusa alterar pesagem decidida, apagar fora da anonimização e duas pendentes", async () => {
    await expect(
      p.db.query("update pesagens_atleta set peso_kg = 60 where status = 'validada'"),
    ).rejects.toThrow(/só a decisão/);
    await expect(p.db.query("delete from pesagens_atleta")).rejects.toThrow(/só a decisão/);
    const f1 = await foto(EMAILS_DEMO.atleta);
    const f2 = await foto(EMAILS_DEMO.atleta);
    await p.db.query(
      "insert into pesagens_atleta (atleta_id, peso_kg, anexo_id, enviado_em) values ($1, 70, $2, now())",
      [helena, f1.corpo.id],
    );
    await expect(
      p.db.query(
        "insert into pesagens_atleta (atleta_id, peso_kg, anexo_id, enviado_em) values ($1, 71, $2, now())",
        [helena, f2.corpo.id],
      ),
    ).rejects.toThrow();
  });
});

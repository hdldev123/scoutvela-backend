import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const LINK = "https://www.youtube.com/watch?v=abc123";

interface IndicadorFicha {
  id: string;
  link: string | null;
}

describe("D5: evidência por indicador e link de vídeo", () => {
  let p: Piloto;
  let livia: string; // SC-T01, da Ana, consentiu com o IBVAR
  let helena: string; // SP-T07, da Ana, é a conta de atleta
  const obrigatorio = "perf_nacional";
  const opcional = "tec_largada";

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    [livia, helena] = await Promise.all([p.idDe("SC-T01"), p.idDe("SP-T07")]);
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    metodo: "GET" | "POST" | "PUT",
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
  const lancar = (corpo: object, id = livia, sufixo = "") =>
    chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${id}/avaliacoes${sufixo}`, corpo);

  it("valores iniciais: opcional em tec/tat/pot, obrigatória nos demais, anexo no peso", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "GET", "/parametros");
    const todos = r.corpo.pilares.flatMap(
      (x: { indicadores: { id: string; evidencia: string; exigeAnexo: boolean }[] }) =>
        x.indicadores,
    );
    for (const i of todos) {
      expect(i.evidencia).toBe(/^(tec|tat|pot)_/.test(i.id) ? "opcional" : "obrigatoria");
      expect(i.exigeAnexo).toBe(i.id === "cf_peso_kg");
    }
  });

  it("obrigatório sem evidência dá 400 com o campo certo; opcional sem evidência dá 201", async () => {
    const r = await lancar({ notas: [{ indicadorId: obrigatorio, valor: 3 }] });
    expect(r.status).toBe(400);
    expect(r.corpo.campos).toEqual([{ campo: "notas.0.evidencia", mensagem: expect.any(String) }]);
    // Texto só com espaços vale como ausente.
    const vazia = await lancar({
      notas: [{ indicadorId: obrigatorio, valor: 3, evidencia: "  " }],
    });
    expect(vazia.status).toBe(400);
    // A prévia segue a mesma regra.
    const previa = await lancar(
      { notas: [{ indicadorId: obrigatorio, valor: 3 }] },
      livia,
      "/previa",
    );
    expect(previa.status).toBe(400);

    const ok = await lancar({ notas: [{ indicadorId: opcional, valor: 4 }] });
    expect(ok.status).toBe(201);
    const nulo = await p.db.query<{ evidencia: string | null }>(
      "select evidencia from avaliacoes where atleta_id = $1 and indicador_id = $2 order by id desc limit 1",
      [livia, opcional],
    );
    expect(nulo.rows[0]!.evidencia).toBeNull();
    const previaOk = await lancar(
      { notas: [{ indicadorId: opcional, valor: 4 }] },
      livia,
      "/previa",
    );
    expect(previaOk.status).toBe(200);
  });

  it("evidência curta continua inválida quando preenchida", async () => {
    const r = await lancar({ notas: [{ indicadorId: opcional, valor: 2, evidencia: "ab" }] });
    expect(r.status).toBe(400);
  });

  it("link inválido dá 400 (http, javascript, ftp, sem endereço, com espaço, longo)", async () => {
    for (const link of [
      "http://exemplo.com/v",
      "javascript:alert(1)",
      "ftp://exemplo.com/v",
      "https://",
      "https://com espaço.com",
      `https://exemplo.com/${"a".repeat(500)}`,
    ]) {
      const r = await lancar({ notas: [{ indicadorId: opcional, valor: 4, link }] });
      expect(r.status, link).toBe(400);
      expect(r.corpo.campos[0].campo).toBe("notas.0.link");
    }
  });

  it("link válido: aparece na ficha e no histórico para gestor, treinador e atleta, nunca para o IBVAR", async () => {
    const r = await lancar({ notas: [{ indicadorId: opcional, valor: 5, link: LINK }] }, helena);
    expect(r.status).toBe(201);
    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'lancar_avaliacao' and entidade_id = $1 order by id desc limit 1",
      [helena],
    );
    expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("youtube");

    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
      const h = await chamar(email, "GET", `/atletas/${helena}/indicadores/${opcional}/historico`);
      expect(h.status).toBe(200);
      expect(h.corpo[0]).toMatchObject({ valor: 5, evidencia: null, link: LINK });
      const f = await chamar(email, "GET", `/atletas/${helena}`);
      const ind = f.corpo.pilares
        .flatMap((x: { indicadores: IndicadorFicha[] | null }) => x.indicadores ?? [])
        .find((i: IndicadorFicha) => i.id === opcional);
      expect(ind.link).toBe(LINK);
    }

    // Helena não consentiu com o IBVAR: o teste do IBVAR usa a Lívia, que consentiu.
    await lancar({ notas: [{ indicadorId: opcional, valor: 5, link: LINK }] }, livia);
    const h = await chamar(
      EMAILS_DEMO.ibvar,
      "GET",
      `/atletas/${livia}/indicadores/${opcional}/historico`,
    );
    expect(h.status).toBe(200);
    expect(h.corpo[0].link).toBeNull();
    expect(h.corpo[0].evidencia).toBeNull();
    const f = await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${livia}`);
    expect(f.status).toBe(200);
    expect(JSON.stringify(f.corpo)).not.toContain(LINK);
  });

  it("o banco recusa link fora de https e evidência só com espaços", async () => {
    await expect(
      p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, link, origem, avaliador_id)
         values ($1, $2, 3, null, 'http://x.com', 'avaliacao', (select id from usuarios where email = $3))`,
        [livia, opcional, EMAILS_DEMO.gestor],
      ),
    ).rejects.toThrow();
    await expect(
      p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id)
         values ($1, $2, 3, '  ', 'avaliacao', (select id from usuarios where email = $3))`,
        [livia, opcional, EMAILS_DEMO.gestor],
      ),
    ).rejects.toThrow();
  });

  it("gestor edita a regra em Parâmetros, com auditoria de antes e depois", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      indicadores: [{ id: opcional, evidencia: "obrigatoria" }],
    });
    expect(r.status).toBe(200);
    const ind = r.corpo.pilares
      .flatMap((x: { indicadores: { id: string; evidencia: string }[] }) => x.indicadores)
      .find((i: { id: string }) => i.id === opcional);
    expect(ind.evidencia).toBe("obrigatoria");
    const aud = await p.db.query<{ detalhes: { indicadores: unknown } }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.indicadores).toEqual({
      antes: { [opcional]: "opcional" },
      depois: { [opcional]: "obrigatoria" },
    });
    // A nova regra vale na hora.
    expect((await lancar({ notas: [{ indicadorId: opcional, valor: 3 }] })).status).toBe(400);
    await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      indicadores: [{ id: opcional, evidencia: "opcional" }],
    });
    expect((await lancar({ notas: [{ indicadorId: opcional, valor: 3 }] })).status).toBe(201);
  });

  it("edição inválida: indicador inexistente, valor fora da lista e repetido dão 400", async () => {
    for (const indicadores of [
      [{ id: "nao_existe", evidencia: "opcional" }],
      [{ id: opcional, evidencia: "talvez" }],
      [
        { id: opcional, evidencia: "opcional" },
        { id: opcional, evidencia: "obrigatoria" },
      ],
    ]) {
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", { indicadores });
      expect(r.status).toBe(400);
    }
  });

  it("só o gestor edita: treinador, atleta, IBVAR e sem token", async () => {
    const corpo = { indicadores: [{ id: opcional, evidencia: "obrigatoria" }] };
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "PUT", "/parametros", corpo)).status).toBe(403);
    }
    expect((await chamar(null, "PUT", "/parametros", corpo)).status).toBe(401);
  });
});

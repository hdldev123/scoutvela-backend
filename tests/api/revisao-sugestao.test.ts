import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

describe("revisão de nota: a sugestão gerada pela resposta do atleta não é lançamento do avaliador", () => {
  let agora = new Date("2026-11-06T12:00:00-03:00");
  let p: Piloto;
  let atletaId: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    atletaId = (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: await p.como(email),
      ...(body === undefined ? {} : { payload: body as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("lista só lançamentos do avaliador, recusa ligar a sugestão e notaAnterior ignora a sugestão", async () => {
    const IND = "amb_apoio_familiar";
    agora = new Date("2026-11-07T12:00:00-03:00");
    const ped = await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
      indicadorId: IND,
      motivo: "Discordo da nota de apoio familiar.",
    });
    expect(ped.status).toBe(201);

    // O atleta responde: gera uma sugestão (origem resposta_sugerida), posterior ao pedido.
    agora = new Date("2026-11-08T12:00:00-03:00");
    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", {
          indicadorId: IND,
          resposta: "Apoia pouco",
        })
      ).status,
    ).toBe(201);
    const sug = (
      await p.db.query<{ id: string }>(
        `select id::text as id from avaliacoes where atleta_id = $1 and origem = 'resposta_sugerida' order by id desc limit 1`,
        [atletaId],
      )
    ).rows[0];
    expect(sug).toBeDefined();

    const lista = await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${ped.corpo.id}/lancamentos`);
    expect(lista.corpo.lancamentos.map((l: { origem: string }) => l.origem)).not.toContain(
      "resposta_sugerida",
    );
    const put = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${ped.corpo.id}`, {
      resposta: "Mantida.",
      avaliacaoId: sug!.id,
    });
    expect(put.status).toBe(400);

    // Segundo pedido: o avaliador confirma uma nota; a "nota anterior" é a confirmada, não a sugestão.
    agora = new Date("2026-11-09T12:00:00-03:00");
    const ped2 = await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
      indicadorId: IND,
      motivo: "Discordo da nota de apoio familiar 2.",
    });
    agora = new Date("2026-11-09T13:00:00-03:00");
    await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", {
      indicadorId: IND,
      resposta: "Apoia totalmente",
    });
    agora = new Date("2026-11-09T14:00:00-03:00");
    await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${atletaId}/avaliacoes`, {
      notas: [{ indicadorId: IND, valor: 2, evidencia: "Conversa com a família" }],
    });
    const conf = (await chamar(EMAILS_DEMO.gestor, "GET", `/revisoes/${ped2.corpo.id}/lancamentos`))
      .corpo.lancamentos[0];
    const ok = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${ped2.corpo.id}`, {
      resposta: "Revisada.",
      avaliacaoId: conf.id,
    });
    expect(ok.status).toBe(200);
    const confirmadaAnterior = (
      await p.db.query<{ valor: number }>(
        `select valor from avaliacoes where atleta_id = $1 and indicador_id = $2
            and origem <> 'resposta_sugerida' and id < $3::bigint order by lancado_em desc, id desc limit 1`,
        [atletaId, IND, conf.id],
      )
    ).rows[0]?.valor;
    expect(ok.corpo.notaNova).toBe(2);
    expect(ok.corpo.notaAnterior).toBe(confirmadaAnterior ?? null);
  });
});

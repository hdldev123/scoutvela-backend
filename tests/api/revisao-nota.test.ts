import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria, type MensagemEmail } from "../../src/email/index.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const T0 = new Date("2026-11-06T12:00:00-03:00");
const ANTES = "2026-11-01T12:00:00-03:00";
const ANTES_2 = "2026-11-03T12:00:00-03:00";
const depois = () => new Date(agora.getTime() + 86_400_000).toISOString();

let agora = T0;

describe("revisão ligada ao lançamento (PUT /revisoes/:id com avaliacaoId)", () => {
  let p: Piloto;
  const memoria = criarProvedorEmailMemoria();
  let falharEmail = false;
  let atletaId: string;
  let outroAtletaId: string;
  let gestorId: string;
  let indPerf: string[];
  let indTec: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora, {
      email: {
        enviar(m: MensagemEmail) {
          if (falharEmail) return Promise.reject(new Error("smtp fora do ar"));
          return memoria.enviar(m);
        },
      },
    });
    atletaId = (
      await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
        EMAILS_DEMO.atleta,
      ])
    ).rows[0]!.atleta_id;
    outroAtletaId = await p.idDe("RJ-T03");
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    indPerf = (
      await p.db.query<{ id: string }>(
        "select id from indicadores where pilar_id = 'perf' and not calculado and tipo = 'T' order by ordem",
      )
    ).rows.map((l) => l.id);
    indTec = (
      await p.db.query<{ id: string }>(
        "select id from indicadores where pilar_id = 'tec' and not calculado and tipo = 'T' order by ordem limit 1",
      )
    ).rows[0]!.id;
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
  const lancar = async (atleta: string, indicador: string, valor: number, quando: string) =>
    (
      await p.db.query<{ id: string }>(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id, lancado_em)
         values ($1, $2, $3, 'Evidência de teste', 'avaliacao', $4, $5) returning id::text as id`,
        [atleta, indicador, valor, gestorId, quando],
      )
    ).rows[0]!.id;
  const pedir = async (corpo: Record<string, unknown>) =>
    (
      await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
        motivo: "Não concordo com esta nota, peço revisão.",
        ...corpo,
      })
    ).corpo.id as string;

  it("vínculo válido por indicador: GET devolve notaAnterior e notaNova; auditoria sem notas", async () => {
    const ind = indPerf[0]!;
    await lancar(atletaId, ind, 2, ANTES);
    const anterior = await lancar(atletaId, ind, 3, ANTES_2);
    const id = await pedir({ indicadorId: ind });
    const nova = await lancar(atletaId, ind, 4, depois());
    expect(anterior).not.toBe(nova);

    // Antes de responder, sem vínculo.
    const aberto = (await chamar(EMAILS_DEMO.atleta, "GET", "/revisoes")).corpo.find(
      (r: { id: string }) => r.id === id,
    );
    expect(aberto).toMatchObject({ avaliacaoId: null, notaAnterior: null, notaNova: null });

    agora = new Date("2026-11-10T12:00:00-03:00");
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
      resposta: "Reavaliamos a regata e subimos a nota.",
      avaliacaoId: nova,
    });
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({ avaliacaoId: nova, notaAnterior: 3, notaNova: 4 });

    for (const email of [EMAILS_DEMO.atleta, EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora]) {
      const item = (await chamar(email, "GET", "/revisoes")).corpo.find(
        (x: { id: string }) => x.id === id,
      );
      expect(item, email).toMatchObject({ avaliacaoId: nova, notaAnterior: 3, notaNova: 4 });
    }

    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'responder_revisao' and entidade_id = $1",
      [id],
    );
    expect(aud.rows[0]!.detalhes).toEqual({ avaliacaoId: nova });
  });

  it("avaliacaoId numérico; notaAnterior vem do último lançamento antes do vinculado (seed)", async () => {
    const ind = indPerf[1]!;
    const id = await pedir({ indicadorId: ind });
    const seed = await p.db.query<{ valor: number }>(
      "select valor from avaliacoes where atleta_id = $1 and indicador_id = $2 order by lancado_em desc, id desc limit 1",
      [atletaId, ind],
    );
    const nova = await lancar(atletaId, ind, 5, depois());
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
      resposta: "Nota atualizada.",
      avaliacaoId: Number(nova),
    });
    expect(r.status).toBe(200);
    expect(r.corpo).toMatchObject({
      avaliacaoId: nova,
      notaAnterior: seed.rows[0]!.valor,
      notaNova: 5,
    });
  });

  it("pedido por pilar aceita lançamento de indicador do pilar", async () => {
    const ind = indPerf[2] ?? indPerf[0]!;
    const id = await pedir({ pilarId: "perf" });
    const nova = await lancar(atletaId, ind, 1, depois());
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
      resposta: "Revisado pelo pilar.",
      avaliacaoId: nova,
    });
    expect(r.status).toBe(200);
    expect(r.corpo.notaNova).toBe(1);
  });

  it("vínculos inválidos: 400 em cada caso, e o pedido segue aberto", async () => {
    const ind = indPerf[0]!;
    const id = await pedir({ indicadorId: ind });
    const deOutro = await lancar(outroAtletaId, ind, 3, depois());
    const deOutroIndicador = await lancar(atletaId, indTec, 3, depois());
    const anteriorAoPedido = await lancar(atletaId, ind, 3, ANTES);

    const responder = (avaliacaoId: unknown) =>
      chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
        resposta: "Resposta de teste.",
        avaliacaoId,
      });
    for (const invalido of [deOutro, deOutroIndicador, anteriorAoPedido, "999999999", "abc"]) {
      const r = await responder(invalido);
      expect(r.status, String(invalido)).toBe(400);
      expect(r.corpo.erro).toBe("requisicao_invalida");
    }

    // Pedido por pilar: indicador de outro pilar.
    const idPilar = await pedir({ pilarId: "perf" });
    const fora = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${idPilar}`, {
      resposta: "Resposta de teste.",
      avaliacaoId: deOutroIndicador,
    });
    expect(fora.status).toBe(400);

    const ainda = (await chamar(EMAILS_DEMO.gestor, "GET", "/revisoes?status=aberto")).corpo;
    expect(ainda.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining([id, idPilar]));
  });

  it("e-mail ao atleta: só aviso e link, sem nota nem texto da resposta", async () => {
    memoria.enviadas.length = 0;
    const ind = indPerf[0]!;
    const id = await pedir({ indicadorId: ind });
    const nova = await lancar(atletaId, ind, 4, depois());
    await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
      resposta: "Texto sigiloso da resposta do gestor.",
      avaliacaoId: nova,
    });
    expect(memoria.enviadas).toHaveLength(1);
    const m = memoria.enviadas[0]!;
    expect(m.para).toBe(EMAILS_DEMO.atleta);
    expect(m.assunto).toBe("Scout Vela: seu pedido de revisão foi respondido");
    expect(m.texto).toContain("/revisoes");
    expect(m.texto).not.toContain("sigiloso");
    expect(m.texto).not.toContain("Não concordo");
    expect(m.texto).not.toMatch(/nota/i);
    expect(m.texto).not.toMatch(/\b[0-5]\b/);
  });

  it("falha no envio do e-mail não desfaz a resposta", async () => {
    falharEmail = true;
    try {
      const id = await pedir({ indicadorId: indPerf[0]! });
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, {
        resposta: "Resposta mesmo com o e-mail fora do ar.",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({
        status: "respondido",
        avaliacaoId: null,
        notaAnterior: null,
        notaNova: null,
      });
      const salvo = await p.db.query<{ status: string }>(
        "select status from pedidos_revisao where id = $1::bigint",
        [id],
      );
      expect(salvo.rows[0]!.status).toBe("respondido");
    } finally {
      falharEmail = false;
    }
  });

  it("responder de novo continua 409; pedido inexistente, 404", async () => {
    const id = await pedir({ indicadorId: indPerf[0]! });
    const corpo = { resposta: "Resposta de teste." };
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, corpo)).status).toBe(200);
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${id}`, corpo)).status).toBe(409);
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", "/revisoes/99999", corpo)).status).toBe(404);
  });
});

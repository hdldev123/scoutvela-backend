import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Modulo {
  pilarId: string;
  situacao: string;
  quemPreenche: string;
  respostasFeitas: number;
  respostasTotal: number;
  perguntas: { indicadorId: string; registradoNaoPontua: boolean; opcoes: Record<string, unknown>[]; resposta: string | null }[];
}

describe("painel do atleta, respostas, consentimento e revisões", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const chamar = async (email: string, metodo: "GET" | "POST" | "PUT", url: string, corpo?: unknown) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: await p.como(email),
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };
  const painel = () => chamar(EMAILS_DEMO.atleta, "GET", "/painel");
  const modulo = (c: { modulos: Modulo[] }, id: string) => c.modulos.find((m) => m.pilarId === id)!;

  it("painel da Helena: módulos, sua vez, histórico familiar sem pontuar, sem nota sugerida", async () => {
    const { status, corpo, texto } = await painel();
    expect(status).toBe(200);
    expect(corpo.atleta.nome).toBe("Helena Vasques");
    expect(corpo.modulos).toHaveLength(9);
    const amb = modulo(corpo, "amb");
    const car = modulo(corpo, "car");
    expect(amb.situacao).toBe("sua_vez");
    expect(car.situacao).toBe("sua_vez");
    expect(amb.quemPreenche).toBe("ambos");
    expect(amb.respostasFeitas).toBeLessThan(amb.respostasTotal);
    const hist = amb.perguntas.find((q) => q.indicadorId === "amb_historico_familiar")!;
    expect(hist.registradoNaoPontua).toBe(true);
    expect(hist.opcoes.length).toBeGreaterThan(0);
    expect(modulo(corpo, "perf").perguntas).toEqual([]);
    expect(modulo(corpo, "perf").quemPreenche).toBe("treinador");
    expect(corpo.pendencias.length).toBeGreaterThan(0);
    expect(corpo.consentimento).toMatchObject({ termoVersao: "Piloto 18+ · v1", compartilharIbvar: false });
    expect(corpo.consentimento.termoAceitoEm).toEqual(expect.any(String));
    expect(texto).not.toContain("notaSugerida");
    expect(texto).not.toContain("nota_sugerida");
  });

  it("outros papéis -> 403; sem token -> 401", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "GET", "/painel")).status).toBe(403);
      expect((await chamar(email, "POST", "/respostas", { indicadorId: "amb_apoio_familiar", resposta: "Apoia totalmente" })).status).toBe(403);
      expect((await chamar(email, "PUT", "/consentimento", { compartilharIbvar: true })).status).toBe(403);
      expect((await chamar(email, "POST", "/revisoes", { pilarId: "amb", motivo: "Motivo suficiente." })).status).toBe(403);
    }
    expect((await p.app.inject({ method: "GET", url: "/painel" })).statusCode).toBe(401);
  });

  it("resposta inválida -> 400 (indicador sem pergunta, opção que não existe, corpo vazio)", async () => {
    const semPergunta = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", { indicadorId: "perf_ranking", resposta: "x" });
    expect(semPergunta.status).toBe(400);
    const opcao = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", { indicadorId: "amb_apoio_familiar", resposta: "Inventada" });
    expect(opcao.status).toBe(400);
    expect(opcao.corpo.mensagem).toMatch(/inválida/i);
    expect((await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", {})).status).toBe(400);
  });

  it("resposta gera sugestão pendente e não muda o score do painel", async () => {
    const antes = (await painel()).corpo;
    const alvo = antes.modulos
      .flatMap((m: Modulo) => m.perguntas)
      .find((q: Modulo["perguntas"][number]) => q.resposta === null && !q.registradoNaoPontua)!;
    expect(alvo).toBeDefined();
    const r = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", { indicadorId: alvo.indicadorId, resposta: "Apoia totalmente" });
    // Se a pergunta sorteada não for a de apoio familiar, usa o texto da primeira opção dela.
    let resposta = r;
    if (r.status === 400) {
      const texto = (alvo.opcoes[0] as { texto: string }).texto;
      resposta = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", { indicadorId: alvo.indicadorId, resposta: texto });
    }
    expect(resposta.status).toBe(201);
    expect(resposta.corpo.notaSugerida).toEqual(expect.any(Number));

    const depois = (await painel()).corpo;
    expect(depois.score).toBe(antes.score);
    const feita = depois.modulos.flatMap((m: Modulo) => m.perguntas).find((q: Modulo["perguntas"][number]) => q.indicadorId === alvo.indicadorId);
    expect(feita.resposta).not.toBeNull();

    const id = await p.idDe("SP-T07");
    const sug = await p.db.query<{ origem: string; avaliador_id: string | null; evidencia: string }>(
      "select origem, avaliador_id, evidencia from avaliacoes where atleta_id = $1 and indicador_id = $2 order by id desc limit 1",
      [id, alvo.indicadorId],
    );
    expect(sug.rows[0]).toEqual({ origem: "resposta_sugerida", avaliador_id: null, evidencia: "Questionário do atleta" });
    const pend = await p.db.query("select 1 from sugestao_pendente where atleta_id = $1 and indicador_id = $2", [id, alvo.indicadorId]);
    expect(pend.rows).toHaveLength(1);
    const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
      "select detalhes from auditoria where acao = 'responder_questionario' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes).toEqual({ indicadorId: alvo.indicadorId, geraSugestao: true });
  });

  it("pergunta tipo R (histórico familiar): grava resposta e não gera sugestão", async () => {
    const id = await p.idDe("SP-T07");
    const antes = await p.db.query("select 1 from avaliacoes where atleta_id = $1", [id]);
    const r = await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", { indicadorId: "amb_historico_familiar", resposta: "Sim" });
    expect(r.status).toBe(201);
    expect(r.corpo.notaSugerida).toBeNull();
    const depois = await p.db.query("select 1 from avaliacoes where atleta_id = $1", [id]);
    expect(depois.rows.length).toBe(antes.rows.length);
    const corpo = (await painel()).corpo;
    const hist = modulo(corpo, "amb").perguntas.find((q) => q.indicadorId === "amb_historico_familiar")!;
    expect(hist.resposta).toBe("Sim");
  });

  it("consentimento: ligar e desligar muda ocultosSemConsentimento do IBVAR", async () => {
    const ocultos = async () => (await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking")).corpo.ocultosSemConsentimento as number;
    const base = await ocultos();
    expect(base).toBe(1);

    const liga = await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: true });
    expect(liga.status).toBe(200);
    expect(liga.corpo).toMatchObject({ compartilharIbvar: true, termoVersao: "Piloto 18+ · v1" });
    expect(liga.corpo.atualizadoEm).toEqual(expect.any(String));
    expect(await ocultos()).toBe(0);
    const lista = await chamar(EMAILS_DEMO.ibvar, "GET", "/ranking");
    expect(JSON.stringify(lista.corpo.itens)).toContain("SP-T07");

    const desliga = await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: false });
    expect(desliga.corpo.compartilharIbvar).toBe(false);
    expect(await ocultos()).toBe(1);

    const id = await p.idDe("SP-T07");
    const hist = await p.db.query("select 1 from consentimentos where atleta_id = $1 and tipo = 'compartilhar_ibvar'", [id]);
    expect(hist.rows).toHaveLength(3); // a linha negada do seed + ligar + desligar
    expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: "sim" })).status).toBe(400);
  });

  it("revisões: validações, criar, listar como atleta e gestor, responder, 409", async () => {
    const c = (corpo: unknown) => chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", corpo);
    expect((await c({ motivo: "Motivo suficientemente longo." })).status).toBe(400);
    expect((await c({ pilarId: "amb", motivo: "curto" })).status).toBe(400);
    expect((await c({ pilarId: "nao_existe", motivo: "Motivo suficientemente longo." })).status).toBe(400);
    expect((await c({ indicadorId: "nao_existe", motivo: "Motivo suficientemente longo." })).status).toBe(400);
    expect((await c({ pilarId: "perf", indicadorId: "amb_apoio_familiar", motivo: "Motivo suficientemente longo." })).status).toBe(400);

    const a = await c({ pilarId: "perf", motivo: "Discordo da nota deste pilar." });
    expect(a.status).toBe(201);
    expect(a.corpo.status).toBe("aberto");
    const b = await c({ indicadorId: "amb_apoio_familiar", motivo: "A nota não reflete minha situação." });
    expect(b.status).toBe(201);

    const meus = await chamar(EMAILS_DEMO.atleta, "GET", "/revisoes");
    expect(meus.status).toBe(200);
    expect(meus.corpo).toHaveLength(2);
    // Pelo indicador, o pilar é derivado.
    const porIndicador = meus.corpo.find((r: { id: string }) => r.id === b.corpo.id);
    expect(porIndicador.pilar.id).toBe("amb");
    expect(porIndicador.indicador.id).toBe("amb_apoio_familiar");

    expect((await chamar(EMAILS_DEMO.treinadora, "GET", "/revisoes")).status).toBe(403);
    expect((await chamar(EMAILS_DEMO.ibvar, "GET", "/revisoes")).status).toBe(403);

    const todos = await chamar(EMAILS_DEMO.gestor, "GET", "/revisoes");
    expect(todos.corpo).toHaveLength(2);
    expect(todos.corpo[0].atleta.nome).toBe("Helena Vasques");

    expect((await chamar(EMAILS_DEMO.atleta, "PUT", `/revisoes/${a.corpo.id}`, { resposta: "Tentando responder." })).status).toBe(403);
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${a.corpo.id}`, { resposta: "x" })).status).toBe(400);
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", "/revisoes/999999", { resposta: "Resposta válida." })).status).toBe(404);
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", "/revisoes/abc", { resposta: "Resposta válida." })).status).toBe(400);

    const ok = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${a.corpo.id}`, { resposta: "Nota mantida, com a evidência anexada." });
    expect(ok.status).toBe(200);
    expect(ok.corpo).toMatchObject({ id: a.corpo.id, status: "respondido", resposta: "Nota mantida, com a evidência anexada." });
    expect(ok.corpo.respondidoEm).toEqual(expect.any(String));
    expect((await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${a.corpo.id}`, { resposta: "Outra resposta." })).status).toBe(409);

    // Abertos primeiro.
    const depois = await chamar(EMAILS_DEMO.gestor, "GET", "/revisoes");
    expect(depois.corpo.map((r: { status: string }) => r.status)).toEqual(["aberto", "respondido"]);
  });

  it("atleta só vê as próprias revisões; auditoria não guarda o motivo", async () => {
    const outro = await p.idDe("SC-T01");
    const gestorId = (await p.db.query<{ id: string }>("select id from usuarios where email = $1", [EMAILS_DEMO.gestor])).rows[0]!.id;
    await p.db.query(
      "insert into pedidos_revisao (atleta_id, motivo, criado_por) values ($1, 'Pedido de outro atleta, sigiloso.', $2)",
      [outro, gestorId],
    );
    const meus = await chamar(EMAILS_DEMO.atleta, "GET", "/revisoes");
    expect(meus.corpo.every((r: { atleta: { nome: string } }) => r.atleta.nome === "Helena Vasques")).toBe(true);
    expect(meus.texto).not.toContain("sigiloso");
    expect((await chamar(EMAILS_DEMO.gestor, "GET", "/revisoes")).corpo).toHaveLength(3);

    const aud = await p.db.query<{ detalhes: unknown }>("select detalhes from auditoria where entidade = 'pedidos_revisao'");
    expect(aud.rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(aud.rows)).not.toContain("Discordo");
  });
});

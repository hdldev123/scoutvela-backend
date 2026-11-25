import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAdminAuthFalso, tokenPara } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const LINK = "https://www.youtube.com/watch?v=abc123";

interface Ind {
  indicadorId: string;
  nome: string;
  pilarId: string;
  sugestao: { valor: number; evidencia: string | null; link: string | null; em: string } | null;
  treinador: {
    valor: number;
    origem: string;
    justificativa: string | null;
    avaliador: { nome: string } | null;
  } | null;
  diferenca: number | null;
}

describe("D9: autoavaliação", () => {
  let p: Piloto;
  let helena: string; // SP-T07, conta de atleta, da treinadora Ana
  let livia: string; // SC-T01, da Ana, sem conta de atleta no seed
  let marcosAtleta: string; // RS-T02, de outro treinador
  let authMarcos: { authorization: string };
  let cicloId: string;
  const obrigatorio = "perf_nacional"; // tipo T, evidência obrigatória
  const opcional = "tec_largada"; // tipo T, evidência opcional
  const opcional2 = "tat_leitura_vento";
  const questionario = "car_disponibilidade"; // tipo A
  let faltamAntes = 0;

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
    cicloId = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    quem: string | { authorization: string } | null,
    metodo: "GET" | "POST" | "PUT",
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
  const enviar = (quem: string | null, notas: unknown[]) =>
    chamar(quem, "POST", "/autoavaliacoes", { notas });
  const lancar = (corpo: object, id = helena, sufixo = "") =>
    chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${id}/avaliacoes${sufixo}`, corpo);
  const comparar = async (quem: string | { authorization: string } | null, id = helena, q = "") =>
    chamar(quem, "GET", `/atletas/${id}/autoavaliacao${q}`);
  const indicador = (corpo: { indicadores: Ind[] }, id: string) =>
    corpo.indicadores.find((i) => i.indicadorId === id)!;
  const ficha = async (email: string) => (await chamar(email, "GET", `/atletas/${helena}`)).corpo;
  const avisosDe = async (quem: string | { authorization: string }) =>
    (await chamar(quem, "GET", "/me/avisos")).corpo.itens as {
      tipo: string;
      referencia: Record<string, unknown>;
    }[];

  describe("parâmetro por indicador", () => {
    it("padrão: só os indicadores tipo T não calculados", async () => {
      const r = await chamar(EMAILS_DEMO.gestor, "GET", "/parametros");
      const todos = r.corpo.pilares.flatMap(
        (x: {
          indicadores: { id: string; tipo: string; calculado: boolean; autoavaliacao: boolean }[];
        }) => x.indicadores,
      );
      expect(todos.length).toBeGreaterThan(0);
      for (const i of todos) expect(i.autoavaliacao).toBe(i.tipo === "T" && !i.calculado);
    });

    it("gestor liga e desliga por indicador, com auditoria de antes e depois; A, R e calculado não ligam", async () => {
      const off = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        indicadores: [{ id: opcional2, autoavaliacao: false }],
      });
      expect(off.status).toBe(200);
      const ind = (c: { pilares: { indicadores: { id: string; autoavaliacao: boolean }[] }[] }) =>
        c.pilares.flatMap((x) => x.indicadores).find((i) => i.id === opcional2)!;
      expect(ind(off.corpo).autoavaliacao).toBe(false);
      const aud = await p.db.query<{ detalhes: { autoavaliacao: unknown; indicadores?: unknown } }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      );
      expect(aud.rows[0]!.detalhes.autoavaliacao).toEqual({
        antes: { [opcional2]: true },
        depois: { [opcional2]: false },
      });
      expect(aud.rows[0]!.detalhes.indicadores).toBeUndefined();
      // Desligado: o atleta não envia.
      const recusado = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional2, valor: 3 }]);
      expect(recusado.status).toBe(400);
      expect(recusado.corpo.campos[0].campo).toBe("notas.0.indicadorId");
      const on = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        indicadores: [{ id: opcional2, autoavaliacao: true, evidencia: "opcional" }],
      });
      expect(on.status).toBe(200);
      expect(ind(on.corpo).autoavaliacao).toBe(true);

      for (const id of [questionario, "cf_peso_kg"]) {
        const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
          indicadores: [{ id, autoavaliacao: true }],
        });
        expect(r.status, id).toBe(400);
      }
      // Sem nenhum campo no item: 400; papel errado: 403.
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
            indicadores: [{ id: opcional }],
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await chamar(EMAILS_DEMO.treinadora, "PUT", "/parametros", {
            indicadores: [{ id: opcional, autoavaliacao: false }],
          })
        ).status,
      ).toBe(403);
    });
  });

  describe("envio do atleta", () => {
    it("só o atleta envia: gestor, treinador e IBVAR 403; sem token 401", async () => {
      const notas = [{ indicadorId: opcional, valor: 3 }];
      expect((await enviar(EMAILS_DEMO.gestor, notas)).status).toBe(403);
      expect((await enviar(EMAILS_DEMO.treinadora, notas)).status).toBe(403);
      expect((await enviar(EMAILS_DEMO.ibvar, notas)).status).toBe(403);
      expect((await enviar(null, notas)).status).toBe(401);
    });

    it("validações por campo: indicador fora da autoavaliação, evidência obrigatória, link, nota, anexo", async () => {
      const q = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: questionario, valor: 3 }]);
      expect(q.status).toBe(400);
      expect(q.corpo.campos).toEqual([
        { campo: "notas.0.indicadorId", mensagem: expect.any(String) },
      ]);
      const inexistente = await enviar(EMAILS_DEMO.atleta, [
        { indicadorId: "nao_existe", valor: 3 },
      ]);
      expect(inexistente.corpo.campos[0].campo).toBe("notas.0.indicadorId");
      const calculado = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: "cf_peso_kg", valor: 3 }]);
      expect(calculado.status).toBe(400);

      const semEvid = await enviar(EMAILS_DEMO.atleta, [
        { indicadorId: opcional, valor: 3 },
        { indicadorId: obrigatorio, valor: 3 },
      ]);
      expect(semEvid.status).toBe(400);
      expect(semEvid.corpo.campos).toEqual([
        { campo: "notas.1.evidencia", mensagem: expect.any(String) },
      ]);
      expect(
        (
          await enviar(EMAILS_DEMO.atleta, [
            { indicadorId: obrigatorio, valor: 3, evidencia: "  " },
          ])
        ).status,
      ).toBe(400);

      for (const link of ["http://exemplo.com/v", "javascript:alert(1)"]) {
        const r = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor: 3, link }]);
        expect(r.status, link).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("notas.0.link");
      }
      for (const valor of [6, -1, 2.5]) {
        const r = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor }]);
        expect(r.status, String(valor)).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("notas.0.valor");
      }
      const repetido = await enviar(EMAILS_DEMO.atleta, [
        { indicadorId: opcional, valor: 3 },
        { indicadorId: opcional, valor: 4 },
      ]);
      expect(repetido.status).toBe(400);
      expect(repetido.corpo.campos[0].campo).toBe("notas.1.indicadorId");
      expect((await enviar(EMAILS_DEMO.atleta, [])).status).toBe(400);

      // Anexo de outro atleta e anexo inexistente.
      const alheio = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${livia}/evidencias`, {
        nomeArquivo: "a.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: pdf().toString("base64"),
      });
      expect(alheio.status).toBe(201);
      for (const anexoId of [alheio.corpo.id, crypto.randomUUID()]) {
        const r = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor: 3, anexoId }]);
        expect(r.status).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("notas.0.anexoId");
      }
      const n = await p.db.query<{ n: string }>(
        "select count(*)::text as n from avaliacoes where atleta_id = $1 and origem = 'autoavaliacao'",
        [helena],
      );
      expect(n.rows[0]!.n).toBe("0");
    });

    it("sem ciclo aberto: 409", async () => {
      await p.db.query("update ciclos_avaliacao set status = 'fechado' where id = $1", [cicloId]);
      try {
        const r = await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor: 3 }]);
        expect(r.status).toBe(409);
      } finally {
        await p.db.query("update ciclos_avaliacao set status = 'aberto' where id = $1", [cicloId]);
      }
    });

    it("grava a sugestão sem avaliador, no ciclo aberto, e avisa o treinador; o score não muda", async () => {
      const antes = await ficha(EMAILS_DEMO.gestor);
      const pendAntes = await faltam();
      faltamAntes = pendAntes;

      avancar(1);
      const anexo = await chamar(EMAILS_DEMO.atleta, "POST", `/atletas/${helena}/evidencias`, {
        nomeArquivo: "prova.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: pdf().toString("base64"),
      });
      expect(anexo.status).toBe(201);
      const r = await enviar(EMAILS_DEMO.atleta, [
        { indicadorId: opcional, valor: 2 },
        { indicadorId: opcional2, valor: 5, link: LINK, anexoId: anexo.corpo.id },
        { indicadorId: obrigatorio, valor: 4, evidencia: "Top 5 no Brasileiro" },
      ]);
      expect(r.status).toBe(201);
      expect(r.corpo).toEqual({ cicloId, enviadas: 3 });

      const linhas = await p.db.query<{
        origem: string;
        avaliador_id: string | null;
        ciclo_id: string;
      }>(
        "select origem, avaliador_id, ciclo_id from avaliacoes where atleta_id = $1 and origem = 'autoavaliacao'",
        [helena],
      );
      expect(linhas.rows).toHaveLength(3);
      for (const l of linhas.rows) {
        expect(l.avaliador_id).toBeNull();
        expect(l.ciclo_id).toBe(cicloId);
      }

      // A sugestão nunca entra no score, na faixa, nos gates, no ranking nem nas pendências.
      const depois = await ficha(EMAILS_DEMO.gestor);
      expect(depois.score).toBe(antes.score);
      expect(depois.faixa).toEqual(antes.faixa);
      expect(depois.gates).toEqual(antes.gates);
      expect(depois.preenchidos).toBe(antes.preenchidos);
      expect(depois.dadosAtualizadosEm).toBe(antes.dadosAtualizadosEm);
      const ind = depois.pilares
        .flatMap((x: { indicadores: { id: string }[] | null }) => x.indicadores ?? [])
        .find((i: { id: string }) => i.id === opcional);
      expect(ind.nota).toBe(
        antes.pilares
          .flatMap((x: { indicadores: { id: string }[] | null }) => x.indicadores ?? [])
          .find((i: { id: string }) => i.id === opcional).nota,
      );
      expect(ind.sugestaoPendente).toMatchObject({ valor: 2 });
      expect(await faltam()).toBe(pendAntes);

      // Aviso ao treinador, só com a contagem.
      const avisos = (await avisosDe(EMAILS_DEMO.treinadora)).filter(
        (a) => a.tipo === "atleta_autoavaliou",
      );
      expect(avisos).toHaveLength(1);
      expect(avisos[0]!.referencia).toEqual({ quantidade: 3 });

      // Auditoria sem nota nem texto.
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'enviar_autoavaliacao' order by id desc limit 1",
      );
      const txt = JSON.stringify(aud.rows[0]!.detalhes);
      expect(txt).not.toContain("Brasileiro");
      expect(txt).not.toContain("youtube");
      expect(txt).toContain(obrigatorio);
    });

    it("reenvio: vale a sugestão mais recente do ciclo, e a série só recebe inserções", async () => {
      avancar(1);
      expect((await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor: 3 }])).status).toBe(
        201,
      );
      const r = await comparar(EMAILS_DEMO.atleta);
      expect(indicador(r.corpo, opcional).sugestao!.valor).toBe(3);
      const n = await p.db.query<{ n: string }>(
        "select count(*)::text as n from avaliacoes where atleta_id = $1 and indicador_id = $2 and origem = 'autoavaliacao'",
        [helena, opcional],
      );
      expect(n.rows[0]!.n).toBe("2");
    });
  });

  async function faltam(): Promise<number> {
    const r = await chamar(EMAILS_DEMO.gestor, "GET", `/ciclos/${cicloId}/pendencias`);
    const t = (
      r.corpo.treinadores as { atletasPendentes: { id: string; faltam: number }[] }[]
    ).flatMap((x) => x.atletasPendentes);
    return t.find((a) => a.id === helena)?.faltam ?? 0;
  }

  describe("decisão do treinador", () => {
    it("a prévia devolve a sugestão do atleta por indicador", async () => {
      const r = await lancar({ notas: [{ indicadorId: opcional, valor: 3 }] }, helena, "/previa");
      expect(r.status).toBe(200);
      const sug = r.corpo.sugestoesAtleta as { indicadorId: string; valor: number }[];
      expect(sug.map((s) => s.indicadorId).sort()).toEqual(
        [obrigatorio, opcional, opcional2].sort(),
      );
      expect(sug.find((s) => s.indicadorId === opcional)!.valor).toBe(3);
    });

    it("nota diferente da sugestão sem justificativa: 400 por campo, na prévia e no lançamento", async () => {
      const corpo = { notas: [{ indicadorId: opcional, valor: 4 }] };
      for (const sufixo of ["", "/previa"]) {
        const r = await lancar(corpo, helena, sufixo);
        expect(r.status).toBe(400);
        expect(r.corpo.campos).toEqual([
          { campo: "notas.0.justificativa", mensagem: expect.any(String) },
        ]);
      }
      const longa = await lancar({
        notas: [{ indicadorId: opcional, valor: 4, justificativa: "x".repeat(501) }],
      });
      expect(longa.status).toBe(400);
      expect(longa.corpo.campos[0].campo).toBe("notas.0.justificativa");
      const vazia = await lancar({
        notas: [{ indicadorId: opcional, valor: 4, justificativa: "   " }],
      });
      expect(vazia.status).toBe(400);
    });

    it("corrigir com justificativa grava a nota, avisa o atleta e entra no score; aprovar grava autoavaliacao_aprovada", async () => {
      avancar(1);
      const r = await lancar({
        notas: [
          { indicadorId: opcional, valor: 4, justificativa: "Largada média, melhorou pouco" },
          { indicadorId: opcional2, valor: 5 },
          { indicadorId: obrigatorio, valor: 4, evidencia: "Súmula do Brasileiro" },
        ],
      });
      expect(r.status).toBe(201);
      const linhas = await p.db.query<{
        indicador_id: string;
        origem: string;
        justificativa: string | null;
        avaliador_id: string | null;
      }>(
        "select indicador_id, origem, justificativa, avaliador_id from avaliacoes where atleta_id = $1 and origem <> 'autoavaliacao' and indicador_id = any($2) order by id",
        [helena, [opcional, opcional2, obrigatorio]],
      );
      const por = Object.fromEntries(linhas.rows.map((l) => [l.indicador_id, l]));
      expect(por[opcional]).toMatchObject({
        origem: "avaliacao",
        justificativa: "Largada média, melhorou pouco",
      });
      expect(por[opcional2]).toMatchObject({
        origem: "autoavaliacao_aprovada",
        justificativa: null,
      });
      expect(por[obrigatorio]!.origem).toBe("autoavaliacao_aprovada");
      for (const l of linhas.rows) expect(l.avaliador_id).not.toBeNull();

      const depois = await ficha(EMAILS_DEMO.gestor);
      const notaFicha = depois.pilares
        .flatMap((x: { indicadores: { id: string }[] | null }) => x.indicadores ?? [])
        .find((i: { id: string }) => i.id === opcional);
      expect(notaFicha).toMatchObject({ nota: 4, origem: "avaliacao", sugestaoPendente: null });
      expect(await faltam()).toBeLessThanOrEqual(faltamAntes);

      // Só a correção avisa o atleta; aprovar não avisa.
      const avisos = (await avisosDe(EMAILS_DEMO.atleta)).filter(
        (a) => a.tipo === "autoavaliacao_corrigida",
      );
      expect(avisos).toHaveLength(1);
      expect(avisos[0]!.referencia).toEqual({ indicadorId: opcional });

      // Auditoria sem a justificativa.
      const aud = await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = 'lancar_avaliacao' order by id desc limit 1",
      );
      expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("Largada");
    });

    it("justificativa também vale sem sugestão (opcional)", async () => {
      avancar(1);
      const r = await lancar(
        { notas: [{ indicadorId: "tec_boat_handling", valor: 3, justificativa: "Observação" }] },
        livia,
      );
      expect(r.status).toBe(201);
      const l = await p.db.query<{ origem: string; justificativa: string }>(
        "select origem, justificativa from avaliacoes where atleta_id = $1 and indicador_id = 'tec_boat_handling' order by id desc limit 1",
        [livia],
      );
      expect(l.rows[0]).toEqual({ origem: "avaliacao", justificativa: "Observação" });
    });
  });

  describe("leitura: atleta × treinador", () => {
    it("traz as duas notas, a diferença e a justificativa; resumo por pilar só para o gestor", async () => {
      const r = await comparar(EMAILS_DEMO.gestor);
      expect(r.status).toBe(200);
      expect(r.corpo.ciclo).toMatchObject({ id: cicloId, status: "aberto" });
      const lar = indicador(r.corpo, opcional);
      expect(lar.sugestao!.valor).toBe(3);
      expect(lar.treinador).toMatchObject({
        valor: 4,
        origem: "avaliacao",
        justificativa: "Largada média, melhorou pouco",
      });
      expect(lar.treinador!.avaliador!.nome).toEqual(expect.any(String));
      expect(lar.diferenca).toBe(1);
      expect(indicador(r.corpo, opcional2)).toMatchObject({
        diferenca: 0,
        treinador: { origem: "autoavaliacao_aprovada" },
      });
      const evid = indicador(r.corpo, obrigatorio);
      expect(evid.sugestao!.evidencia).toBe("Top 5 no Brasileiro");
      // Indicador sem sugestão nem nota: nulos.
      const sem = r.corpo.indicadores.find(
        (i: Ind) => i.sugestao === null && i.treinador === null,
      ) as Ind;
      expect(sem.diferenca).toBeNull();

      const resumo = r.corpo.resumoPorPilar as {
        pilarId: string;
        nomeCurto: string;
        diferencaMedia: number | null;
      }[];
      const pilarLar = resumo.find((x) => x.pilarId === lar.pilarId)!;
      expect(pilarLar.diferencaMedia).not.toBeNull();
      expect(resumo.some((x) => x.diferencaMedia === null)).toBe(true);

      for (const quem of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
        const o = await comparar(quem);
        expect(o.status).toBe(200);
        expect(o.corpo.resumoPorPilar).toBeNull();
        expect(indicador(o.corpo, opcional).treinador!.justificativa).toBe(
          "Largada média, melhorou pouco",
        );
      }
    });

    it("acesso: IBVAR 403, sem token 401, outro treinador e outro atleta 404; ciclo inexistente 404", async () => {
      expect((await comparar(EMAILS_DEMO.ibvar)).status).toBe(403);
      expect((await comparar(null)).status).toBe(401);
      expect((await comparar(authMarcos)).status).toBe(404);
      // A atleta da conta só vê a própria autoavaliação.
      expect((await comparar(EMAILS_DEMO.atleta, livia)).status).toBe(404);
      expect(
        (await comparar(EMAILS_DEMO.gestor, helena, `?ciclo=${crypto.randomUUID()}`)).status,
      ).toBe(404);
      expect((await comparar(EMAILS_DEMO.gestor, helena, "?ciclo=xyz")).status).toBe(400);
    });

    it("ciclo fechado: sem ?ciclo abre o ciclo aberto; com ?ciclo, o pedido", async () => {
      const outro = (
        await p.db.query<{ id: string }>(
          "select id from ciclos_avaliacao where status = 'fechado' order by inicio desc limit 1",
        )
      ).rows[0];
      if (outro) {
        const r = await comparar(EMAILS_DEMO.gestor, helena, `?ciclo=${outro.id}`);
        expect(r.status).toBe(200);
        expect(r.corpo.ciclo.id).toBe(outro.id);
        expect(r.corpo.indicadores.every((i: Ind) => i.sugestao === null)).toBe(true);
      }
    });

    it("histórico do indicador: sugestão pendente aparece como pendente; decidida some; justificativa aparece", async () => {
      avancar(1);
      expect((await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional, valor: 1 }])).status).toBe(
        201,
      );
      const h = await chamar(
        EMAILS_DEMO.treinadora,
        "GET",
        `/atletas/${helena}/indicadores/${opcional}/historico`,
      );
      expect(h.corpo[0]).toMatchObject({ origem: "autoavaliacao", pendente: true, valor: 1 });
      const nota = h.corpo.find((x: { origem: string }) => x.origem === "avaliacao");
      expect(nota.justificativa).toBe("Largada média, melhorou pouco");
      // Ficha: sugestão pendente enquanto o treinador não decide.
      const f = await ficha(EMAILS_DEMO.atleta);
      const ind = f.pilares
        .flatMap((x: { indicadores: { id: string }[] | null }) => x.indicadores ?? [])
        .find((i: { id: string }) => i.id === opcional);
      expect(ind.sugestaoPendente).toMatchObject({ valor: 1 });
      expect(ind.justificativa).toBe("Largada média, melhorou pouco");
    });

    it("IBVAR nunca recebe sugestão, justificativa nem a origem de autoavaliação", async () => {
      // Livia consentiu com o IBVAR no seed: repete o fluxo nela.
      const consentiu = await p.db.query<{ concedido: boolean }>(
        "select concedido from consentimento_atual where atleta_id = $1 and tipo = 'compartilhar_ibvar'",
        [livia],
      );
      expect(consentiu.rows[0]?.concedido).toBe(true);
      avancar(1);
      await p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em)
         values ($1, $2, $3, 2, null, 'autoavaliacao', null, $4)`,
        [livia, opcional, cicloId, agora],
      );
      avancar(1);
      expect((await lancar({ notas: [{ indicadorId: opcional2, valor: 4 }] }, livia)).status).toBe(
        201,
      );
      avancar(1);
      expect(
        (
          await lancar(
            { notas: [{ indicadorId: opcional, valor: 4, justificativa: "Sigiloso" }] },
            livia,
          )
        ).status,
      ).toBe(201);

      const f = await chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${livia}`);
      expect(f.status).toBe(200);
      const txt = JSON.stringify(f.corpo);
      expect(txt).not.toContain("Sigiloso");
      expect(txt).not.toContain("autoavaliacao");
      const h = await chamar(
        EMAILS_DEMO.ibvar,
        "GET",
        `/atletas/${livia}/indicadores/${opcional}/historico`,
      );
      expect(h.status).toBe(200);
      const th = JSON.stringify(h.corpo);
      expect(th).not.toContain("Sigiloso");
      expect(th).not.toContain("autoavaliacao");
      expect(h.corpo.every((x: { justificativa: unknown }) => x.justificativa === null)).toBe(true);
      expect((await comparar(EMAILS_DEMO.ibvar, livia)).status).toBe(403);
    });
  });

  describe("a sugestão fora dos cálculos", () => {
    it("investimento e ranking não mudam com a sugestão do atleta", async () => {
      const ranking = async () =>
        JSON.stringify((await chamar(EMAILS_DEMO.gestor, "GET", "/ranking")).corpo);
      const investimento = async () =>
        JSON.stringify((await chamar(EMAILS_DEMO.gestor, "GET", "/investimento")).corpo);
      const [r0, i0] = [await ranking(), await investimento()];
      avancar(1);
      expect(
        (await enviar(EMAILS_DEMO.atleta, [{ indicadorId: opcional2, valor: 0 }])).status,
      ).toBe(201);
      expect(await ranking()).toBe(r0);
      expect(await investimento()).toBe(i0);
    });

    it("série só de inserção: a justificativa é a única coluna de texto da nota aceita na anonimização", async () => {
      await expect(
        p.db.query(
          "update avaliacoes set justificativa = 'x' where origem = 'avaliacao' and justificativa is not null",
        ),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(
        p.db.query("update avaliacoes set valor = 1 where origem = 'avaliacao'"),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(
        p.db.query("delete from avaliacoes where origem = 'autoavaliacao'"),
      ).rejects.toThrow(/aceita só inserção/);
    });
  });
});

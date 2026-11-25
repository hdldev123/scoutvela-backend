import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAdminAuthFalso, tokenPara } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);
const LINK = "https://resultados.exemplo.invalid/mundial-ilca-6";

interface Resultado {
  id: string;
  data: string;
  nivel: string;
  evento: string;
  edicao: number;
  posicao: number;
  tamanhoFrota: number | null;
  internacional: boolean;
  fonte: string;
  linkOficial: string | null;
  status: string;
  motivo: string | null;
  anexo: { id: string; nomeArquivo: string } | null;
  validadoPor: { id: string; nome: string } | null;
  validadoEm: string | null;
}

interface IndicadorFicha {
  id: string;
  nota: number | null;
  origem: string | null;
  explicacao: string | null;
  resultado: { nivel: string; posicao: number; edicao: number; evento: string } | null;
}

describe("D10: resultados informados pelo atleta, validados pelo treinador", () => {
  let p: Piloto;
  let helena: string; // SP-T07, conta de atleta, da treinadora Ana
  let livia: string; // SC-T01, da Ana, consentiu com o IBVAR
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

  type Quem = string | { authorization: string } | null;
  const chamar = async (
    quem: Quem,
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
  const informar = (corpo: Record<string, unknown>, quem: Quem = EMAILS_DEMO.atleta) =>
    chamar(quem, "POST", "/me/resultados", {
      evento: "Mundial de ILCA 6",
      nivel: "mundial",
      ano: 2026,
      posicao: 12,
      linkOficial: LINK,
      ...corpo,
    });
  const decidir = (quem: Quem, id: string, corpo: unknown) =>
    chamar(quem, "PUT", `/resultados/${id}/validacao`, corpo);
  const listar = (quem: Quem, id = helena, q = "") =>
    chamar(quem, "GET", `/atletas/${id}/resultados${q}`);
  const ficha = async (quem: string, id = helena) =>
    (await chamar(quem, "GET", `/atletas/${id}`)).corpo;
  const indicador = (f: { pilares: { indicadores: IndicadorFicha[] | null }[] }, id: string) =>
    f.pilares.flatMap((x) => x.indicadores ?? []).find((i) => i.id === id)!;
  const sumula = async (atleta = helena, quem: string = EMAILS_DEMO.atleta) =>
    chamar(quem, "POST", `/atletas/${atleta}/evidencias`, {
      nomeArquivo: "sumula.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
      categoria: "sumula",
    });
  const avisosDe = async (quem: Quem) =>
    (await chamar(quem, "GET", "/me/avisos")).corpo.itens as {
      tipo: string;
      referencia: Record<string, unknown>;
    }[];

  describe("POST /me/resultados", () => {
    it("com o link oficial: nasce pendente, com edição e data do último dia do ano; avisa o treinador", async () => {
      const r = await informar({ evento: "Mundial de ILCA 6", ano: 2025 });
      expect(r.status).toBe(201);
      expect(r.corpo).toMatchObject({
        nivel: "mundial",
        evento: "Mundial de ILCA 6",
        edicao: 2025,
        data: "2025-12-31",
        posicao: 12,
        tamanhoFrota: null,
        internacional: true,
        fonte: "atleta",
        linkOficial: LINK,
        status: "pendente",
        motivo: null,
        anexo: null,
        validadoPor: null,
        validadoEm: null,
      });
      const linha = await p.db.query<{
        nivel: string;
        pontos_cbvela: string | null;
        registrado_por: string;
      }>("select nivel, pontos_cbvela, registrado_por from resultados_regata where id = $1", [
        r.corpo.id,
      ]);
      expect(linha.rows[0]).toMatchObject({ nivel: "mundial", pontos_cbvela: null });
      const aviso = (await avisosDe(EMAILS_DEMO.treinadora)).find(
        (a) => a.tipo === "atleta_lancou_resultado",
      );
      expect(aviso?.referencia).toEqual({ resultadoId: r.corpo.id });
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'informar_resultado' order by id desc limit 1",
      );
      expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("Mundial");
      expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("invalid");
      expect(aud.rows[0]!.detalhes.resultadoId).toBe(r.corpo.id);
    });

    it("no ano atual a data é hoje; a data informada vale; frota opcional e conferida com a colocação", async () => {
      const hoje = await informar({
        evento: "Pan-Americano de ILCA 6",
        nivel: "continental",
        ano: 2026,
      });
      expect(hoje.status).toBe(201);
      expect(hoje.corpo).toMatchObject({
        data: "2026-11-06",
        nivel: "continental",
        internacional: true,
      });

      const comData = await informar({
        evento: "Sul-Americano de ILCA 6",
        nivel: "continental",
        ano: 2024,
        data: "2024-03-14",
        tamanhoFrota: 18,
        posicao: 2,
      });
      expect(comData.status).toBe(201);
      expect(comData.corpo).toMatchObject({ data: "2024-03-14", tamanhoFrota: 18, edicao: 2024 });

      const nacional = await informar({
        evento: "Brasileiro de ILCA 6",
        nivel: "nacional",
        ano: 2025,
        posicao: 2,
      });
      expect(nacional.corpo).toMatchObject({ nivel: "brasileiro", internacional: false });
    });

    it("com a súmula anexada: o anexo volta no resultado e não sai mais pela remoção (409)", async () => {
      const s = await sumula();
      expect(s.status).toBe(201);
      const r = await informar({
        evento: "Youth World 2026",
        ano: 2026,
        linkOficial: undefined,
        anexoId: s.corpo.id,
      });
      expect(r.status).toBe(201);
      expect(r.corpo.anexo).toMatchObject({ id: s.corpo.id });
      expect(r.corpo.linkOficial).toBeNull();
      const remover = await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${s.corpo.id}`);
      expect(remover.status).toBe(409);
      expect(remover.corpo.mensagem).toContain("resultado");
    });

    it("exige a súmula ou o link: 400 nos dois campos", async () => {
      const r = await informar({ evento: "Sem prova", linkOficial: undefined });
      expect(r.status).toBe(400);
      expect(r.corpo.campos.map((c: { campo: string }) => c.campo).sort()).toEqual([
        "anexoId",
        "linkOficial",
      ]);
    });

    it("validações por campo", async () => {
      const campo = async (corpo: Record<string, unknown>) => {
        const r = await informar({ evento: "Evento de validação", ...corpo });
        expect(r.status, JSON.stringify(corpo)).toBe(400);
        return r.corpo.campos.map((c: { campo: string }) => c.campo);
      };
      expect(await campo({ evento: "A" })).toContain("evento");
      expect(await campo({ evento: "x".repeat(121) })).toContain("evento");
      expect(await campo({ nivel: "estadual" })).toContain("nivel");
      expect(await campo({ ano: 1999 })).toContain("ano");
      expect(await campo({ ano: 2027 })).toContain("ano");
      expect(await campo({ posicao: 0 })).toContain("posicao");
      expect(await campo({ tamanhoFrota: 5, posicao: 6 })).toContain("posicao");
      expect(await campo({ data: "2026-11-07" })).toContain("data");
      expect(await campo({ data: "2025-05-01", ano: 2026 })).toContain("data");
      expect(await campo({ linkOficial: "http://resultados.exemplo.invalid/x" })).toContain(
        "linkOficial",
      );
      expect(await campo({ anexoId: "nao-e-uuid", linkOficial: undefined })).toContain("anexoId");
    });

    it("anexo inexistente, de outra categoria ou de outro atleta: 400 em anexoId", async () => {
      const outraCategoria = await chamar(
        EMAILS_DEMO.atleta,
        "POST",
        `/atletas/${helena}/evidencias`,
        {
          nomeArquivo: "nota.pdf",
          tipoMime: "application/pdf",
          conteudoBase64: pdf().toString("base64"),
        },
      );
      const alheio = await sumula(livia, EMAILS_DEMO.gestor);
      for (const id of [outraCategoria.corpo.id, alheio.corpo.id, crypto.randomUUID()]) {
        const r = await informar({ evento: "Súmula errada", linkOficial: undefined, anexoId: id });
        expect(r.status).toBe(400);
        expect(r.corpo.campos).toEqual([{ campo: "anexoId", mensagem: expect.any(String) }]);
      }
    });

    it("edição repetida do mesmo evento (nome sem diferença de caixa e espaços): 409", async () => {
      const primeira = await informar({ evento: "Copa Mundial de Teste", ano: 2023 });
      expect(primeira.status).toBe(201);
      const repetida = await informar({ evento: "  copa   MUNDIAL de teste ", ano: 2023 });
      expect(repetida.status).toBe(409);
      // Outro nível com o mesmo nome é outro evento.
      expect(
        (await informar({ evento: "Copa Mundial de Teste", nivel: "continental", ano: 2023 }))
          .status,
      ).toBe(201);
    });

    it("acima de edicoes_max (4) edições do mesmo evento: 409; recusada não conta e libera a vaga", async () => {
      const ids: string[] = [];
      for (const ano of [2022, 2023, 2024, 2025]) {
        const r = await informar({ evento: "Evento de limite", ano });
        expect(r.status).toBe(201);
        ids.push(r.corpo.id);
      }
      const quinta = await informar({ evento: "Evento de limite", ano: 2026 });
      expect(quinta.status).toBe(409);
      expect(quinta.corpo.mensagem).toContain("4");

      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, ids[0]!, {
            decisao: "recusar",
            motivo: "Súmula ilegível",
          })
        ).status,
      ).toBe(200);
      expect((await informar({ evento: "Evento de limite", ano: 2026 })).status).toBe(201);
      // A edição recusada pode ser informada de novo.
      expect((await informar({ evento: "Evento de limite", ano: 2022 })).status).toBe(409); // agora são 4 de novo
    });

    it("o limite segue a regra editada pelo gestor", async () => {
      const r = await chamar(EMAILS_DEMO.gestor, "GET", "/parametros");
      const regra = (r.corpo.regras as { codigo: string; valor: Record<string, unknown> }[]).find(
        (x) => x.codigo === "PERF_RESULTADOS",
      )!;
      const reduzida = { ...regra.valor, edicoes_max: 1 };
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
            regras: { PERF_RESULTADOS: reduzida },
          })
        ).status,
      ).toBe(200);
      const a = await informar({ evento: "Evento de uma edição", ano: 2025 });
      expect(a.status).toBe(201);
      expect((await informar({ evento: "Evento de uma edição", ano: 2026 })).status).toBe(409);
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
            regras: { PERF_RESULTADOS: regra.valor },
          })
        ).status,
      ).toBe(200);
    });

    it("só o atleta informa: gestor, treinador e IBVAR 403; sem token 401", async () => {
      for (const quem of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
        expect((await informar({}, quem)).status).toBe(403);
      }
      expect((await informar({}, null)).status).toBe(401);
    });

    it("corpo com campo desconhecido: 400", async () => {
      expect((await informar({ status: "validado" })).status).toBe(400);
    });
  });

  describe("PUT /resultados/:id/validacao e a nota calculada", () => {
    let mundial: Resultado;
    let nacional: Resultado;
    let notaAntes: number;

    beforeAll(async () => {
      mundial = (await informar({ evento: "Mundial do Teste de Nota", ano: 2026, posicao: 3 }))
        .corpo;
      nacional = (
        await informar({
          evento: "Brasileiro do Teste de Nota",
          nivel: "nacional",
          ano: 2026,
          posicao: 1,
        })
      ).corpo;
      notaAntes = (await ficha(EMAILS_DEMO.gestor)).score;
    });

    it("pendente não conta: a nota do indicador e o score não mudam", async () => {
      const f = await ficha(EMAILS_DEMO.gestor);
      expect(f.score).toBe(notaAntes);
      expect(indicador(f, "perf_mundial")).toMatchObject({
        nota: null,
        origem: null,
        explicacao: null,
      });
      const lista = await listar(EMAILS_DEMO.gestor, helena, "?status=pendente");
      expect(lista.corpo.itens.some((x: Resultado) => x.id === mundial.id)).toBe(true);
      const naFicha = (f.resultados as Resultado[]).find((x) => x.id === mundial.id)!;
      expect(naFicha.status).toBe("pendente");
    });

    it("treinador do atleta valida: vira nota calculada, com a explicação, e o score sobe", async () => {
      avancar(5);
      const r = await decidir(EMAILS_DEMO.treinadora, mundial.id, { decisao: "validar" });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({
        status: "validado",
        motivo: null,
        validadoPor: { nome: "Ana Ribeiro" },
      });
      expect(r.corpo.validadoEm).toBe(agora.toISOString());

      const f = await ficha(EMAILS_DEMO.gestor);
      const ind = indicador(f, "perf_mundial");
      expect(ind).toMatchObject({
        nota: 5, // 3º lugar: até o 3º vale 5
        origem: "calculado",
        resultado: {
          nivel: "mundial",
          posicao: 3,
          edicao: 2026,
          evento: "Mundial do Teste de Nota",
        },
      });
      expect(ind.explicacao).toBe(
        "Melhor colocação validada no Mundial: 3º em 2026 (Mundial do Teste de Nota)",
      );
      // O score sobe pelo pilar de Performance: média sai de (3 + 3 + 2 ... ) e ganha uma nota 5.
      expect(f.score).toBeGreaterThan(notaAntes);
      const aviso = (await avisosDe(EMAILS_DEMO.atleta)).find(
        (a) => a.tipo === "resultado_validado",
      );
      expect(aviso?.referencia).toEqual({ resultadoId: mundial.id });
    });

    it("o resultado validado passa a contar no G3 (evento internacional) e some do pendente", async () => {
      const f = await ficha(EMAILS_DEMO.gestor);
      const g3 = f.gates.itens.find((g: { gate: number }) => g.gate === 3);
      // Seed: nenhum evento internacional em 24 meses; o Mundial validado de 2026 conta.
      expect(g3.motivo).toContain("1 evento internacional");
      const pend = await listar(EMAILS_DEMO.atleta, helena, "?status=pendente");
      expect(pend.corpo.itens.some((x: Resultado) => x.id === mundial.id)).toBe(false);
    });

    it("recusar exige motivo (400 em motivo); recusado não conta e o atleta é avisado", async () => {
      const sem = await decidir(EMAILS_DEMO.treinadora, nacional.id, { decisao: "recusar" });
      expect(sem.status).toBe(400);
      expect(sem.corpo.campos).toEqual([{ campo: "motivo", mensagem: expect.any(String) }]);
      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, nacional.id, {
            decisao: "recusar",
            motivo: "x".repeat(301),
          })
        ).status,
      ).toBe(400);

      const r = await decidir(EMAILS_DEMO.gestor, nacional.id, {
        decisao: "recusar",
        motivo: "Súmula de outra prova",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ status: "recusado", motivo: "Súmula de outra prova" });
      const f = await ficha(EMAILS_DEMO.gestor);
      expect(indicador(f, "perf_nacional").nota).toBe(0); // só vale o Brasileiro 2026 do seed (8º): fora do pódio
      const aviso = (await avisosDe(EMAILS_DEMO.atleta)).find(
        (a) => a.tipo === "resultado_recusado",
      );
      expect(aviso?.referencia).toEqual({ resultadoId: nacional.id });
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'decidir_resultado' order by id desc limit 1",
      );
      expect(aud.rows[0]!.detalhes).toEqual({
        resultadoId: nacional.id,
        decisao: "recusar",
        comMotivo: true,
      });
    });

    it("repetir a situação atual: 409; mudar de validado para recusado vale e tira a nota", async () => {
      expect(
        (await decidir(EMAILS_DEMO.treinadora, mundial.id, { decisao: "validar" })).status,
      ).toBe(409);
      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, nacional.id, {
            decisao: "recusar",
            motivo: "outra vez",
          })
        ).status,
      ).toBe(409);
      avancar(5);
      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, mundial.id, {
            decisao: "recusar",
            motivo: "Frota errada",
          })
        ).status,
      ).toBe(200);
      expect(indicador(await ficha(EMAILS_DEMO.gestor), "perf_mundial").nota).toBeNull();
      avancar(5);
      expect(
        (await decidir(EMAILS_DEMO.treinadora, mundial.id, { decisao: "validar" })).status,
      ).toBe(200);
      expect(indicador(await ficha(EMAILS_DEMO.gestor), "perf_mundial").nota).toBe(5);
      // Série: nenhuma validação foi sobrescrita.
      const n = await p.db.query<{ n: string }>(
        "select count(*)::text as n from validacoes_resultado where resultado_id = $1",
        [mundial.id],
      );
      expect(Number(n.rows[0]!.n)).toBe(3);
    });

    it("quem pode decidir: outro treinador 404, atleta e IBVAR 403, sem token 401, inexistente 404", async () => {
      expect((await decidir(authMarcos, mundial.id, { decisao: "validar" })).status).toBe(404);
      expect((await decidir(EMAILS_DEMO.atleta, mundial.id, { decisao: "validar" })).status).toBe(
        403,
      );
      expect((await decidir(EMAILS_DEMO.ibvar, mundial.id, { decisao: "validar" })).status).toBe(
        403,
      );
      expect((await decidir(null, mundial.id, { decisao: "validar" })).status).toBe(401);
      expect((await decidir(EMAILS_DEMO.gestor, "999999", { decisao: "validar" })).status).toBe(
        404,
      );
      expect((await decidir(EMAILS_DEMO.gestor, "abc", { decisao: "validar" })).status).toBe(400);
      expect((await decidir(EMAILS_DEMO.gestor, mundial.id, { decisao: "talvez" })).status).toBe(
        400,
      );
    });

    it("só resultado do atleta tem validação: o lançado à mão e o do Ranking CBVela dão 400", async () => {
      const lista = await listar(EMAILS_DEMO.gestor);
      const doSeed = (lista.corpo.itens as Resultado[]).find((x) => x.fonte === "ranking_cbvela")!;
      expect(doSeed.status).toBe("validado");
      const r = await decidir(EMAILS_DEMO.gestor, doSeed.id, {
        decisao: "recusar",
        motivo: "tentativa",
      });
      expect(r.status).toBe(400);
      await expect(
        p.db.exec(
          `insert into validacoes_resultado (resultado_id, status, motivo, validado_por)
           select ${doSeed.id}, 'validado', null, id from usuarios where papel = 'gestor' limit 1`,
        ),
      ).rejects.toThrow(/passa por validação/);
    });
  });

  describe("indicadores calculados não aceitam lançamento nem autoavaliação", () => {
    it("lançar nota em perf_mundial, perf_continental ou perf_nacional: 400, na gravação e na prévia", async () => {
      for (const indicadorId of ["perf_mundial", "perf_continental", "perf_nacional"]) {
        for (const sufixo of ["", "/previa"]) {
          const r = await chamar(
            EMAILS_DEMO.treinadora,
            "POST",
            `/atletas/${helena}/avaliacoes${sufixo}`,
            {
              notas: [{ indicadorId, valor: 5, evidencia: "tentativa" }],
            },
          );
          expect(r.status, indicadorId + sufixo).toBe(400);
          expect(r.corpo.mensagem).toContain("calculado pelo sistema");
          expect(r.corpo.mensagem).toContain("resultados validados");
        }
      }
    });

    it("a autoavaliação não aceita esses indicadores e GET /parametros os mostra calculados, sem autoavaliação", async () => {
      const r = await chamar(EMAILS_DEMO.atleta, "POST", "/autoavaliacoes", {
        notas: [{ indicadorId: "perf_nacional", valor: 5, evidencia: "tentativa" }],
      });
      expect(r.status).toBe(400);
      expect(r.corpo.campos[0].campo).toBe("notas.0.indicadorId");
      const par = await chamar(EMAILS_DEMO.gestor, "GET", "/parametros");
      const perf = par.corpo.pilares
        .flatMap(
          (x: {
            indicadores: {
              id: string;
              calculado: boolean;
              autoavaliacao: boolean;
              orientacao: string | null;
            }[];
          }) => x.indicadores,
        )
        .filter((i: { id: string }) => /^perf_(mundial|continental|nacional)$/.test(i.id));
      expect(perf).toHaveLength(3);
      for (const i of perf) {
        expect(i).toMatchObject({ calculado: true, autoavaliacao: false });
        expect(i.orientacao).toContain("Faixas provisórias");
      }
      const ligar = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        indicadores: [{ id: "perf_mundial", autoavaliacao: true }],
      });
      expect(ligar.status).toBe(400);
    });
  });

  describe("GET /atletas/:id/resultados e a ficha", () => {
    it("acesso: gestor, treinador do atleta e o próprio atleta; outro treinador e outro atleta 404; IBVAR 403", async () => {
      expect((await listar(EMAILS_DEMO.gestor)).status).toBe(200);
      expect((await listar(EMAILS_DEMO.treinadora)).status).toBe(200);
      expect((await listar(EMAILS_DEMO.atleta)).status).toBe(200);
      expect((await listar(authMarcos)).status).toBe(404);
      expect((await listar(EMAILS_DEMO.atleta, livia)).status).toBe(404);
      expect((await listar(EMAILS_DEMO.ibvar)).status).toBe(403);
      expect((await listar(null)).status).toBe(401);
      expect((await listar(EMAILS_DEMO.gestor, "nao-e-uuid")).status).toBe(400);
      expect((await listar(EMAILS_DEMO.gestor, helena, "?status=talvez")).status).toBe(400);
    });

    it("traz fonte, edição, status e filtra por status; resultados do seed vêm validados", async () => {
      const todos = (await listar(EMAILS_DEMO.gestor)).corpo.itens as Resultado[];
      expect(todos.some((x) => x.fonte === "atleta")).toBe(true);
      expect(todos.some((x) => x.fonte === "ranking_cbvela" && x.status === "validado")).toBe(true);
      const seed = todos.find((x) => x.evento === "Brasileiro de iQFOiL")!;
      expect(seed).toMatchObject({
        edicao: 2026,
        fonte: "ranking_cbvela",
        status: "validado",
        anexo: null,
      });
      for (const s of ["validado", "pendente", "recusado"]) {
        const f = (await listar(EMAILS_DEMO.gestor, helena, `?status=${s}`)).corpo
          .itens as Resultado[];
        expect(f.length, s).toBeGreaterThan(0);
        expect(f.every((x) => x.status === s)).toBe(true);
      }
      const datas = todos.map((x) => x.data);
      expect(datas).toEqual([...datas].sort().reverse());
    });

    it("IBVAR vê só os validados, sem anexo, motivo nem quem validou", async () => {
      // Lívia consentiu com o IBVAR. Um resultado do atleta dela: pendente, outro recusado, outro validado.
      const ana = (
        await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
          EMAILS_DEMO.treinadora,
        ])
      ).rows[0]!.id;
      const s = await p.db.query<{ id: string }>(
        `insert into evidencias_anexos (atleta_id, categoria, nome_arquivo, tipo_mime, tamanho_bytes, caminho, sha256, enviado_por)
         values ($1, 'sumula', 'sumula.pdf', 'application/pdf', 73, $2, $3, $4) returning id`,
        [livia, `${livia}/s.pdf`, "b".repeat(64), ana],
      );
      const novo = async (evento: string, posicao: number) =>
        (
          await p.db.query<{ id: string }>(
            `insert into resultados_regata (atleta_id, nivel, evento, data, edicao, posicao, internacional, fonte, anexo_id, registrado_por)
             values ($1, 'continental', $2, '2026-09-01', 2026, $3, true, 'atleta', $4, $5) returning id::text as id`,
            [livia, evento, posicao, s.rows[0]!.id, ana],
          )
        ).rows[0]!.id;
      const pendente = await novo("Continental pendente", 1);
      const recusado = await novo("Continental recusado", 1);
      const validado = await novo("Continental validado", 2);
      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, recusado, {
            decisao: "recusar",
            motivo: "Motivo interno",
          })
        ).status,
      ).toBe(200);
      expect((await decidir(EMAILS_DEMO.treinadora, validado, { decisao: "validar" })).status).toBe(
        200,
      );

      const gestor = (await ficha(EMAILS_DEMO.gestor, livia)).resultados as Resultado[];
      expect(gestor.map((x) => x.id)).toEqual(
        expect.arrayContaining([pendente, recusado, validado]),
      );
      expect(gestor.find((x) => x.id === validado)).toMatchObject({
        status: "validado",
        anexo: { id: s.rows[0]!.id },
        validadoPor: { nome: "Ana Ribeiro" },
      });

      const ib = (await ficha(EMAILS_DEMO.ibvar, livia)).resultados as Resultado[];
      expect(ib.map((x) => x.id)).toContain(validado);
      expect(ib.map((x) => x.id)).not.toContain(pendente);
      expect(ib.map((x) => x.id)).not.toContain(recusado);
      expect(ib.every((x) => x.status === "validado")).toBe(true);
      for (const x of ib)
        expect(x).toMatchObject({ anexo: null, motivo: null, validadoPor: null, validadoEm: null });
      expect(JSON.stringify(ib)).not.toContain("Motivo interno");
      // A nota continental calculada: o 2º lugar validado vale 5 (a pendente e a recusada não entram).
      const ind = indicador(await ficha(EMAILS_DEMO.ibvar, livia), "perf_continental");
      expect(ind).toMatchObject({ nota: 5, origem: "calculado", resultado: { posicao: 2 } });
    });

    it("histórico do indicador de resultado traz um item por resultado validado do nível", async () => {
      const h = await chamar(
        EMAILS_DEMO.gestor,
        "GET",
        `/atletas/${helena}/indicadores/perf_mundial/historico`,
      );
      expect(h.status).toBe(200);
      expect(h.corpo.length).toBeGreaterThan(0);
      expect(h.corpo[0]).toMatchObject({ origem: "calculado", valor: 5, pendente: false });
    });
  });

  describe("banco e LGPD", () => {
    it("validacoes_resultado só aceita inserção", async () => {
      const id = (await p.db.query<{ id: string }>("select id from validacoes_resultado limit 1"))
        .rows[0]!.id;
      await expect(
        p.db.exec(`update validacoes_resultado set status = 'validado' where id = ${id}`),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(
        p.db.exec(`update validacoes_resultado set motivo = 'x' where id = ${id}`),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(p.db.exec(`delete from validacoes_resultado where id = ${id}`)).rejects.toThrow(
        /aceita só inserção/,
      );
    });

    it("resultado do atleta sem súmula nem link https não entra no banco; frota menor que a colocação também", async () => {
      const base = `insert into resultados_regata (atleta_id, nivel, evento, data, edicao, posicao, tamanho_frota, internacional, fonte, link_oficial)
        values ('${helena}', 'mundial', 'x', '2026-01-01', 2026, 5, `;
      await expect(p.db.exec(`${base} null, true, 'atleta', null)`)).rejects.toThrow();
      await expect(p.db.exec(`${base} null, true, 'atleta', 'http://a.b/c')`)).rejects.toThrow();
      await expect(p.db.exec(`${base} 3, true, 'manual', 'https://a.b/c')`)).rejects.toThrow();
      await p.db.exec(`${base} null, true, 'manual', 'https://a.b/c')`);
    });

    it("GET /meus-dados: resultados com edição, situação e quem validou", async () => {
      const r = await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
      expect(r.status).toBe(200);
      const itens = r.corpo.resultados as Record<string, unknown>[];
      const validado = itens.find((x) => x.evento === "Mundial do Teste de Nota")!;
      expect(validado).toMatchObject({
        edicao: 2026,
        status: "validado",
        fonte: "atleta",
        motivo: null,
        validadoPor: "Ana Ribeiro",
      });
      const recusado = itens.find((x) => x.evento === "Brasileiro do Teste de Nota")!;
      expect(recusado).toMatchObject({ status: "recusado", motivo: "Súmula de outra prova" });
      const seed = itens.find((x) => x.evento === "Brasileiro de iQFOiL")!;
      expect(seed).toMatchObject({ edicao: 2026, status: "validado", fonte: "ranking_cbvela" });
    });

    it("anonimização: o motivo da recusa sai; o resto da validação fica", async () => {
      const r = await informar({ evento: "Resultado a anonimizar", ano: 2020 });
      expect(
        (
          await decidir(EMAILS_DEMO.treinadora, r.corpo.id, {
            decisao: "recusar",
            motivo: "Texto livre do treinador",
          })
        ).status,
      ).toBe(200);
      const gestor = (
        await p.db.query<{ id: string }>("select id from usuarios where papel = 'gestor' limit 1")
      ).rows[0]!.id;
      const pedido = (
        await p.db.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
           values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
          [helena, gestor],
        )
      ).rows[0]!.id;
      const a = await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${helena}/anonimizar`, {
        pedidoTitularId: pedido,
        confirmacao: "ANONIMIZAR",
      });
      expect(a.status).toBe(200);
      const v = await p.db.query<{ status: string; motivo: string | null }>(
        "select status, motivo from validacoes_resultado where resultado_id = $1",
        [r.corpo.id],
      );
      expect(v.rows).toHaveLength(1);
      expect(v.rows[0]!.status).toBe("recusado");
      expect(v.rows[0]!.motivo).not.toContain("Texto livre");
      const todos = await p.db.query<{ motivo: string }>(
        `select v.motivo from validacoes_resultado v join resultados_regata r on r.id = v.resultado_id
          where r.atleta_id = $1 and v.motivo is not null`,
        [helena],
      );
      for (const l of todos.rows) expect(l.motivo).not.toMatch(/treinador|Súmula|Frota|outra vez/);
      const ev = await p.db.query<{ evento: string }>(
        "select evento from resultados_regata where atleta_id = $1 and fonte = 'atleta'",
        [helena],
      );
      expect(ev.rows.every((x) => x.evento === "Evento anonimizado")).toBe(true);
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, tokenPara } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-25T10:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};

describe("D7: sugestões ao gestor", () => {
  let p: Piloto;
  let classe: { id: string; nome: string; min: number; medio: number; max: number };
  let authMarcos: { authorization: string };

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    const c = (
      await p.db.query<{ id: string; nome: string; a: string; b: string; c: string }>(
        `select id, nome, peso_min_kg::text as a, peso_medio_kg::text as b, peso_max_kg::text as c
           from classes order by ordem limit 1`,
      )
    ).rows[0]!;
    classe = { id: c.id, nome: c.nome, min: Number(c.a), medio: Number(c.b), max: Number(c.c) };
    const marcos = (
      await p.db.query<{ treinador_id: string }>(
        "select treinador_id from atletas where velaid_codigo = 'RS-T02'",
      )
    ).rows[0]!.treinador_id;
    const authUserId = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authUserId, marcos]);
    authMarcos = cabecalhoAuth(await tokenPara(authUserId));
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
  const proposta = () => ({
    pesoMinKg: classe.min - 1,
    pesoMedioKg: classe.medio,
    pesoMaxKg: classe.max + 1,
  });
  const sugerirClassFit = (quem: string | { authorization: string } | null, extra = {}) =>
    chamar(quem, "POST", "/sugestoes", {
      tipo: "class_fit",
      classeId: classe.id,
      proposta: proposta(),
      texto: "A faixa está apertada para a classe.",
      ...extra,
    });
  const balao = async (quem: string | { authorization: string }, chave: string) =>
    (await chamar(quem, "GET", "/me/notificacoes")).corpo.contagens[chave] as number;

  describe("POST /sugestoes", () => {
    it("só o treinador: sem token 401; gestor, atleta e IBVAR 403", async () => {
      expect((await sugerirClassFit(null)).status).toBe(401);
      for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        expect((await sugerirClassFit(email)).status, email).toBe(403);
      }
    });

    it("class_fit válido: 201 com faixa atual para comparar, auditoria só com ids", async () => {
      avancar(1);
      const r = await sugerirClassFit(EMAILS_DEMO.treinadora);
      expect(r.status).toBe(201);
      expect(r.corpo).toMatchObject({
        tipo: "class_fit",
        status: "aberta",
        autor: { nome: expect.any(String) },
        classe: { id: classe.id, nome: classe.nome },
        proposta: proposta(),
        faixaAtual: { pesoMinKg: classe.min, pesoMedioKg: classe.medio, pesoMaxKg: classe.max },
        resposta: null,
        respondidoPor: null,
        respondidoEm: null,
      });
      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'sugerir'",
      );
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0]!.detalhes).toEqual({
        sugestaoId: r.corpo.id,
        tipo: "class_fit",
        classeId: classe.id,
      });
      expect(JSON.stringify(aud.rows)).not.toContain("apertada");
    });

    it("não muda a faixa da classe", async () => {
      const c = await p.db.query<{ a: string }>(
        "select peso_min_kg::text as a from classes where id = $1",
        [classe.id],
      );
      expect(Number(c.rows[0]!.a)).toBe(classe.min);
    });

    it("parametro e sistema entram sem classe nem proposta", async () => {
      for (const tipo of ["parametro", "sistema"]) {
        const r = await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
          tipo,
          texto: "Ideia de melhoria.",
        });
        expect(r.status).toBe(201);
        expect(r.corpo).toMatchObject({ tipo, classe: null, proposta: null, faixaAtual: null });
      }
    });

    it("validação de class_fit, por campo", async () => {
      const campo = async (corpo: object) => {
        const r = await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", corpo);
        expect(r.status).toBe(400);
        return r.corpo.campos.map((c: { campo: string }) => c.campo);
      };
      const texto = "Texto.";
      expect(await campo({ tipo: "class_fit", texto })).toEqual(["classeId", "proposta"]);
      expect(
        await campo({ tipo: "class_fit", classeId: "nao_existe", proposta: proposta(), texto }),
      ).toEqual(["classeId"]);
      // min > médio
      expect(
        await campo({
          tipo: "class_fit",
          classeId: classe.id,
          proposta: { pesoMinKg: 90, pesoMedioKg: 80, pesoMaxKg: 100 },
          texto,
        }),
      ).toEqual(["proposta"]);
      // médio > max
      expect(
        await campo({
          tipo: "class_fit",
          classeId: classe.id,
          proposta: { pesoMinKg: 70, pesoMedioKg: 100, pesoMaxKg: 90 },
          texto,
        }),
      ).toEqual(["proposta"]);
      // fora de 0 a 400 kg
      expect(
        await campo({
          tipo: "class_fit",
          classeId: classe.id,
          proposta: { pesoMinKg: -1, pesoMedioKg: 80, pesoMaxKg: 401 },
          texto,
        }),
      ).toEqual(["proposta.pesoMinKg", "proposta.pesoMaxKg"]);
      // proposta incompleta
      expect(
        await campo({
          tipo: "class_fit",
          classeId: classe.id,
          proposta: { pesoMinKg: 70, pesoMedioKg: 80 },
          texto,
        }),
      ).toEqual(["proposta.pesoMaxKg"]);
    });

    it("parametro e sistema recusam classe e proposta; texto de 1 a 1.000; tipo inválido; campo extra", async () => {
      const r = await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
        tipo: "parametro",
        classeId: classe.id,
        proposta: proposta(),
        texto: "x",
      });
      expect(r.status).toBe(400);
      expect(r.corpo.campos.map((c: { campo: string }) => c.campo)).toEqual([
        "classeId",
        "proposta",
      ]);
      for (const texto of ["", "   ", "x".repeat(1001)]) {
        const t = await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
          tipo: "sistema",
          texto,
        });
        expect(t.status).toBe(400);
        expect(t.corpo.campos[0].campo).toBe("texto");
      }
      expect(
        (await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", { tipo: "outro", texto: "a" }))
          .status,
      ).toBe(400);
      expect(
        (
          await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
            tipo: "sistema",
            texto: "a",
            status: "aprovada",
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
            tipo: "sistema",
            texto: "a".repeat(1000),
          })
        ).status,
      ).toBe(201);
    });

    it("limite de 10 abertas por autor: a 11ª dá 409; outro autor não é afetado; responder libera", async () => {
      const abertas = async (quem: string | { authorization: string }) =>
        (await chamar(quem, "GET", "/sugestoes?status=aberta")).corpo.itens.length as number;
      let n = await abertas(EMAILS_DEMO.treinadora);
      while (n < 10) {
        expect(
          (
            await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
              tipo: "sistema",
              texto: "Mais uma.",
            })
          ).status,
        ).toBe(201);
        n++;
      }
      const r = await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
        tipo: "sistema",
        texto: "Passou.",
      });
      expect(r.status).toBe(409);
      expect(r.corpo.mensagem).toMatch(/10 sugestões abertas/);
      expect(
        (await chamar(authMarcos, "POST", "/sugestoes", { tipo: "sistema", texto: "Do Marcos." }))
          .status,
      ).toBe(201);

      const primeira = (
        await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes?status=aberta")
      ).corpo.itens.at(-1);
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${primeira.id}`, {
            status: "aprovada",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await chamar(EMAILS_DEMO.treinadora, "POST", "/sugestoes", {
            tipo: "sistema",
            texto: "Agora vai.",
          })
        ).status,
      ).toBe(201);
    });
  });

  describe("GET /sugestoes", () => {
    it("papéis: sem token 401; atleta e IBVAR 403", async () => {
      expect((await chamar(null, "GET", "/sugestoes")).status).toBe(401);
      expect((await chamar(EMAILS_DEMO.atleta, "GET", "/sugestoes")).status).toBe(403);
      expect((await chamar(EMAILS_DEMO.ibvar, "GET", "/sugestoes")).status).toBe(403);
    });

    it("gestor vê todas; cada treinador só as suas", async () => {
      const todas = (await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes")).corpo.itens;
      const ana = (await chamar(EMAILS_DEMO.treinadora, "GET", "/sugestoes")).corpo.itens;
      const marcos = (await chamar(authMarcos, "GET", "/sugestoes")).corpo.itens;
      expect(marcos).toHaveLength(1);
      expect(marcos[0].texto).toBe("Do Marcos.");
      expect(ana.length + marcos.length).toBe(todas.length);
      expect(
        ana.every((s: { autor: { nome: string } }) => s.autor.nome === ana[0].autor.nome),
      ).toBe(true);
      expect(ana.map((s: { id: string }) => s.id)).not.toContain(marcos[0].id);
      // O IBVAR e o atleta nunca recebem o texto: 403 acima. Aqui, sem e-mail nem id de usuário.
      expect(JSON.stringify(todas)).not.toContain("@");
    });

    it("filtra por status e valida o filtro", async () => {
      const aprovadas = (await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes?status=aprovada"))
        .corpo.itens;
      expect(aprovadas).toHaveLength(1);
      expect(aprovadas[0].status).toBe("aprovada");
      expect((await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes?status=x")).status).toBe(400);
    });
  });

  describe("PUT /sugestoes/:id", () => {
    let id: string;
    beforeAll(async () => {
      avancar(1);
      id = (await sugerirClassFit(authMarcos, { texto: "Faixa para revisar." })).corpo.id;
    });

    it("só o gestor: sem token 401; treinador (até o autor), atleta e IBVAR 403", async () => {
      const corpo = { status: "recusada", resposta: "Não." };
      expect((await chamar(null, "PUT", `/sugestoes/${id}`, corpo)).status).toBe(401);
      for (const quem of [
        authMarcos,
        EMAILS_DEMO.treinadora,
        EMAILS_DEMO.atleta,
        EMAILS_DEMO.ibvar,
      ]) {
        expect((await chamar(quem, "PUT", `/sugestoes/${id}`, corpo)).status).toBe(403);
      }
    });

    it("validações: resposta obrigatória ao recusar, até 1.000, status válido, id inexistente 404", async () => {
      for (const resposta of [undefined, "", "   "]) {
        const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${id}`, {
          status: "recusada",
          ...(resposta === undefined ? {} : { resposta }),
        });
        expect(r.status).toBe(400);
        expect(r.corpo.campos[0].campo).toBe("resposta");
      }
      expect(
        (
          await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${id}`, {
            status: "recusada",
            resposta: "x".repeat(1001),
          })
        ).status,
      ).toBe(400);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${id}`, { status: "aberta" })).status,
      ).toBe(400);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "PUT", "/sugestoes/999999", { status: "aprovada" }))
          .status,
      ).toBe(404);
      expect(
        (await chamar(EMAILS_DEMO.gestor, "PUT", "/sugestoes/abc", { status: "aprovada" })).status,
      ).toBe(400);
      // Nada mudou.
      const s = (
        await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes?status=aberta")
      ).corpo.itens.find((i: { id: string }) => i.id === id);
      expect(s.status).toBe("aberta");
    });

    it("balão sugestoes do gestor conta as abertas e cai ao responder; os demais papéis não têm a chave", async () => {
      const abertas = (await chamar(EMAILS_DEMO.gestor, "GET", "/sugestoes?status=aberta")).corpo
        .itens.length as number;
      expect(await balao(EMAILS_DEMO.gestor, "sugestoes")).toBe(abertas);
      expect(abertas).toBeGreaterThan(0);
      for (const quem of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        const r = await chamar(quem, "GET", "/me/notificacoes");
        expect(r.corpo.contagens).not.toHaveProperty("sugestoes");
      }
    });

    it("recusar: grava resposta e quem respondeu, avisa o autor, não muda a classe, auditoria só com ids", async () => {
      avancar(5);
      const avisosAntes = await balao(authMarcos, "avisos");
      const antesClasse = await p.db.query("select * from classes where id = $1", [classe.id]);
      const abertasAntes = await balao(EMAILS_DEMO.gestor, "sugestoes");
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${id}`, {
        status: "recusada",
        resposta: "A faixa segue o regulamento da classe.",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({
        id,
        status: "recusada",
        resposta: "A faixa segue o regulamento da classe.",
        respondidoPor: { nome: expect.any(String) },
        respondidoEm: agora.toISOString(),
      });
      expect(await balao(EMAILS_DEMO.gestor, "sugestoes")).toBe(abertasAntes - 1);
      expect((await p.db.query("select * from classes where id = $1", [classe.id])).rows).toEqual(
        antesClasse.rows,
      );

      // Aviso ao autor (D8), só com ids e status.
      expect(await balao(authMarcos, "avisos")).toBe(avisosAntes + 1);
      const aviso = (await chamar(authMarcos, "GET", "/me/avisos")).corpo.itens[0];
      expect(aviso).toMatchObject({
        tipo: "sugestao_respondida",
        atleta: null,
        referencia: { sugestaoId: id, status: "recusada" },
        criadoPor: { papel: "gestor" },
        lidoEm: null,
      });
      expect(JSON.stringify(aviso)).not.toContain("regulamento");
      // O gestor não recebe aviso da própria resposta, nem a treinadora do aviso do Marcos.
      expect(await balao(EMAILS_DEMO.gestor, "avisos")).toBe(0);

      const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'responder_sugestao' and entidade_id = $1",
        [id],
      );
      expect(aud.rows).toHaveLength(1);
      expect(aud.rows[0]!.detalhes).toEqual({ sugestaoId: id, status: "recusada" });
      expect(JSON.stringify(aud.rows)).not.toContain("regulamento");
    });

    it("sugestão já respondida: 409, e a resposta original não muda", async () => {
      for (const corpo of [
        { status: "aprovada" },
        { status: "recusada", resposta: "Outra resposta." },
      ]) {
        const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${id}`, corpo);
        expect(r.status).toBe(409);
        expect(r.corpo.mensagem).toMatch(/já foi respondida/);
      }
      const s = (await chamar(authMarcos, "GET", "/sugestoes?status=recusada")).corpo.itens[0];
      expect(s.resposta).toBe("A faixa segue o regulamento da classe.");
    });

    it("aprovar sem resposta é aceito e avisa o autor com status aprovada", async () => {
      avancar(1);
      const nova = (await sugerirClassFit(authMarcos, { texto: "Outra faixa." })).corpo.id;
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/sugestoes/${nova}`, {
        status: "aprovada",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ status: "aprovada", resposta: null });
      const aviso = (await chamar(authMarcos, "GET", "/me/avisos")).corpo.itens[0];
      expect(aviso.referencia).toEqual({ sugestaoId: nova, status: "aprovada" });
      // Aprovar não alterou a faixa: a mudança é pelo PUT /parametros.
      const c = await p.db.query<{ a: string }>(
        "select peso_min_kg::text as a from classes where id = $1",
        [classe.id],
      );
      expect(Number(c.rows[0]!.a)).toBe(classe.min);
    });
  });
});

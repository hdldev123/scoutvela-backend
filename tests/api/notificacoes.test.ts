import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pendenciasDoCiclo } from "../../src/repositories/pendencias.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};

describe("notificações do menu (GET /me/notificacoes, PUT /me/notificacoes/vistas)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => agora);
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
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const contagens = async (email: string) => {
    const r = await chamar(email, "GET", "/me/notificacoes");
    expect(r.status).toBe(200);
    return r.corpo as { contagens: Record<string, number>; total: number };
  };
  const vista = (email: string, chave: string) =>
    chamar(email, "PUT", "/me/notificacoes/vistas", { chave });

  it("sem token -> 401", async () => {
    expect((await p.app.inject({ method: "GET", url: "/me/notificacoes" })).statusCode).toBe(401);
    expect(
      (
        await p.app.inject({
          method: "PUT",
          url: "/me/notificacoes/vistas",
          payload: { chave: "painel" },
        })
      ).statusCode,
    ).toBe(401);
  });

  it("IBVAR: objeto vazio e total 0", async () => {
    expect(await contagens(EMAILS_DEMO.ibvar)).toEqual({ contagens: {}, total: 0 });
  });

  it("chaves por papel (sempre presentes, mesmo com 0) e total é a soma", async () => {
    const g = await contagens(EMAILS_DEMO.gestor);
    expect(Object.keys(g.contagens).sort()).toEqual(["cadastro", "revisoes"]);
    expect(g.total).toBe(g.contagens.cadastro! + g.contagens.revisoes!);
    const t = await contagens(EMAILS_DEMO.treinadora);
    expect(Object.keys(t.contagens).sort()).toEqual(["avaliar", "revisoes"]);
    const a = await contagens(EMAILS_DEMO.atleta);
    expect(Object.keys(a.contagens)).toEqual(["painel"]);
    expect(a.total).toBe(a.contagens.painel);
  });

  it("treinador: avaliar segue a regra de pendência do ciclo; sem ciclo aberto, 0", async () => {
    const ciclo = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
    const todas = await pendenciasDoCiclo(p.db, ciclo, agora);
    const ana = todas.treinadores.find((t) => t.email === "treinadora@scoutvela.dev")!;
    expect(ana.atletasPendentes.length).toBeGreaterThan(0);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.avaliar).toBe(
      ana.atletasPendentes.length,
    );

    await p.db.query("update ciclos_avaliacao set status = 'fechado' where id = $1", [ciclo]);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.avaliar).toBe(0);
    await p.db.query("update ciclos_avaliacao set status = 'aberto' where id = $1", [ciclo]);
  });

  it("pedido de revisão aberto conta para o gestor e para o treinador do atleta, não para outro treinador", async () => {
    const g0 = (await contagens(EMAILS_DEMO.gestor)).contagens.revisoes!;
    const t0 = (await contagens(EMAILS_DEMO.treinadora)).contagens.revisoes!;

    // A Helena, atleta da Ana, pede revisão.
    const criado = await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
      pilarId: "amb",
      motivo: "Motivo suficientemente longo para a revisão.",
    });
    expect(criado.status).toBe(201);
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.revisoes).toBe(g0 + 1);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.revisoes).toBe(t0 + 1);

    // Pedido de atleta de outro treinador (RS-T02, do Marcos Pires): só o gestor vê.
    const outro = await p.idDe("RS-T02");
    await p.db.query(
      `insert into pedidos_revisao (atleta_id, pilar_id, motivo, criado_por, criado_em)
       values ($1, 'amb', 'Motivo do outro atleta, longo o bastante.', (select id from usuarios where papel = 'gestor'), $2)`,
      [outro, agora],
    );
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.revisoes).toBe(g0 + 2);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.revisoes).toBe(t0 + 1);

    // Pedido do titular aberto conta para o gestor, e não para o treinador.
    const pt = await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
      tipo: "acesso",
      descricao: "Quero acessar os meus dados do piloto.",
    });
    expect(pt.status).toBe(201);
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.revisoes).toBe(g0 + 3);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.revisoes).toBe(t0 + 1);

    // Respondido deixa de contar.
    avancar(5);
    const resp = await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${criado.corpo.id}`, {
      resposta: "Revisado, nota mantida.",
    });
    expect(resp.status).toBe(200);
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.revisoes).toBe(g0 + 2);
    expect((await contagens(EMAILS_DEMO.treinadora)).contagens.revisoes).toBe(t0);
    await chamar(EMAILS_DEMO.gestor, "PUT", `/pedidos-titular/${pt.corpo.id}`, {
      resposta: "Seus dados foram enviados.",
    });
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.revisoes).toBe(g0 + 1);
  });

  it("atleta: resposta nova conta e o PUT vistas zera; só painel é aceito", async () => {
    // Respostas dadas no teste anterior (revisão e pedido do titular) ainda são novas.
    const comRespostas = (await contagens(EMAILS_DEMO.atleta)).contagens.painel!;
    avancar(1);
    expect((await vista(EMAILS_DEMO.atleta, "painel")).status).toBe(204);
    const base = (await contagens(EMAILS_DEMO.atleta)).contagens.painel!;
    expect(base).toBe(comRespostas - 2);

    // Novo pedido, ainda sem resposta: não muda nada.
    const criado = await chamar(EMAILS_DEMO.atleta, "POST", "/revisoes", {
      pilarId: "car",
      motivo: "Outro motivo suficientemente longo.",
    });
    expect((await contagens(EMAILS_DEMO.atleta)).contagens.painel).toBe(base);

    // Respondido depois da última visita: soma 1. Marcar visto tira.
    avancar(1);
    await chamar(EMAILS_DEMO.gestor, "PUT", `/revisoes/${criado.corpo.id}`, {
      resposta: "Revisado e mantido.",
    });
    expect((await contagens(EMAILS_DEMO.atleta)).contagens.painel).toBe(base + 1);
    avancar(1);
    expect((await vista(EMAILS_DEMO.atleta, "painel")).status).toBe(204);
    expect((await contagens(EMAILS_DEMO.atleta)).contagens.painel).toBe(base);

    // Upsert: uma linha só, e sem auditoria (dado de interface).
    const linhas = await p.db.query("select 1 from notificacoes_vistas where chave = 'painel'");
    expect(linhas.rows).toHaveLength(1);
    const aud = await p.db.query(
      "select 1 from auditoria where entidade = 'notificacoes_vistas' or acao ilike '%visto%'",
    );
    expect(aud.rows).toHaveLength(0);
  });

  it("gestor: cadastro = atletas ativos sem aceite da versão vigente; atleta soma 1 pelo termo pendente", async () => {
    const painelAntes = (await contagens(EMAILS_DEMO.atleta)).contagens.painel!;
    const cadastroAntes = (await contagens(EMAILS_DEMO.gestor)).contagens.cadastro!;
    const ativos = Number(
      (await p.db.query<{ n: string }>("select count(*)::text as n from atletas where ativo"))
        .rows[0]!.n,
    );

    // Nova versão do termo, já vigente: todos precisam aceitar de novo.
    await p.db.query(
      "insert into termos_consentimento (versao, titulo, texto, vigente_desde) values ('v2-teste', 'Termo v2', 'Texto v2', $1)",
      [new Date(agora.getTime() - 60_000)],
    );
    expect((await contagens(EMAILS_DEMO.gestor)).contagens.cadastro).toBe(ativos);
    expect(ativos).toBeGreaterThan(cadastroAntes);
    expect((await contagens(EMAILS_DEMO.atleta)).contagens.painel).toBe(painelAntes + 1);
  });

  it("PUT vistas: chave fora do papel ou do enum -> 400", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar]) {
      for (const chave of ["painel", "revisoes", "cadastro", "avaliar"]) {
        expect((await vista(email, chave)).status, `${email} ${chave}`).toBe(400);
      }
    }
    for (const chave of ["revisoes", "cadastro", "avaliar", "outra"]) {
      expect((await vista(EMAILS_DEMO.atleta, chave)).status, chave).toBe(400);
    }
    expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/me/notificacoes/vistas", {})).status).toBe(
      400,
    );
  });
});

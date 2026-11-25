import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MensagemEmail, ProvedorEmail } from "../../src/email/index.js";
import { criarUsuarioDeTeste } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-06T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};

describe("aviso de ciclo fechado (e-mail e balão de Investimento)", () => {
  let p: Piloto;
  const enviadas: MensagemEmail[] = [];
  let falharPara: string | null = null;
  let ibvarExtra: string;
  let gestorInativo: string;
  const provedor: ProvedorEmail = {
    enviar(m) {
      if (falharPara && m.para === falharPara) return Promise.reject(new Error("SMTP fora do ar"));
      enviadas.push(m);
      return Promise.resolve();
    },
  };

  beforeAll(async () => {
    p = await criarPiloto(() => agora, { email: provedor });
    const extra = await criarUsuarioDeTeste(p.db, { papel: "ibvar", nome: "Outro IBVAR" });
    const inativo = await criarUsuarioDeTeste(p.db, {
      papel: "gestor",
      nome: "Gestor inativo",
      ativo: false,
    });
    const emails = await p.db.query<{ id: string; email: string }>(
      "select id, email from usuarios where id = any($1::uuid[])",
      [[extra.id, inativo.id]],
    );
    ibvarExtra = emails.rows.find((l) => l.id === extra.id)!.email;
    gestorInativo = emails.rows.find((l) => l.id === inativo.id)!.email;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: email ? await p.como(email) : {},
      ...(payload ? { payload } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const balao = async (email: string) =>
    (await chamar(email, "GET", "/me/notificacoes")).corpo.contagens.investimento as
      number | undefined;
  const abrirEFechar = async (nome: string, inicio: string, prazo: string) => {
    const aberto = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0];
    if (aberto) await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${aberto.id}/fechar`);
    const novo = await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", { nome, inicio, prazo });
    return novo.corpo.id as string;
  };

  it("balão: só gestor e IBVAR têm a chave; treinador e atleta não", async () => {
    expect(await balao(EMAILS_DEMO.gestor)).toBeTypeOf("number");
    expect(await balao(EMAILS_DEMO.ibvar)).toBeTypeOf("number");
    expect(await balao(EMAILS_DEMO.treinadora)).toBeUndefined();
    expect(await balao(EMAILS_DEMO.atleta)).toBeUndefined();
  });

  it("fechar o ciclo avisa só gestores e IBVAR ativos, sem score nem nome de atleta", async () => {
    // Quem já viu a tela fica em 0 até o próximo fechamento.
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      expect(
        (await chamar(email, "PUT", "/me/notificacoes/vistas", { chave: "investimento" })).status,
      ).toBe(204);
      expect(await balao(email)).toBe(0);
    }
    avancar(10);
    const aberto = (
      await p.db.query<{ id: string; nome: string }>(
        "select id, nome from ciclos_avaliacao where status = 'aberto'",
      )
    ).rows[0]!;
    enviadas.length = 0;

    const r = await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${aberto.id}/fechar`);
    expect(r.status).toBe(200);

    expect(enviadas.map((m) => m.para).sort()).toEqual(
      [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar, ibvarExtra].sort(),
    );
    expect(enviadas.map((m) => m.para)).not.toContain(gestorInativo);
    expect(enviadas.map((m) => m.para)).not.toContain(EMAILS_DEMO.treinadora);
    expect(enviadas.map((m) => m.para)).not.toContain(EMAILS_DEMO.atleta);

    const nomes = (await p.db.query<{ nome: string }>("select nome from atletas")).rows.map(
      (l) => l.nome,
    );
    for (const m of enviadas) {
      const tudo = `${m.assunto}\n${m.texto}\n${m.html ?? ""}`;
      expect(m.assunto).toContain(aberto.nome);
      expect(m.texto).toContain(aberto.nome);
      expect(m.texto).toContain("http://localhost:8080/investimento");
      expect(m.texto).toMatch(/painel de investimento/);
      for (const nome of nomes) expect(tudo).not.toContain(nome);
      expect(tudo.toLowerCase()).not.toContain("score");
    }

    // Balão: ciclo fechado depois da última visita.
    expect(await balao(EMAILS_DEMO.gestor)).toBe(1);
    expect(await balao(EMAILS_DEMO.ibvar)).toBe(1);
    // Marcar como visto zera; só para quem marcou.
    avancar(5);
    expect(
      (await chamar(EMAILS_DEMO.ibvar, "PUT", "/me/notificacoes/vistas", { chave: "investimento" }))
        .status,
    ).toBe(204);
    expect(await balao(EMAILS_DEMO.ibvar)).toBe(0);
    expect(await balao(EMAILS_DEMO.gestor)).toBe(1);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", "/me/notificacoes/vistas", {
          chave: "investimento",
        })
      ).status,
    ).toBe(204);
    expect(await balao(EMAILS_DEMO.gestor)).toBe(0);
    // O total do menu soma o balão.
    const g = (await chamar(EMAILS_DEMO.gestor, "GET", "/me/notificacoes")).corpo;
    expect(g.total).toBe(
      Object.values(g.contagens as Record<string, number>).reduce((t, n) => t + n, 0),
    );
  });

  it("falha no envio não desfaz o fechamento, não muda a resposta e não impede os outros envios", async () => {
    avancar(60 * 24);
    await abrirEFechar("Dezembro de 2026", "2026-12-01", "2026-12-31");
    const aberto = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!;
    enviadas.length = 0;
    falharPara = EMAILS_DEMO.ibvar;
    avancar(10);
    try {
      const r = await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${aberto.id}/fechar`);
      expect(r.status).toBe(200);
      expect(r.corpo.ciclo.status).toBe("fechado");
      expect(Object.keys(r.corpo).sort()).toEqual(["atletas", "ciclo"]);
    } finally {
      falharPara = null;
    }
    const status = await p.db.query<{ status: string }>(
      "select status from ciclos_avaliacao where id = $1",
      [aberto.id],
    );
    expect(status.rows[0]!.status).toBe("fechado");
    // Os demais destinatários receberam.
    expect(enviadas.map((m) => m.para).sort()).toEqual([EMAILS_DEMO.gestor, ibvarExtra].sort());
    // O balão do IBVAR aparece mesmo sem o e-mail.
    expect(await balao(EMAILS_DEMO.ibvar)).toBe(1);
  });

  it("ciclo que não fecha (já fechado, inexistente) não envia nada", async () => {
    enviadas.length = 0;
    const fechado = (
      await p.db.query<{ id: string }>(
        "select id from ciclos_avaliacao where status = 'fechado' limit 1",
      )
    ).rows[0]!;
    expect((await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${fechado.id}/fechar`)).status).toBe(
      409,
    );
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${crypto.randomUUID()}/fechar`)).status,
    ).toBe(404);
    expect((await chamar(EMAILS_DEMO.ibvar, "POST", `/ciclos/${fechado.id}/fechar`)).status).toBe(
      403,
    );
    expect((await chamar(null, "POST", `/ciclos/${fechado.id}/fechar`)).status).toBe(401);
    expect(enviadas).toHaveLength(0);
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface ItemRanking {
  atleta: { id: string; velaid: string };
  score: number;
  faixa: { id: string };
  statusGates: string;
}

const faixasCom = (a: number, b: number, c: number, d: number) => [
  { id: "f1", scoreMin: a },
  { id: "f2", scoreMin: b },
  { id: "f3", scoreMin: c },
  { id: "f4", scoreMin: d },
];

describe("PUT /parametros: faixas, rubricas, regras e classes", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const gestor = EMAILS_DEMO.gestor;
  const ler = async () =>
    (
      await p.app.inject({ method: "GET", url: "/parametros", headers: await p.como(gestor) })
    ).json();
  const gravar = async (corpo: unknown, email: string = gestor) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: corpo as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const ranking = async (): Promise<ItemRanking[]> =>
    (await p.app.inject({ method: "GET", url: "/ranking", headers: await p.como(gestor) })).json()
      .itens;
  const gate3 = async (id: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${id}`,
      headers: await p.como(gestor),
    });
    return r.json().gates.itens[2].status as string;
  };
  const auditoria = async () =>
    (
      await p.db.query<{ detalhes: Record<string, { antes: unknown; depois: unknown }> }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      )
    ).rows[0]!.detalhes;
  const regra = (corpo: { regras: { codigo: string; valor: unknown }[] }, codigo: string) =>
    corpo.regras.find((r) => r.codigo === codigo)!.valor as Record<string, unknown>;

  it("treinador e ibvar -> 403; corpo vazio -> 400", async () => {
    const corpo = { faixas: faixasCom(80, 70, 60, 0) };
    expect((await gravar(corpo, EMAILS_DEMO.treinadora)).status).toBe(403);
    expect((await gravar(corpo, EMAILS_DEMO.ibvar)).status).toBe(403);
    expect((await gravar({ faixas: [] })).status).toBe(400);
    expect((await gravar({ regras: {} })).status).toBe(400);
  });

  it("GET devolve ativa nas classes e atualizadoEm nas regras", async () => {
    const c = await ler();
    expect(c.classes.every((x: { ativa: boolean }) => x.ativa === true)).toBe(true);
    expect(
      c.regras.every((r: { atualizadoEm: string }) => !Number.isNaN(Date.parse(r.atualizadoEm))),
    ).toBe(true);
  });

  it("faixas: validações", async () => {
    expect((await gravar({ faixas: faixasCom(80, 70, 60, 5) })).status).toBe(400); // última != 0
    expect((await gravar({ faixas: faixasCom(80, 80, 60, 0) })).status).toBe(400); // não estritamente decrescente
    expect((await gravar({ faixas: faixasCom(70, 80, 60, 0) })).status).toBe(400);
    expect((await gravar({ faixas: faixasCom(101, 80, 60, 0) })).status).toBe(400);
    expect((await gravar({ faixas: faixasCom(80, 70, 60, 0).slice(0, 3) })).status).toBe(400);
    expect(
      (
        await gravar({
          faixas: [...faixasCom(80, 70, 60, 0).slice(0, 3), { id: "fx", scoreMin: 0 }],
        })
      ).status,
    ).toBe(400);
    expect((await ler()).faixas.map((f: { scoreMin: number }) => f.scoreMin)).toEqual([
      85, 75, 65, 0,
    ]);
  });

  it("faixas: mudar os cortes muda a faixa do ranking e audita antes e depois", async () => {
    const antes = await ranking();
    const r = await gravar({ faixas: faixasCom(60, 50, 40, 0) });
    expect(r.status).toBe(200);
    expect(r.corpo.faixas.map((f: { scoreMin: number }) => f.scoreMin)).toEqual([60, 50, 40, 0]);
    const depois = await ranking();
    expect(depois.every((i) => (i.score >= 60 ? i.faixa.id === "f1" : true))).toBe(true);
    const mudou = depois.some(
      (i) => i.faixa.id !== antes.find((a) => a.atleta.id === i.atleta.id)!.faixa.id,
    );
    expect(mudou).toBe(true);
    expect((await auditoria()).faixas).toEqual({
      antes: { f1: 85, f2: 75, f3: 65, f4: 0 },
      depois: { f1: 60, f2: 50, f3: 40, f4: 0 },
    });
    expect((await gravar({ faixas: faixasCom(85, 75, 65, 0) })).status).toBe(200);
  });

  it("rubricas: validações, inserção, upsert e auditoria", async () => {
    expect(
      (
        await gravar({
          rubricas: [{ pilarId: "nao-existe", nota: 3, descricao: "Descrição válida" }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await gravar({ rubricas: [{ pilarId: "perf", nota: 6, descricao: "Descrição válida" }] }))
        .status,
    ).toBe(400);
    expect(
      (await gravar({ rubricas: [{ pilarId: "perf", nota: 3, descricao: "ab" }] })).status,
    ).toBe(400);
    expect(
      (await gravar({ rubricas: [{ pilarId: "perf", nota: 3, descricao: "x".repeat(301) }] }))
        .status,
    ).toBe(400);
    const dup = { pilarId: "perf", nota: 3, descricao: "Descrição válida" };
    expect((await gravar({ rubricas: [dup, dup] })).status).toBe(400);

    const total = (await ler()).rubricas.length;
    const nova = await gravar({
      rubricas: [
        { pilarId: "perf", nota: 5, descricao: "Pódio em Mundial da classe" },
        { pilarId: null, nota: 3, descricao: "Adequado para a faixa" },
      ],
    });
    expect(nova.status).toBe(200);
    expect(nova.corpo.rubricas).toHaveLength(total + 1); // perf/5 nova; geral/3 atualizada
    const geral3 = nova.corpo.rubricas.find(
      (r: { pilarId: string | null; nota: number }) => r.pilarId === null && r.nota === 3,
    );
    expect(geral3.descricao).toBe("Adequado para a faixa");
    const aud = (await auditoria()).rubricas as unknown as {
      antes: { descricao: string | null }[];
    };
    expect(aud.antes.map((a) => a.descricao)).toEqual([null, "Adequado"]);

    const outra = await gravar({
      rubricas: [{ pilarId: "perf", nota: 5, descricao: "Pódio em Mundial ou Olimpíada" }],
    });
    expect(outra.corpo.rubricas).toHaveLength(total + 1);
  });

  it("regras: validações por código", async () => {
    const ruim = async (regras: unknown) => (await gravar({ regras })).status;
    const g2 = {
      mundial_apto_ate_fracao: 0.3,
      sul_americano_condicional_ate_posicao: 6,
      mundial_condicional_ate_fracao: 0.5,
      brasileiro_condicional_ate_posicao: 3,
    };
    expect(await ruim({ XX: { a: 1 } })).toBe(400);
    expect(await ruim({ P3: { limites: [1, 2, 3, 4] } })).toBe(400);
    expect(await ruim({ P3: { limites: [1, 2, 2, 4, 5] } })).toBe(400);
    expect(await ruim({ P3: { limites: [0, 1, 2, 3, 4] } })).toBe(400);
    expect(await ruim({ G1: { apto_ate: 2, condicional_ate: 1 } })).toBe(400);
    expect(await ruim({ G1: { apto_ate: 1, condicional_ate: 2, extra: 1 } })).toBe(400);
    expect(await ruim({ G2: { ...g2, mundial_apto_ate_fracao: 1.5 } })).toBe(400);
    expect(await ruim({ G2: { ...g2, sul_americano_condicional_ate_posicao: 6.5 } })).toBe(400);
    expect(
      await ruim({ G3: { apto_min_eventos: 1, condicional_min_eventos: 2, janela_meses: 24 } }),
    ).toBe(400);
    expect(
      await ruim({ G3: { apto_min_eventos: 3, condicional_min_eventos: 1, janela_meses: 61 } }),
    ).toBe(400);
    expect(
      await ruim({ G3: { apto_min_eventos: 3, condicional_min_eventos: -1, janela_meses: 24 } }),
    ).toBe(400);
    expect(await ruim({ G4: { A: { status: "apto", motivo: "ok ok" } } })).toBe(400);
    expect(await ruim({ RANKING_CBVELA: { janela_semanas: 0 } })).toBe(400);
    expect(await ruim({ RANKING_CBVELA: { janela_semanas: 105 } })).toBe(400);
    const g4 = regra(await ler(), "G4") as Record<string, { status: string; motivo: string }>;
    expect(await ruim({ G4: { ...g4, A: { status: "talvez", motivo: "Motivo qualquer" } } })).toBe(
      400,
    );
    expect(await ruim({ G4: { ...g4, A: { status: "apto", motivo: "oi" } } })).toBe(400);
    expect(regra(await ler(), "G3")).toEqual({
      apto_min_eventos: 3,
      condicional_min_eventos: 1,
      janela_meses: 24,
    });
  });

  it("regras: G3 muda o gate; P3 muda o score; G4 e RANKING_CBVELA gravam; atualizadoEm só da regra tocada", async () => {
    const itens = await ranking();
    const antesG3 = await Promise.all(itens.map((i) => gate3(i.atleta.id)));
    expect(antesG3.some((s) => s !== "apto")).toBe(true);
    const antesScore = new Map(itens.map((i) => [i.atleta.id, i.score]));
    const antesC = await ler();

    const r = await gravar({
      regras: {
        G3: { apto_min_eventos: 0, condicional_min_eventos: 0, janela_meses: 60 },
        P3: { limites: [50, 60, 70, 80, 90] },
        RANKING_CBVELA: { janela_semanas: 104 },
      },
    });
    expect(r.status).toBe(200);
    expect(regra(r.corpo, "G3")).toEqual({
      apto_min_eventos: 0,
      condicional_min_eventos: 0,
      janela_meses: 60,
    });
    expect(regra(r.corpo, "P3")).toEqual({ limites: [50, 60, 70, 80, 90] });
    const stamp = (c: { regras: { codigo: string; atualizadoEm: string }[] }, k: string) =>
      c.regras.find((x) => x.codigo === k)!.atualizadoEm;
    expect(Date.parse(stamp(r.corpo, "G3"))).toBeGreaterThanOrEqual(
      Date.parse(stamp(antesC, "G3")),
    );
    expect(stamp(r.corpo, "G1")).toBe(stamp(antesC, "G1"));

    const depois = await ranking();
    const depoisG3 = await Promise.all(depois.map((i) => gate3(i.atleta.id)));
    expect(depoisG3.every((s) => s === "apto")).toBe(true);
    // Todos com nota máxima de peso: ninguém perde score e alguém ganha.
    expect(depois.every((i) => i.score >= (antesScore.get(i.atleta.id) as number))).toBe(true);
    expect(depois.some((i) => i.score > (antesScore.get(i.atleta.id) as number))).toBe(true);

    expect((await auditoria()).regras).toMatchObject({
      antes: { G3: { apto_min_eventos: 3 }, P3: { limites: [0.5, 1, 1.5, 2, 3] } },
      depois: { G3: { janela_meses: 60 }, RANKING_CBVELA: { janela_semanas: 104 } },
    });
    const por = (
      await p.db.query<{ atualizado_por: string }>(
        "select atualizado_por from regras where codigo = 'G3'",
      )
    ).rows[0]!;
    const gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [gestor])
    ).rows[0]!.id;
    expect(por.atualizado_por).toBe(gestorId);

    const g4 = regra(r.corpo, "G4") as Record<string, { status: string; motivo: string }>;
    const novoG4 = await gravar({
      regras: { G4: { ...g4, C: { status: "alerta", motivo: "Dependência alta da CBVela" } } },
    });
    expect(novoG4.status).toBe(200);
    expect((regra(novoG4.corpo, "G4") as typeof g4).C).toEqual({
      status: "alerta",
      motivo: "Dependência alta da CBVela",
    });
  });

  it("classes: desativar com atleta ativo -> 400; classe só de atleta inativo desativa e o cálculo segue", async () => {
    const emUso = await gravar({ classes: [{ id: "ilca7", ativa: false }] });
    expect(emUso.status).toBe(400);
    expect(emUso.corpo.mensagem).toContain("atleta ativo");
    expect((await gravar({ classes: [{ id: "ilca7", pesoMinKg: 80 }] })).status).toBe(400); // faixa incompleta
    expect((await gravar({ classes: [{ id: "ilca7" }] })).status).toBe(400); // nada a alterar
    expect((await ler()).classes.find((c: { id: string }) => c.id === "ilca7").ativa).toBe(true);

    const alvo = (await ranking())[0]!.atleta.id;
    const classeId = (
      await p.db.query<{ classe_id: string }>("select classe_id from atletas where id = $1", [alvo])
    ).rows[0]!.classe_id;
    await p.db.query("update atletas set ativo = false where classe_id = $1", [classeId]);
    const r = await gravar({ classes: [{ id: classeId, ativa: false }] });
    expect(r.status).toBe(200);
    expect(r.corpo.classes.find((c: { id: string }) => c.id === classeId).ativa).toBe(false);
    expect(r.corpo.classes).toHaveLength(14);
    expect((await auditoria()).classes).toMatchObject({
      antes: { [classeId]: { ativa: true } },
      depois: { [classeId]: { ativa: false } },
    });
    expect(
      (await p.app.inject({ method: "GET", url: "/ranking", headers: await p.como(gestor) }))
        .statusCode,
    ).toBe(200);
    const reativa = await gravar({ classes: [{ id: classeId, ativa: true }] });
    expect(reativa.corpo.classes.find((c: { id: string }) => c.id === classeId).ativa).toBe(true);
  });
});

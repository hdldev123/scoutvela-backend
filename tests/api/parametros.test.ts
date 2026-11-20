import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const PESOS_WORD = { perf: 20, cf: 20, tec: 15, tat: 10, pot: 5, exp: 5, men: 10, amb: 10, car: 5 };

describe("/parametros", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const ler = async (email: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: "/parametros",
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const gravar = async (email: string, corpo: unknown) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: corpo as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const scores = async () => {
    const r = await p.app.inject({
      method: "GET",
      url: "/ranking",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    return new Map(
      (r.json().itens as { atleta: { velaid: string }; score: number }[]).map((i) => [
        i.atleta.velaid,
        i.score,
      ]),
    );
  };

  it("sem token -> 401; ibvar e atleta -> 403 na leitura", async () => {
    expect((await p.app.inject({ method: "GET", url: "/parametros" })).statusCode).toBe(401);
    expect((await ler(EMAILS_DEMO.ibvar)).status).toBe(403);
    expect((await ler(EMAILS_DEMO.atleta)).status).toBe(403);
  });

  it("gestor e treinador leem o conjunto completo", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora]) {
      const { status, corpo } = await ler(email);
      expect(status).toBe(200);
      expect(corpo.pilares).toHaveLength(9);
      expect(corpo.pilares.reduce((t: number, x: { peso: number }) => t + x.peso, 0)).toBe(100);
      expect(corpo.faixas.map((f: { id: string }) => f.id)).toEqual(["f1", "f2", "f3", "f4"]);
      expect(corpo.classes).toHaveLength(14);
      expect(corpo.componentesCusto.length).toBeGreaterThan(0);
      expect(corpo.regras.map((r: { codigo: string }) => r.codigo)).toContain("G1");
      const geral = corpo.rubricas.filter((r: { pilarId: string | null }) => r.pilarId === null);
      expect(geral.map((r: { nota: number }) => r.nota)).toEqual([0, 1, 2, 3, 4, 5]);
      expect(corpo.rubricas.some((r: { pilarId: string | null }) => r.pilarId === "exp")).toBe(
        true,
      );
      const peso = corpo.pilares
        .find((x: { id: string }) => x.id === "cf")
        .indicadores.find((i: { id: string }) => i.id === "cf_peso_kg");
      expect(peso.calculado).toBe(true);
    }
  });

  it("treinador, ibvar e atleta -> 403 no PUT; sem token -> 401", async () => {
    expect(
      (await p.app.inject({ method: "PUT", url: "/parametros", payload: { pesos: PESOS_WORD } }))
        .statusCode,
    ).toBe(401);
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.ibvar, EMAILS_DEMO.atleta]) {
      expect((await gravar(email, { pesos: PESOS_WORD })).status).toBe(403);
    }
  });

  it("validações do PUT -> 400 sem gravar", async () => {
    const g = EMAILS_DEMO.gestor;
    const soma = await gravar(g, { pesos: { ...PESOS_WORD, perf: 25 } });
    expect(soma.status).toBe(400);
    expect(soma.corpo.mensagem).toBe("A soma dos pesos precisa ser 100.");
    const { perf: _perf, ...semPerf } = PESOS_WORD;
    expect((await gravar(g, { pesos: { ...semPerf, perf: 20, xis: 0 } })).status).toBe(400);
    expect((await gravar(g, { pesos: semPerf })).status).toBe(400);
    expect((await gravar(g, { pesos: { ...PESOS_WORD, perf: -5, cf: 45 } })).status).toBe(400);
    expect((await gravar(g, {})).status).toBe(400);

    const classe = (await ler(g)).corpo.classes[0];
    const base = { id: classe.id, pesoMinKg: 60, pesoMedioKg: 70, pesoMaxKg: 80 };
    expect((await gravar(g, { classes: [{ ...base, pesoMinKg: 75 }] })).status).toBe(400);
    expect((await gravar(g, { classes: [{ ...base, pesoMaxKg: 65 }] })).status).toBe(400);
    expect((await gravar(g, { classes: [{ ...base, id: "nao-existe" }] })).status).toBe(400);

    const aud = await p.db.query("select 1 from auditoria where acao = 'atualizar_parametros'");
    expect(aud.rows).toHaveLength(0);
    expect((await ler(g)).corpo.classes[0]).toEqual(classe);
  });

  // Por último: mexe nos dados.
  it("mudar pesos recalcula o ranking e grava auditoria com antes e depois", async () => {
    const antes = await scores();
    const novos = { ...PESOS_WORD, perf: 30, cf: 10 };
    const r = await gravar(EMAILS_DEMO.gestor, { pesos: novos });
    expect(r.status).toBe(200);
    expect(
      Object.fromEntries(r.corpo.pilares.map((x: { id: string; peso: number }) => [x.id, x.peso])),
    ).toEqual(novos);

    const depois = await scores();
    expect([...depois].some(([velaid, s]) => s !== antes.get(velaid))).toBe(true);

    const aud = await p.db.query<{
      detalhes: { pesos: { antes: unknown; depois: unknown } };
      usuario_id: string;
    }>("select detalhes, usuario_id from auditoria where acao = 'atualizar_parametros'");
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]!.detalhes.pesos.antes).toEqual(PESOS_WORD);
    expect(aud.rows[0]!.detalhes.pesos.depois).toEqual(novos);

    await gravar(EMAILS_DEMO.gestor, { pesos: PESOS_WORD });
    expect([...(await scores())]).toEqual([...antes]);
  });

  it("atualiza a faixa de peso de uma classe e o Class Fit passa a usá-la", async () => {
    const g = EMAILS_DEMO.gestor;
    const classe = (await ler(g)).corpo.classes[0];
    const r = await gravar(g, {
      classes: [{ id: classe.id, pesoMinKg: 50, pesoMedioKg: 60.5, pesoMaxKg: 70 }],
    });
    expect(r.status).toBe(200);
    expect(r.corpo.classes.find((c: { id: string }) => c.id === classe.id)).toMatchObject({
      pesoMinKg: 50,
      pesoMedioKg: 60.5,
      pesoMaxKg: 70,
    });
    const aud = await p.db.query<{
      detalhes: { classes: { depois: Record<string, { pesoKg: number[]; ativa: boolean }> } };
    }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.classes.depois[classe.id]).toEqual({
      pesoKg: [50, 60.5, 70],
      ativa: true,
    });
  });
});

describe("/parametros: altura de referência da classe (informativa)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const g = EMAILS_DEMO.gestor;
  const ler = async () =>
    (await p.app.inject({ method: "GET", url: "/parametros", headers: await p.como(g) })).json()
      .classes as Record<string, unknown>[];
  const gravar = async (classe: Record<string, unknown>) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(g),
      payload: { classes: [classe] },
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const auditorias = async () =>
    (
      await p.db.query<{ detalhes: { classes: { antes: unknown; depois: unknown } } }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id",
      )
    ).rows.map((l) => l.detalhes.classes);

  it("GET traz a faixa de altura da classe (do seed fictício) e nula quando não definida", async () => {
    const ilca7 = (await ler()).find((c) => c.id === "ilca7");
    expect(ilca7).toMatchObject({ alturaMinCm: 180, alturaMediaCm: 185, alturaMaxCm: 190 });
    await p.db.query(
      "update classes set altura_min_cm = null, altura_media_cm = null, altura_max_cm = null where id = 'ilca6'",
    );
    expect((await ler()).find((c) => c.id === "ilca6")).toMatchObject({
      alturaMinCm: null,
      alturaMediaCm: null,
      alturaMaxCm: null,
    });
  });

  it("faixa inválida -> 400 sem gravar", async () => {
    const base = { id: "ilca6", alturaMinCm: 170, alturaMediaCm: 175, alturaMaxCm: 180 };
    const antes = await ler();
    for (const ruim of [
      { alturaMinCm: 119.9 },
      { alturaMaxCm: 230.1 },
      { alturaMinCm: 176 },
      { alturaMaxCm: 172 },
      { alturaMinCm: null },
    ]) {
      expect((await gravar({ ...base, ...ruim })).status, JSON.stringify(ruim)).toBe(400);
    }
    // Faltando uma das três.
    expect((await gravar({ id: "ilca6", alturaMinCm: 170, alturaMediaCm: 175 })).status).toBe(400);
    expect(await ler()).toEqual(antes);
    expect(await auditorias()).toHaveLength(0);
  });

  it("faixa válida grava, audita antes e depois, e limpar volta a nulo", async () => {
    const ok = await gravar({
      id: "ilca6",
      alturaMinCm: 168,
      alturaMediaCm: 173.5,
      alturaMaxCm: 178,
    });
    expect(ok.status).toBe(200);
    expect(ok.corpo.classes.find((c: { id: string }) => c.id === "ilca6")).toMatchObject({
      alturaMinCm: 168,
      alturaMediaCm: 173.5,
      alturaMaxCm: 178,
    });

    const limpa = await gravar({
      id: "ilca6",
      alturaMinCm: null,
      alturaMediaCm: null,
      alturaMaxCm: null,
    });
    expect(limpa.status).toBe(200);
    expect(limpa.corpo.classes.find((c: { id: string }) => c.id === "ilca6")).toMatchObject({
      alturaMinCm: null,
      alturaMediaCm: null,
      alturaMaxCm: null,
    });

    const [a1, a2] = await auditorias();
    expect(a1).toMatchObject({
      antes: { ilca6: { alturaCm: null } },
      depois: { ilca6: { alturaCm: [168, 173.5, 178] } },
    });
    expect(a2).toMatchObject({
      antes: { ilca6: { alturaCm: [168, 173.5, 178] } },
      depois: { ilca6: { alturaCm: null } },
    });
  });

  it("editar só a altura não mexe no peso", async () => {
    const antes = (await ler()).find((c) => c.id === "ilca7")!;
    await gravar({ id: "ilca7", alturaMinCm: 181, alturaMediaCm: 186, alturaMaxCm: 191 });
    const depois = (await ler()).find((c) => c.id === "ilca7")!;
    expect(depois).toEqual({ ...antes, alturaMinCm: 181, alturaMediaCm: 186, alturaMaxCm: 191 });
  });
});

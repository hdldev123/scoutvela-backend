import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, criarAppDeTeste, criarUsuarioDeTeste, tokenPara } from "../apoio/app.js";
import { criarBancoDeTeste } from "../apoio/banco.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const LANCAMENTO_FUTURO = "2099-01-01T00:00:00.000Z";

interface Alvo {
  atleta: { id: string; nome: string };
  score: number;
  perfilSuporte: string;
  mesesAssegurados: number | null;
}
interface Painel {
  ciclo: { nome: string; prazo: string } | null;
  cicloExibido: {
    id: string;
    nome: string;
    status: string;
    fechadoEm: string | null;
  } | null;
  parcial: boolean;
  congelamentoCompleto: boolean;
  ciclosDisponiveis: { id: string; nome: string; status: string; fechadoEm: string | null }[];
  dadosAtualizadosEm: string | null;
  kpis: {
    atletas: number;
    scoreMedio: number;
    aptos: number | null;
    dependentesApoio: number | null;
  };
  funil: { faixa: { id: string }; n: number }[];
  gates: { gate: number; apto: number | null; condicional: number | null; alerta: number | null }[];
  mediaPilares: { pilarId: string; media: number | null }[];
  ondeInvestir: Alvo[];
  ocultosSemConsentimento: number | null;
}

describe("GET /investimento com ciclo congelado", () => {
  let p: Piloto;
  let idHelena: string;
  let gestorId: string;
  let abertoId: string;

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    idHelena = await p.idDe("SP-T07");
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    abertoId = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const buscar = async (email: string | null, ciclo?: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: ciclo ? `/investimento?ciclo=${ciclo}` : "/investimento",
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<Painel>(), texto: r.body };
  };
  const fechar = async (id: string) =>
    p.app.inject({
      method: "POST",
      url: `/ciclos/${id}/fechar`,
      headers: await p.como(EMAILS_DEMO.gestor),
    });
  const contar = async (tabela: string, cicloId: string) =>
    Number(
      (
        await p.db.query<{ n: string }>(
          `select count(*)::text as n from ${tabela} where ciclo_id = $1`,
          [cicloId],
        )
      ).rows[0]!.n,
    );
  const numeros = (c: Painel) => ({
    kpis: c.kpis,
    funil: c.funil,
    gates: c.gates,
    mediaPilares: c.mediaPilares,
    ondeInvestir: c.ondeInvestir,
  });

  it("acesso: sem token 401; treinador e atleta 403; ciclo inválido 400; inexistente 404", async () => {
    expect((await buscar(null)).status).toBe(401);
    expect((await buscar(EMAILS_DEMO.treinadora)).status).toBe(403);
    expect((await buscar(EMAILS_DEMO.atleta)).status).toBe(403);
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      expect((await buscar(email, "nao-e-uuid")).status).toBe(400);
      const r = await buscar(email, crypto.randomUUID());
      expect(r.status).toBe(404);
    }
  });

  it("padrão: último ciclo fechado; fechado antes do congelamento completo traz o resto nulo", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      const { status, corpo } = await buscar(email);
      expect(status).toBe(200);
      expect(corpo.cicloExibido).toMatchObject({ nome: "Outubro de 2026", status: "fechado" });
      expect(corpo.ciclo?.nome).toBe("Outubro de 2026");
      expect(corpo.parcial).toBe(false);
      expect(corpo.congelamentoCompleto).toBe(false);
      expect(corpo.ciclosDisponiveis.map((c) => c.nome)).toEqual([
        "Novembro de 2026",
        "Outubro de 2026",
        "Setembro de 2026",
      ]);
      expect(corpo.ciclosDisponiveis.map((c) => c.status)).toEqual([
        "aberto",
        "fechado",
        "fechado",
      ]);
      expect(corpo.dadosAtualizadosEm).toBe(corpo.cicloExibido!.fechadoEm);
      expect(corpo.dadosAtualizadosEm).not.toBeNull();
      // Só score e faixa existem; o resto vem nulo.
      expect(corpo.kpis.atletas).toBe(14);
      expect(corpo.kpis.aptos).toBeNull();
      expect(corpo.kpis.dependentesApoio).toBeNull();
      expect(corpo.funil.reduce((t, f) => t + f.n, 0)).toBe(14);
      for (const g of corpo.gates) {
        expect([g.apto, g.condicional, g.alerta]).toEqual([null, null, null]);
      }
      expect(corpo.mediaPilares.every((m) => m.media === null)).toBe(true);
      expect(corpo.ondeInvestir).toEqual([]);
      expect(corpo.ocultosSemConsentimento).toBeNull();
    }
  });

  it("ciclo aberto: cálculo na hora, parcial, com a data do último lançamento (agregada)", async () => {
    const antes = await buscar(EMAILS_DEMO.gestor, abertoId);
    expect(antes.corpo.cicloExibido).toMatchObject({ nome: "Novembro de 2026", status: "aberto" });
    expect(antes.corpo.parcial).toBe(true);
    expect(antes.corpo.congelamentoCompleto).toBe(true);
    expect(antes.corpo.cicloExibido!.fechadoEm).toBeNull();
    expect(antes.corpo.kpis.aptos).toBeTypeOf("number");
    expect(antes.corpo.dadosAtualizadosEm).not.toBeNull();

    // Um lançamento (aqui, uma medida do atleta sem consentimento) move a data agregada.
    await p.db.query(
      `insert into medidas_corporais (atleta_id, peso_kg, medido_em, evidencia, registrado_por, registrado_em)
       values ($1, 70, $2, 'Pesagem de teste', $3, $2)`,
      [idHelena, LANCAMENTO_FUTURO, gestorId],
    );
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      const r = await buscar(email, abertoId);
      expect(r.corpo.dadosAtualizadosEm, email).toBe(LANCAMENTO_FUTURO);
    }
    // Sugestão do atleta (não pontua) não mexe na data.
    const indicadorA = (
      await p.db.query<{ id: string }>("select id from indicadores where tipo = 'T' limit 1")
    ).rows[0]!.id;
    await p.db.query(
      `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, lancado_em)
       values ($1, $2, 3, 'Sugestão', 'resposta_sugerida', '2100-01-01')`,
      [idHelena, indicadorA],
    );
    expect((await buscar(EMAILS_DEMO.gestor, abertoId)).corpo.dadosAtualizadosEm).toBe(
      LANCAMENTO_FUTURO,
    );
  });

  it("fechar congela pilares, gates, status final e perfil; o congelado não muda com nota nova", async () => {
    // Helena entra em "Onde investir": notas altas, perfil C e gates liberados.
    await p.db.query(
      `insert into financeiro_campanha (atleta_id, perfil_suporte, meses_assegurados, informado_por)
       values ($1::uuid, 'C', 5, $2)`,
      [idHelena, gestorId],
    );
    await p.db.query(
      `insert into gates_decisoes (atleta_id, gate, status, decidido_por)
       select $1::uuid, g, 'apto', $2 from generate_series(1,4) g`,
      [idHelena, gestorId],
    );
    const indicadores = await p.db.query<{ id: string }>(
      "select id from indicadores where tipo <> 'R' and not calculado",
    );
    for (const ind of indicadores.rows) {
      await p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id)
         values ($1, $2, 5, 'Teste de congelamento', 'avaliacao', $3)`,
        [idHelena, ind.id, gestorId],
      );
    }
    const aoVivo = await buscar(EMAILS_DEMO.gestor, abertoId);
    expect(aoVivo.corpo.ondeInvestir.some((x) => x.atleta.id === idHelena)).toBe(true);

    const r = await fechar(abertoId);
    expect(r.statusCode).toBe(200);
    const n = r.json().atletas as number;
    expect(await contar("scores_ciclo", abertoId)).toBe(n);
    expect(await contar("pilares_ciclo", abertoId)).toBe(n * 9);
    expect(await contar("gates_ciclo", abertoId)).toBe(n * 4);
    expect(await contar("fechamento_atleta_ciclo", abertoId)).toBe(n);
    const ciclo = await p.db.query<{ fechado_em: Date; congelamento_completo: boolean }>(
      "select fechado_em, congelamento_completo from ciclos_avaliacao where id = $1",
      [abertoId],
    );
    expect(ciclo.rows[0]!.congelamento_completo).toBe(true);
    expect(ciclo.rows[0]!.fechado_em.toISOString()).toBe(AGORA().toISOString());

    // Novo padrão: o ciclo recém-fechado, com os mesmos números do cálculo na hora.
    const congelado = await buscar(EMAILS_DEMO.gestor);
    expect(congelado.corpo.cicloExibido).toMatchObject({
      id: abertoId,
      status: "fechado",
      fechadoEm: AGORA().toISOString(),
    });
    expect(congelado.corpo.parcial).toBe(false);
    expect(congelado.corpo.congelamentoCompleto).toBe(true);
    expect(congelado.corpo.dadosAtualizadosEm).toBe(AGORA().toISOString());
    expect(congelado.corpo.ciclosDisponiveis[0]).toMatchObject({ id: abertoId, status: "fechado" });
    expect(congelado.corpo.kpis.atletas).toBe(n);
    expect(congelado.corpo.kpis.aptos).toBe(aoVivo.corpo.kpis.aptos);
    expect(congelado.corpo.kpis.dependentesApoio).toBe(aoVivo.corpo.kpis.dependentesApoio);
    expect(congelado.corpo.kpis.scoreMedio).toBeCloseTo(aoVivo.corpo.kpis.scoreMedio, 2);
    expect(congelado.corpo.funil).toEqual(aoVivo.corpo.funil);
    expect(congelado.corpo.gates).toEqual(aoVivo.corpo.gates);
    for (const m of aoVivo.corpo.mediaPilares) {
      const c = congelado.corpo.mediaPilares.find((x) => x.pilarId === m.pilarId)!;
      if (m.media === null) expect(c.media).toBeNull();
      else expect(c.media).toBeCloseTo(m.media, 9);
    }
    expect(congelado.corpo.ondeInvestir.map((x) => x.atleta.id)).toEqual(
      aoVivo.corpo.ondeInvestir.map((x) => x.atleta.id),
    );
    expect(congelado.corpo.ondeInvestir.find((x) => x.atleta.id === idHelena)).toMatchObject({
      perfilSuporte: "C",
      mesesAssegurados: 5,
    });

    // Entra nota nova, outro perfil e outra decisão de gate: o ciclo fechado não se mexe.
    const antes = numeros(congelado.corpo);
    await p.db.query(
      `insert into financeiro_campanha (atleta_id, perfil_suporte, informado_por) values ($1::uuid, 'A', $2)`,
      [idHelena, gestorId],
    );
    await p.db.query(
      `insert into gates_decisoes (atleta_id, gate, status, decidido_por) values ($1::uuid, 2, 'alerta', $2)`,
      [idHelena, gestorId],
    );
    for (const ind of indicadores.rows.slice(0, 10)) {
      await p.db.query(
        `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id)
         values ($1, $2, 0, 'Nota nova depois do fechamento', 'avaliacao', $3)`,
        [idHelena, ind.id, gestorId],
      );
    }
    const depois = await buscar(EMAILS_DEMO.gestor);
    expect(numeros(depois.corpo)).toEqual(antes);
    expect(numeros((await buscar(EMAILS_DEMO.gestor, abertoId)).corpo)).toEqual(antes);
    // O ciclo anterior continua do jeito que estava.
    expect(
      (await buscar(EMAILS_DEMO.gestor, congelado.corpo.ciclosDisponiveis[1]!.id)).corpo,
    ).toMatchObject({ congelamentoCompleto: false });
  });

  it("as tabelas do congelamento só aceitam inserção", async () => {
    await expect(p.db.exec("update pilares_ciclo set nota = 0")).rejects.toThrow(/só inserção/);
    await expect(p.db.exec("delete from gates_ciclo")).rejects.toThrow(/só inserção/);
    await expect(
      p.db.exec("update fechamento_atleta_ciclo set status_final = 'apto'"),
    ).rejects.toThrow(/só inserção/);
  });

  it("ciclo novo aberto: o padrão segue no último fechado; o aberto vem parcial e atual", async () => {
    const novo = await p.app.inject({
      method: "POST",
      url: "/ciclos",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { nome: "Dezembro de 2026", inicio: "2026-12-01", prazo: "2026-12-31" },
    });
    expect(novo.statusCode).toBe(201);
    const padrao = await buscar(EMAILS_DEMO.gestor);
    expect(padrao.corpo.cicloExibido!.id).toBe(abertoId);
    const aberto = await buscar(EMAILS_DEMO.gestor, novo.json().id);
    expect(aberto.corpo).toMatchObject({ parcial: true, congelamentoCompleto: true });
    expect(aberto.corpo.cicloExibido).toMatchObject({ nome: "Dezembro de 2026", status: "aberto" });
    expect(aberto.corpo.ciclosDisponiveis.map((c) => c.nome)[0]).toBe("Dezembro de 2026");
    // Ao vivo a Helena saiu da lista (perfil A, gate 2 em alerta); no congelado ela segue.
    expect(aberto.corpo.ondeInvestir.some((x) => x.atleta.id === idHelena)).toBe(false);
  });

  it("IBVAR no ciclo congelado: agregados completos, lista só de quem consentiu, sem meses", async () => {
    const g = (await buscar(EMAILS_DEMO.gestor)).corpo;
    const i = await buscar(EMAILS_DEMO.ibvar);
    expect(i.status).toBe(200);
    expect(i.corpo.kpis).toEqual(g.kpis);
    expect(i.corpo.funil).toEqual(g.funil);
    expect(i.corpo.gates).toEqual(g.gates);
    expect(i.corpo.mediaPilares).toEqual(g.mediaPilares);
    expect(i.corpo.dadosAtualizadosEm).toBe(g.dadosAtualizadosEm);
    for (const x of i.corpo.ondeInvestir) expect(x.mesesAssegurados).toBeNull();
    expect(i.texto).not.toContain("Helena");
    expect(i.texto).not.toContain(idHelena);

    const idsGestor = g.ondeInvestir.map((x) => x.atleta.id);
    const idsIbvar = i.corpo.ondeInvestir.map((x) => x.atleta.id);
    expect(idsGestor).toContain(idHelena);
    expect(idsIbvar).not.toContain(idHelena);
    expect(i.corpo.ocultosSemConsentimento).toBe(idsGestor.length - idsIbvar.length);
    expect(g.ondeInvestir.every((x) => typeof x.mesesAssegurados === "number")).toBe(true);
  });

  it("consentimento vale o atual: quem revogou sai da lista do IBVAR e segue nos agregados", async () => {
    const i = (await buscar(EMAILS_DEMO.ibvar)).corpo;
    expect(i.ondeInvestir.length).toBeGreaterThan(0);
    const alvo = i.ondeInvestir[0]!;
    await p.db.query(
      `insert into consentimentos (atleta_id, tipo, concedido, registrado_por)
       values ($1, 'compartilhar_ibvar', false, $2)`,
      [alvo.atleta.id, gestorId],
    );
    const depois = await buscar(EMAILS_DEMO.ibvar);
    expect(depois.corpo.ondeInvestir.map((x) => x.atleta.id)).not.toContain(alvo.atleta.id);
    expect(depois.texto).not.toContain(alvo.atleta.nome);
    expect(depois.corpo.ocultosSemConsentimento).toBe(i.ocultosSemConsentimento! + 1);
    expect(depois.corpo.kpis).toEqual(i.kpis);
    expect(depois.corpo.funil).toEqual(i.funil);
  });
});

describe("GET /investimento sem ciclo fechado", () => {
  it("sem ciclo nenhum: cicloExibido nulo; só o aberto: abre nele, parcial", async () => {
    const db = await criarBancoDeTeste();
    const app = await criarAppDeTeste(db, { agora: AGORA });
    try {
      const gestor = await criarUsuarioDeTeste(db, { papel: "gestor" });
      const headers = cabecalhoAuth(await tokenPara(gestor.authUserId));
      const buscar = async (url = "/investimento") =>
        (await app.inject({ method: "GET", url, headers })).json<Painel>();

      const vazio = await buscar();
      expect(vazio).toMatchObject({
        ciclo: null,
        cicloExibido: null,
        parcial: true,
        ciclosDisponiveis: [],
        dadosAtualizadosEm: null,
      });
      expect(vazio.kpis.atletas).toBe(0);

      const aberto = (
        await db.query<{ id: string }>(
          `insert into ciclos_avaliacao (nome, inicio, prazo, status) values ('Ciclo A', '2026-11-01', '2026-11-30', 'aberto') returning id`,
        )
      ).rows[0]!.id;
      const padrao = await buscar();
      expect(padrao.cicloExibido).toMatchObject({ id: aberto, status: "aberto", fechadoEm: null });
      expect(padrao.parcial).toBe(true);
      expect(padrao.ciclo).toEqual({ nome: "Ciclo A", prazo: "2026-11-30" });
      expect(await buscar(`/investimento?ciclo=${aberto}`)).toMatchObject({ parcial: true });
    } finally {
      await app.close();
      await db.fechar();
    }
  });
});

describe("ficha: dadosAtualizadosEm do atleta", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const ficha = async (email: string, id: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${id}`,
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };

  it("é o último lançamento do próprio atleta; o IBVAR só recebe de quem consentiu", async () => {
    const consentiu = (
      await p.db.query<{ atleta_id: string }>(
        `select atleta_id from consentimento_atual where tipo = 'compartilhar_ibvar' and concedido limit 1`,
      )
    ).rows[0]!.atleta_id;
    const semConsentimento = await p.idDe("SP-T07");
    const gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;

    const antes = await ficha(EMAILS_DEMO.gestor, consentiu);
    expect(antes.status).toBe(200);
    expect(antes.corpo.dadosAtualizadosEm).not.toBe(LANCAMENTO_FUTURO);

    await p.db.query(
      `insert into gates_decisoes (atleta_id, gate, status, decidido_por, decidido_em)
       values ($1, 1, 'apto', $2, $3)`,
      [consentiu, gestorId, LANCAMENTO_FUTURO],
    );
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      const r = await ficha(email, consentiu);
      expect(r.status, email).toBe(200);
      expect(r.corpo.dadosAtualizadosEm, email).toBe(LANCAMENTO_FUTURO);
    }
    // O lançamento de um atleta não aparece na ficha de outro.
    const outro = await ficha(EMAILS_DEMO.gestor, semConsentimento);
    expect(outro.corpo.dadosAtualizadosEm).not.toBe(LANCAMENTO_FUTURO);

    // Sem consentimento, o IBVAR não recebe a ficha (nem a data).
    const negado = await ficha(EMAILS_DEMO.ibvar, semConsentimento);
    expect(negado.status).toBe(404);
    expect(negado.texto).not.toContain("dadosAtualizadosEm");
  });
});

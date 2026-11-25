import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria } from "../../src/email/index.js";
import { executarLembretes } from "../../src/jobs/lembretes.js";
import { EMAILS_DEMO, criarPiloto, urlInvestimentoAberto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

/**
 * TERMO_EXIGE_REACEITE ligada e desligada em todos os lugares que decidem "termo aceito no piloto":
 * fechamento do ciclo, pendências, lembretes, GET /investimento, notificações e ficha do IBVAR.
 *
 * Cenário: o termo v1 foi aceito por todos os 14 atletas do seed; a v2 entra em vigor em 10/11/2026.
 * - antecipado = true: só a Helena (SP-T07) aceitou a v2 antecipadamente.
 * - antecipado = false: ninguém aceitou a v2.
 * Regra ligada: só entra no piloto quem aceitou a versão vigente (v2). Desligada: qualquer aceite vale.
 *
 * Valores esperados do seed (conferidos à mão): 14 atletas ativos, 7 de cada treinador; 30
 * indicadores T lançáveis, nenhum com nota no ciclo aberto; 8 perguntas no questionário, nenhuma
 * respondida pela Helena e todas respondidas pelos outros. "faltam" = indicadores T sem nota.
 */
const V2 = "Piloto 18+ · v2";
const TEXTO =
  "Segunda versão do termo do piloto, com o texto revisado pela CBVela para o ciclo seguinte.";
const HOJE = new Date("2026-11-23T12:00:00-03:00"); // v2 já vigente; 7 dias antes do prazo (30/11)

// D10: perf_mundial, perf_continental e perf_nacional passaram a ser calculados e saíram dos 33 indicadores
// T lançáveis (agora 30). O seed deixou de lançar nota neles; cada atleta perde de 0 a 3 notas do ciclo
// aberto (as que tinha com data de novembro), por isso "faltam" cai de 0 a 3 em relação ao valor anterior.
const FALTAM_ANA: Record<string, number> = {
  "Bianca Lemos": 24,
  "Helena Vasques": 25,
  "Isadora Prates": 23,
  "Lívia Arruda": 23,
  "Marina Seixas": 27,
  "Nina Cardoso": 20,
  "Pedro Viana": 18,
};
const FALTAM_MARCOS: Record<string, number> = {
  "Caio Tavares": 19,
  "Davi Moretto": 19,
  "Gabriel Teles": 13,
  "Larissa Fontes": 22,
  "Otávio Brandão": 20,
  "Rafael Quintela": 22,
  "Tomás Albuquerque": 25,
};

interface Pendencias {
  treinadores: {
    nome: string;
    atletasPendentes: { nome: string; faltam: number }[];
  }[];
  atletas: { nome: string; perguntasSemResposta: number }[];
  totais: { treinadoresComPendencia: number; atletasComPendencia: number };
}

const faltamPorNome = (t: Pendencias["treinadores"][number] | undefined) =>
  Object.fromEntries((t?.atletasPendentes ?? []).map((a) => [a.nome, a.faltam]));

const HELENA = { id: expect.any(String), nome: "Helena Vasques", perguntasSemResposta: 8 };

describe.each([
  { regra: true, antecipado: true },
  { regra: true, antecipado: false },
  { regra: false, antecipado: true },
  { regra: false, antecipado: false },
])("TERMO_EXIGE_REACEITE ativa=$regra, Helena aceitou a v2 antes=$antecipado", (c) => {
  // Quem está no piloto: regra desligada, os 14; ligada, só quem aceitou a v2.
  const noPiloto = c.regra ? (c.antecipado ? 1 : 0) : 14;
  let p: Piloto;
  let agora = new Date("2026-11-06T12:00:00-03:00");
  let ciclo: string;

  const chamar = async (
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: object,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: await p.como(email),
      ...(payload ? { payload } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };

  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
          regras: { TERMO_EXIGE_REACEITE: { ativa: c.regra } },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
          versao: V2,
          titulo: "Termo v2",
          texto: TEXTO,
          vigenteDesde: "2026-11-10T00:00:00-03:00",
        })
      ).status,
    ).toBe(201);
    if (c.antecipado) {
      expect(
        (await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: V2 })).status,
      ).toBe(200);
    }
    agora = HOJE;
    ciclo = (
      await p.db.query<{ id: string }>("select id from ciclos_avaliacao where status = 'aberto'")
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  it("pendências do ciclo: só atletas do piloto", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "GET", `/ciclos/${ciclo}/pendencias`);
    expect(r.status).toBe(200);
    const corpo = r.corpo as Pendencias;
    const ana = corpo.treinadores.find((t) => t.nome === "Ana Ribeiro");
    const marcos = corpo.treinadores.find((t) => t.nome === "Marcos Pires");
    if (c.regra) {
      // Só a Helena (da Ana) entra, e só se aceitou a v2.
      expect(faltamPorNome(ana)).toEqual(c.antecipado ? { "Helena Vasques": 25 } : {});
      expect(marcos).toBeUndefined();
      expect(corpo.atletas).toEqual(c.antecipado ? [HELENA] : []);
      expect(corpo.treinadores).toHaveLength(c.antecipado ? 1 : 0);
    } else {
      expect(faltamPorNome(ana)).toEqual(FALTAM_ANA);
      expect(faltamPorNome(marcos)).toEqual(FALTAM_MARCOS);
      expect(corpo.atletas).toEqual([HELENA]);
      expect(corpo.treinadores).toHaveLength(2);
    }
    expect(corpo.totais.treinadoresComPendencia).toBe(corpo.treinadores.length);
    expect(corpo.totais.atletasComPendencia).toBe(corpo.atletas.length);
  });

  it("job de lembretes: só quem tem atleta do piloto", async () => {
    const email = criarProvedorEmailMemoria();
    const r = await executarLembretes({
      db: p.db,
      email,
      agora: HOJE,
      frontUrl: "https://app.scoutvela.dev",
    });
    const destinos = email.enviadas.map((m) => m.para).sort();
    if (c.regra && !c.antecipado) {
      expect(r).toEqual({ treinadores: 0, atletas: 0, ignorados: 0 });
      expect(destinos).toEqual([]);
    } else if (c.regra) {
      expect(r).toEqual({ treinadores: 1, atletas: 1, ignorados: 0 });
      expect(destinos).toEqual([EMAILS_DEMO.atleta, EMAILS_DEMO.treinadora].sort());
    } else {
      // Os dois treinadores (7 atletas cada) e a Helena, a única com pergunta sem resposta.
      expect(r).toEqual({ treinadores: 2, atletas: 1, ignorados: 0 });
      expect(destinos).toContain(EMAILS_DEMO.atleta);
      expect(destinos).toContain(EMAILS_DEMO.treinadora);
      expect(destinos).toHaveLength(3);
    }
  });

  it("GET /investimento: os agregados contam só o piloto", async () => {
    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.ibvar]) {
      const r = await chamar(email, "GET", await urlInvestimentoAberto(p.db));
      expect(r.status).toBe(200);
      expect(r.corpo.kpis.atletas, email).toBe(noPiloto);
      expect(
        (r.corpo.funil as { n: number }[]).reduce((t, f) => t + f.n, 0),
        email,
      ).toBe(noPiloto);
    }
  });

  it("notificações: cadastro e painel seguem a versão vigente, não a regra", async () => {
    // Com a v2 vigente, está pendente quem não a aceitou, com a regra ligada ou desligada.
    const gestor = await chamar(EMAILS_DEMO.gestor, "GET", "/me/notificacoes");
    expect(gestor.corpo.contagens.cadastro).toBe(c.antecipado ? 13 : 14);
    // Painel da Helena: 1 pelo termo pendente (se não aceitou a v2) e 1 por pergunta sem resposta (8),
    // mas as perguntas só contam enquanto ela está no piloto (mesma regra do job de lembretes).
    const atleta = await chamar(EMAILS_DEMO.atleta, "GET", "/me/notificacoes");
    const emDia = c.antecipado;
    const noPilotoHelena = !c.regra || emDia;
    expect(atleta.corpo.contagens.painel).toBe((emDia ? 0 : 1) + (noPilotoHelena ? 8 : 0));
  });

  it("POST /ciclos/:id/fechar congela só os atletas do piloto", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${ciclo}/fechar`);
    if (noPiloto === 0) {
      // Há atletas ativos, mas nenhum com o termo vigente aceito: nada a congelar.
      expect(r.status).toBe(409);
      expect(
        (await p.db.query("select 1 from scores_ciclo where ciclo_id = $1", [ciclo])).rows,
      ).toHaveLength(0);
      expect(
        (await p.db.query("select status from ciclos_avaliacao where id = $1", [ciclo])).rows[0],
      ).toEqual({ status: "aberto" });
      return;
    }
    expect(r.status).toBe(200);
    expect(r.corpo.atletas).toBe(noPiloto);
    const congelados = await p.db.query<{ velaid_codigo: string }>(
      `select a.velaid_codigo from scores_ciclo s join atletas a on a.id = s.atleta_id
        where s.ciclo_id = $1 order by 1`,
      [ciclo],
    );
    expect(congelados.rows).toHaveLength(noPiloto);
    if (c.regra) expect(congelados.rows.map((l) => l.velaid_codigo)).toEqual(["SP-T07"]);
  });

  it("ficha do IBVAR: fora do piloto é 404 (SC-T01 consentiu o compartilhamento)", async () => {
    const livia = await p.idDe("SC-T01");
    const ficha = () => chamar(EMAILS_DEMO.ibvar, "GET", `/atletas/${livia}`);
    // Regra desligada: o aceite da v1 basta. Ligada: a Lívia não aceitou a v2.
    expect((await ficha()).status).toBe(c.regra ? 404 : 200);
    // Gestor e treinadora mantêm o acesso nos dois casos.
    expect((await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${livia}`)).status).toBe(200);
    expect((await chamar(EMAILS_DEMO.treinadora, "GET", `/atletas/${livia}`)).status).toBe(200);
    // Aceite da v2 registrado pelo gestor: volta para o piloto nos dois casos.
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${livia}/termo`, { versao: V2 })).status,
    ).toBe(200);
    expect((await ficha()).status).toBe(200);
  });
});

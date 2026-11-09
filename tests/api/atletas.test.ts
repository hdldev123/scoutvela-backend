import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface PilarFicha {
  id: string;
  restrito: boolean;
  nota: number | null;
  indicadores: { id: string; nota: number | null; evidencia: string | null; avaliador: unknown; calculado: boolean; sugestaoPendente: unknown }[] | null;
}

describe("GET /atletas/:id", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const ficha = async (email: string, velaidOuId: string) => {
    const id = velaidOuId.includes("-T") ? await p.idDe(velaidOuId) : velaidOuId;
    const r = await p.app.inject({ method: "GET", url: `/atletas/${id}`, headers: await p.como(email) });
    return { status: r.statusCode, corpo: r.json(), texto: r.body };
  };

  it("sem token -> 401; uuid inválido -> 400; uuid inexistente -> 404", async () => {
    const id = await p.idDe("SC-T01");
    expect((await p.app.inject({ method: "GET", url: `/atletas/${id}` })).statusCode).toBe(401);
    expect((await ficha(EMAILS_DEMO.gestor, "nao-e-uuid")).status).toBe(400);
    expect((await ficha(EMAILS_DEMO.gestor, "00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("gestor vê tudo: sensíveis, classFit, financeiro completo e contato", async () => {
    const { status, corpo } = await ficha(EMAILS_DEMO.gestor, "SC-T01");
    expect(status).toBe(200);
    expect(corpo.atleta).toMatchObject({ velaid: "SC-T01", termoAceito: true, idade: expect.any(Number) });
    expect(corpo.contato.treinador.nome).toBe("Ana Ribeiro");
    expect(corpo.contato.email).toEqual(expect.any(String));
    expect(corpo.pilares).toHaveLength(9);
    const sensiveis = (corpo.pilares as PilarFicha[]).filter((x) => x.restrito);
    expect(sensiveis).toHaveLength(0);
    const cf = (corpo.pilares as PilarFicha[]).find((x) => x.id === "cf")!;
    expect(cf.indicadores!.length).toBeGreaterThan(0);
    const peso = cf.indicadores!.find((i) => i.id === "cf_peso_kg")!;
    expect(peso).toMatchObject({ calculado: true, nota: 5, evidencia: "Pesagem: 72,4 kg" });
    expect(peso.avaliador).toMatchObject({ nome: "Ana Ribeiro" });
    expect(corpo.classFit).toMatchObject({ pesoKg: 72.4, pesoMedioKg: expect.any(Number) });
    expect(corpo.financeiro.componentes.length).toBeGreaterThan(0);
    expect(corpo.gates.itens.map((g: { nome: string }) => g.nome)).toEqual([
      "Class Fit", "Evidência competitiva", "Alto rendimento", "Campanha",
    ]);
    expect(corpo.historicoScore.map((h: { ciclo: string }) => h.ciclo)).toEqual(["Setembro de 2026", "Outubro de 2026"]);
    expect(corpo.resultados.length).toBeGreaterThan(0);
    expect(corpo.ciclo.nome).toBe("Novembro de 2026");
  });

  it("treinadora vê atleta dela sem financeiro, e 404 no atleta do Marcos Pires", async () => {
    const dela = await ficha(EMAILS_DEMO.treinadora, "SC-T01");
    expect(dela.status).toBe(200);
    expect(dela.corpo.financeiro).toBeNull();
    expect(dela.corpo.classFit).not.toBeNull();
    expect(dela.corpo.contato).not.toBeNull();
    expect((await ficha(EMAILS_DEMO.treinadora, "RS-T02")).status).toBe(404);
  });

  it("atleta vê a própria ficha completa e 404 em outra", async () => {
    const propria = await ficha(EMAILS_DEMO.atleta, "SP-T07");
    expect(propria.status).toBe(200);
    expect(propria.corpo.financeiro.componentes.length).toBeGreaterThan(0);
    expect(propria.corpo.classFit).not.toBeNull();
    expect((propria.corpo.pilares as PilarFicha[]).every((x) => !x.restrito)).toBe(true);
    expect((await ficha(EMAILS_DEMO.atleta, "SC-T01")).status).toBe(404);
  });

  it("IBVAR: 404 na Helena (sem consentimento)", async () => {
    expect((await ficha(EMAILS_DEMO.ibvar, "SP-T07")).status).toBe(404);
  });

  it("IBVAR em atleta com consentimento: sensíveis restritos, sem classFit, contato nem dados do treinador", async () => {
    const { status, corpo, texto } = await ficha(EMAILS_DEMO.ibvar, "SC-T01");
    expect(status).toBe(200);
    const pilares = corpo.pilares as PilarFicha[];
    const restritos = pilares.filter((x) => x.restrito).map((x) => x.id).sort();
    expect(restritos).toEqual(["amb", "cf", "men"]);
    for (const x of pilares.filter((y) => y.restrito)) {
      expect(x.indicadores).toBeNull();
      expect(x.nota).not.toBeNull();
    }
    for (const x of pilares.filter((y) => !y.restrito)) expect(x.indicadores!.length).toBeGreaterThan(0);
    expect(corpo.classFit).toBeNull();
    expect(corpo.contato).toBeNull();
    expect(Object.keys(corpo.financeiro)).toEqual(["perfilSuporte"]);
    expect(corpo.gates.itens).toHaveLength(4);
    expect(texto).not.toContain("72,4");
    expect(texto).not.toContain("72.4");
    expect(texto).not.toContain("Ana Ribeiro");
    expect(texto).not.toContain("@");
    expect(texto).not.toContain("pesoKg");
  });

  it("decisão do gestor em gate aparece com ajustadoPeloGestor", async () => {
    const id = await p.idDe("SC-T01");
    const antes = (await ficha(EMAILS_DEMO.gestor, id)).corpo;
    expect(antes.gates.itens[0].ajustadoPeloGestor).toBe(false);
    const automatica = antes.gates.itens[0].status;
    const nova = automatica === "alerta" ? "apto" : "alerta";
    await p.db.query(
      `insert into gates_decisoes (atleta_id, gate, status, justificativa, decidido_por)
       values ($1, 1, $2, 'Teste', (select id from usuarios where email = $3))`,
      [id, nova, EMAILS_DEMO.gestor],
    );
    const depois = (await ficha(EMAILS_DEMO.gestor, id)).corpo;
    expect(depois.gates.itens[0]).toMatchObject({ status: nova, ajustadoPeloGestor: true, sugestaoAutomatica: automatica });
    expect(depois.gates.statusFinal).not.toBeUndefined();
  });

  it("sugestão pendente aparece no indicador e não vale como nota", async () => {
    const id = await p.idDe("SC-T01");
    const antes = (await ficha(EMAILS_DEMO.gestor, id)).corpo;
    const ind = (antes.pilares as PilarFicha[]).find((x) => x.id === "tec")!.indicadores![0]!;
    expect(ind.sugestaoPendente).toBeNull();
    await p.db.query(
      `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, lancado_em)
       values ($1, $2, 1, 'Resposta do atleta', 'resposta_sugerida', '2026-11-05T12:00:00-03:00')`,
      [id, ind.id],
    );
    const depois = (await ficha(EMAILS_DEMO.gestor, id)).corpo;
    const ind2 = (depois.pilares as PilarFicha[]).find((x) => x.id === "tec")!.indicadores![0]!;
    expect(ind2.nota).toBe(ind.nota);
    expect(ind2.sugestaoPendente).toMatchObject({ valor: 1 });
    expect(depois.score).toBe(antes.score);
  });

  it("atleta inativo não aparece (404)", async () => {
    const id = await p.idDe("DF-T12");
    await p.db.query("update atletas set ativo = false where id = $1", [id]);
    expect((await ficha(EMAILS_DEMO.gestor, id)).status).toBe(404);
  });
});

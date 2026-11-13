import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Lancamento {
  valor: number;
  pesoKg: number | null;
  evidencia: string | null;
  origem: string;
  pendente: boolean;
  avaliador: { id: string; nome: string } | null;
  cicloNome: string | null;
  lancadoEm: string;
  anexo: { id: string; nomeArquivo: string } | null;
}

describe("GET /atletas/:id/indicadores/:indicadorId/historico", () => {
  let p: Piloto;
  let livia: string; // SC-T01, da Ana, consentiu com o IBVAR
  let helena: string; // SP-T07, da Ana, conta de atleta, sem consentimento IBVAR
  let rafael: string; // RJ-T05, do Marcos

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    [livia, helena, rafael] = await Promise.all([
      p.idDe("SC-T01"),
      p.idDe("SP-T07"),
      p.idDe("RJ-T05"),
    ]);
    // Novo lançamento de perf_nacional e nova pesagem, pela treinadora, no ciclo aberto.
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${livia}/avaliacoes`,
      headers: await p.como(EMAILS_DEMO.treinadora),
      payload: {
        notas: [{ indicadorId: "perf_nacional", valor: 4, evidencia: "Brasileiro 2026: 2º lugar" }],
        medida: { pesoKg: 75 },
      },
    });
    expect(r.statusCode).toBe(201);
    // Sugestão pendente vinda da resposta do atleta (pilar Carreira, não sensível).
    await p.db.query(
      `insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, lancado_em)
       values ($1, 'car_disponibilidade', 3, 'Resposta do atleta', 'resposta_sugerida', $2)`,
      [livia, AGORA()],
    );
  });
  afterAll(() => p.encerrar());

  const historico = async (email: string | null, atletaId: string, indicadorId: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${atletaId}/indicadores/${indicadorId}/historico`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<Lancamento[]>() };
  };

  it("sem token 401; uuid inválido 400; atleta ou indicador inexistente 404", async () => {
    expect((await historico(null, livia, "perf_nacional")).status).toBe(401);
    expect((await historico(EMAILS_DEMO.gestor, "nao-e-uuid", "perf_nacional")).status).toBe(400);
    expect((await historico(EMAILS_DEMO.gestor, crypto.randomUUID(), "perf_nacional")).status).toBe(
      404,
    );
    expect((await historico(EMAILS_DEMO.gestor, livia, "nao_existe")).status).toBe(404);
  });

  it("gestor: do mais novo para o mais antigo, com avaliador, ciclo e evidência", async () => {
    const { status, corpo } = await historico(EMAILS_DEMO.gestor, livia, "perf_nacional");
    expect(status).toBe(200);
    expect(corpo.length).toBeGreaterThanOrEqual(2);
    expect(corpo[0]).toMatchObject({
      valor: 4,
      evidencia: "Brasileiro 2026: 2º lugar",
      origem: "avaliacao",
      pendente: false,
      avaliador: { nome: "Ana Ribeiro" },
      cicloNome: "Novembro de 2026",
      lancadoEm: AGORA().toISOString(),
      pesoKg: null,
    });
    const datas = corpo.map((l) => Date.parse(l.lancadoEm));
    expect(datas).toEqual([...datas].sort((a, b) => b - a));
  });

  it("inclui a sugestão pendente do atleta, marcada como tal", async () => {
    const { corpo } = await historico(EMAILS_DEMO.gestor, livia, "car_disponibilidade");
    expect(corpo[0]).toMatchObject({
      valor: 3,
      origem: "resposta_sugerida",
      pendente: true,
      avaliador: null,
    });
    expect(corpo.filter((l) => l.pendente)).toHaveLength(1);
  });

  it("cf_peso_kg devolve as pesagens com a nota pela P3", async () => {
    const { status, corpo } = await historico(EMAILS_DEMO.gestor, livia, "cf_peso_kg");
    expect(status).toBe(200);
    expect(corpo).toHaveLength(2);
    expect(corpo[0]).toMatchObject({
      pesoKg: 75,
      origem: "calculado",
      cicloNome: null,
      anexo: null,
    });
    expect(corpo[0]!.avaliador).toMatchObject({ nome: "Ana Ribeiro" });
    expect(corpo[1]).toMatchObject({ pesoKg: 72.4, valor: 5, evidencia: "Pesagem: 72,4 kg" });
    expect(corpo.every((l) => l.valor >= 0 && l.valor <= 5)).toBe(true);
  });

  it("treinador só vê os próprios atletas", async () => {
    expect((await historico(EMAILS_DEMO.treinadora, livia, "perf_nacional")).status).toBe(200);
    expect((await historico(EMAILS_DEMO.treinadora, rafael, "perf_nacional")).status).toBe(404);
  });

  it("atleta só vê o seu", async () => {
    expect((await historico(EMAILS_DEMO.atleta, helena, "perf_nacional")).status).toBe(200);
    expect((await historico(EMAILS_DEMO.atleta, livia, "perf_nacional")).status).toBe(404);
  });

  it("IBVAR: pilar sensível 403; nos demais, sem evidência, avaliador, anexo nem sugestão", async () => {
    for (const ind of ["cf_peso_kg", "cf_composicao", "men_resiliencia", "amb_autonomia"]) {
      expect((await historico(EMAILS_DEMO.ibvar, livia, ind)).status, ind).toBe(403);
    }
    const perf = await historico(EMAILS_DEMO.ibvar, livia, "perf_nacional");
    expect(perf.status).toBe(200);
    expect(perf.corpo.length).toBeGreaterThan(0);
    for (const l of perf.corpo) {
      expect(l).toMatchObject({ evidencia: null, avaliador: null, anexo: null });
    }
    const car = await historico(EMAILS_DEMO.ibvar, livia, "car_disponibilidade");
    expect(car.corpo.some((l) => l.pendente)).toBe(false);
    // Sem consentimento de compartilhamento: o IBVAR nem enxerga o atleta.
    expect((await historico(EMAILS_DEMO.ibvar, helena, "perf_nacional")).status).toBe(404);
  });
});

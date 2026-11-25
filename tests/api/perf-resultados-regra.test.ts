import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const faixas = (...f: [number | null, number][]) => f.map(([ate, nota]) => ({ ate, nota }));
const PADRAO = {
  edicoes_max: 4,
  niveis: {
    mundial: faixas([3, 5], [10, 4], [25, 3], [null, 2]),
    continental: faixas([3, 5], [10, 4], [25, 3], [null, 2]),
    nacional: faixas([1, 5], [2, 4], [3, 3], [null, 0]),
  },
};

describe("D10: regra PERF_RESULTADOS e remoção da PERF_PONTOS", () => {
  let p: Piloto;
  let livia: string; // SC-T01: Mundial 12º, Sul-Americano 2º e Brasileiro 4º no seed
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
    livia = await p.idDe("SC-T01");
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    metodo: "GET" | "PUT" | "POST",
    url: string,
    corpo?: object,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: email ? await p.como(email) : {},
      ...(corpo ? { payload: corpo } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const gravar = (valor: unknown, email: string | null = EMAILS_DEMO.gestor) =>
    chamar(email, "PUT", "/parametros", { regras: { PERF_RESULTADOS: valor } });
  const notaDe = async (id: string) => {
    const f = (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${livia}`)).corpo;
    return f.pilares
      .flatMap((x: { indicadores: { id: string; nota: number | null }[] }) => x.indicadores)
      .find((i: { id: string }) => i.id === id).nota;
  };

  it("GET /parametros traz PERF_RESULTADOS com os valores provisórios e nenhuma PERF_PONTOS", async () => {
    const r = await chamar(EMAILS_DEMO.treinadora, "GET", "/parametros");
    const regras = r.corpo.regras as { codigo: string; descricao: string; valor: unknown }[];
    expect(regras.find((x) => x.codigo === "PERF_PONTOS")).toBeUndefined();
    const regra = regras.find((x) => x.codigo === "PERF_RESULTADOS")!;
    expect(regra.valor).toEqual(PADRAO);
    expect(regra.descricao).toContain("provisórios");
    expect(regra.descricao).toContain("Juan");
  });

  it("a ficha e a prévia não têm mais sugestaoPontos; os pontos do Ranking seguem como informação", async () => {
    const f = (await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${livia}`)).corpo;
    expect(f.pontosCbvela).toBeGreaterThan(0);
    for (const i of f.pilares.flatMap((x: { indicadores: object[] }) => x.indicadores)) {
      expect(i).not.toHaveProperty("sugestaoPontos");
    }
    const previa = await chamar(
      EMAILS_DEMO.treinadora,
      "POST",
      `/atletas/${livia}/avaliacoes/previa`,
      {
        notas: [{ indicadorId: "perf_consistencia", valor: 3, evidencia: "Treino de sábado" }],
      },
    );
    expect(previa.status, JSON.stringify(previa.corpo)).toBe(200);
    expect(previa.corpo).not.toHaveProperty("sugestaoPontos");
  });

  it("a regra do seed dá as notas esperadas (Mundial 12º = 3; Sul-Americano 2º = 5; Brasileiro 4º = 0)", async () => {
    expect(await notaDe("perf_mundial")).toBe(3);
    expect(await notaDe("perf_continental")).toBe(5);
    expect(await notaDe("perf_nacional")).toBe(0);
  });

  it("o gestor edita a regra, a nota recalcula e a auditoria guarda antes e depois", async () => {
    const nova = {
      edicoes_max: 2,
      niveis: {
        ...PADRAO.niveis,
        mundial: faixas([8, 5], [15, 4], [null, 1]),
        nacional: faixas([4, 5], [null, 1]),
      },
    };
    const r = await gravar(nova);
    expect(r.status).toBe(200);
    expect(
      r.corpo.regras.find((x: { codigo: string }) => x.codigo === "PERF_RESULTADOS").valor,
    ).toEqual(nova);
    expect(await notaDe("perf_mundial")).toBe(4); // 12º: até o 15º vale 4
    expect(await notaDe("perf_nacional")).toBe(5); // 4º: até o 4º vale 5
    const aud = await p.db.query<{
      detalhes: { regras: { antes: Record<string, unknown>; depois: Record<string, unknown> } };
    }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.regras.antes.PERF_RESULTADOS).toEqual(PADRAO);
    expect(aud.rows[0]!.detalhes.regras.depois.PERF_RESULTADOS).toEqual(nova);
    expect((await gravar(PADRAO)).status).toBe(200);
    expect(await notaDe("perf_nacional")).toBe(0);
  });

  it("recusa formato inválido, com 400", async () => {
    const ruins: [string, unknown][] = [
      [
        "sem faixa final com ate nulo",
        { ...PADRAO, niveis: { ...PADRAO.niveis, mundial: faixas([3, 5], [10, 4]) } },
      ],
      [
        "ate nulo no meio",
        { ...PADRAO, niveis: { ...PADRAO.niveis, mundial: faixas([null, 5], [10, 4], [null, 2]) } },
      ],
      [
        "ate fora de ordem",
        { ...PADRAO, niveis: { ...PADRAO.niveis, mundial: faixas([10, 5], [3, 4], [null, 2]) } },
      ],
      [
        "pior colocação com nota maior",
        { ...PADRAO, niveis: { ...PADRAO.niveis, nacional: faixas([1, 3], [null, 4]) } },
      ],
      [
        "nota fora de 0 a 5",
        { ...PADRAO, niveis: { ...PADRAO.niveis, nacional: faixas([1, 6], [null, 0]) } },
      ],
      [
        "nível faltando",
        {
          edicoes_max: 4,
          niveis: { mundial: PADRAO.niveis.mundial, continental: PADRAO.niveis.continental },
        },
      ],
      [
        "nível desconhecido",
        { ...PADRAO, niveis: { ...PADRAO.niveis, estadual: faixas([null, 1]) } },
      ],
      ["edicoes_max zero", { ...PADRAO, edicoes_max: 0 }],
      ["edicoes_max fracionário", { ...PADRAO, edicoes_max: 2.5 }],
      ["campo extra", { ...PADRAO, ativa: true }],
      ["lista vazia", { ...PADRAO, niveis: { ...PADRAO.niveis, mundial: [] } }],
    ];
    for (const [nome, valor] of ruins) {
      const r = await gravar(valor);
      expect(r.status, nome).toBe(400);
      expect(r.corpo.mensagem, nome).toContain("PERF_RESULTADOS");
    }
    // Nada foi gravado.
    expect(
      (await chamar(EMAILS_DEMO.gestor, "GET", "/parametros")).corpo.regras.find(
        (x: { codigo: string }) => x.codigo === "PERF_RESULTADOS",
      ).valor,
    ).toEqual(PADRAO);
  });

  it("PERF_PONTOS deixou de existir (regra desconhecida); só o gestor edita", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      regras: { PERF_PONTOS: { ativa: false, faixas: [] } },
    });
    expect(r.status).toBe(400);
    expect(r.corpo.mensagem).toContain("Regra desconhecida");
    expect((await gravar(PADRAO, EMAILS_DEMO.treinadora)).status).toBe(403);
    expect((await gravar(PADRAO, EMAILS_DEMO.atleta)).status).toBe(403);
    expect((await gravar(PADRAO, EMAILS_DEMO.ibvar)).status).toBe(403);
    expect((await gravar(PADRAO, null)).status).toBe(401);
  });
});

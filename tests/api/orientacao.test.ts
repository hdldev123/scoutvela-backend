import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

interface IndicadorParam {
  id: string;
  orientacao: string | null;
}

describe("D10: orientação editável por indicador", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string | null,
    metodo: "GET" | "PUT",
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
  const orientacaoDe = (corpo: { pilares: { indicadores: IndicadorParam[] }[] }, id: string) =>
    corpo.pilares.flatMap((x) => x.indicadores).find((i) => i.id === id)!.orientacao;

  it("o gestor edita e remove; gestor e treinador leem; auditoria sem o texto", async () => {
    const texto = "Compare a largada com a flotilha do treino.";
    const ok = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      indicadores: [{ id: "tec_largada", orientacao: `  ${texto}  ` }],
    });
    expect(ok.status).toBe(200);
    expect(orientacaoDe(ok.corpo, "tec_largada")).toBe(texto);
    const leitura = await chamar(EMAILS_DEMO.treinadora, "GET", "/parametros");
    expect(orientacaoDe(leitura.corpo, "tec_largada")).toBe(texto);

    const aud = await p.db.query<{ detalhes: Record<string, unknown> }>(
      "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
    );
    expect(aud.rows[0]!.detalhes.orientacao).toEqual({
      indicadores: ["tec_largada"],
      comTextoAntes: { tec_largada: false },
      comTextoDepois: { tec_largada: true },
    });
    expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("flotilha");

    const limpa = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      indicadores: [{ id: "tec_largada", orientacao: null }],
    });
    expect(limpa.status).toBe(200);
    expect(orientacaoDe(limpa.corpo, "tec_largada")).toBeNull();
  });

  it("recusa texto vazio, longo demais e indicador desconhecido", async () => {
    for (const orientacao of ["   ", "x".repeat(1001)]) {
      const r = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        indicadores: [{ id: "tec_largada", orientacao }],
      });
      expect(r.status).toBe(400);
    }
    const desconhecido = await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
      indicadores: [{ id: "nao_existe", orientacao: "texto" }],
    });
    expect(desconhecido.status).toBe(400);
  });

  it("só o gestor edita; sem token, 401", async () => {
    const corpo = { indicadores: [{ id: "tec_largada", orientacao: "texto" }] };
    expect((await chamar(EMAILS_DEMO.treinadora, "PUT", "/parametros", corpo)).status).toBe(403);
    expect((await chamar(EMAILS_DEMO.atleta, "PUT", "/parametros", corpo)).status).toBe(403);
    expect((await chamar(EMAILS_DEMO.ibvar, "PUT", "/parametros", corpo)).status).toBe(403);
    expect((await chamar(null, "PUT", "/parametros", corpo)).status).toBe(401);
  });
});

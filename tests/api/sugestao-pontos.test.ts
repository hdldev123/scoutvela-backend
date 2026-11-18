import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Indicador {
  id: string;
  nota: number | null;
  sugestaoPontos: { nota: number; pontos: number } | null;
}
interface Ficha {
  score: number;
  pontosCbvela: number;
  pilares: { id: string; nota: number | null; indicadores: Indicador[] | null }[];
}

const FAIXAS = [
  { ate: 250, nota: 2 },
  { ate: 300, nota: 4 },
  { ate: 400, nota: 5 },
];
const notaEsperada = (pontos: number) => (FAIXAS.find((f) => pontos <= f.ate) ?? FAIXAS[2]!).nota;

describe("PERF_PONTOS: nota sugerida de Performance pelo Ranking CBVela", () => {
  let p: Piloto;
  let livia: string;

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    livia = await p.idDe("SC-T01");
  });
  afterAll(() => p.encerrar());

  const gravarRegra = async (valor: unknown) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { regras: { PERF_PONTOS: valor } },
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const ficha = async (email = EMAILS_DEMO.gestor) =>
    (
      await p.app.inject({ method: "GET", url: `/atletas/${livia}`, headers: await p.como(email) })
    ).json<Ficha>();
  const previa = async () =>
    (
      await p.app.inject({
        method: "POST",
        url: `/atletas/${livia}/avaliacoes/previa`,
        headers: await p.como(EMAILS_DEMO.treinadora),
        payload: { notas: [{ indicadorId: "tec_trim", valor: 2, evidencia: "Treino de trim" }] },
      })
    ).json();
  const indicadores = (f: Ficha) => f.pilares.flatMap((pl) => pl.indicadores ?? []);

  it("vem desligada pela migration e não sugere nada", async () => {
    const r = await p.app.inject({
      method: "GET",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    const regra = (r.json().regras as { codigo: string; valor: unknown }[]).find(
      (x) => x.codigo === "PERF_PONTOS",
    );
    expect(regra?.valor).toEqual({ ativa: false, faixas: [] });
    expect(indicadores(await ficha()).every((i) => i.sugestaoPontos === null)).toBe(true);
    expect((await previa()).sugestaoPontos).toBeNull();
  });

  it("valida a regra no PUT /parametros", async () => {
    expect((await gravarRegra({ ativa: true, faixas: [] })).status).toBe(400);
    expect(
      (
        await gravarRegra({
          ativa: true,
          faixas: [
            { ate: 300, nota: 4 },
            { ate: 200, nota: 5 },
          ],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await gravarRegra({
          ativa: true,
          faixas: [
            { ate: 100, nota: 4 },
            { ate: 200, nota: 3 },
          ],
        })
      ).status,
    ).toBe(400);
    expect((await gravarRegra({ ativa: true, faixas: [{ ate: 100, nota: 6 }] })).status).toBe(400);
    expect(
      (await gravarRegra({ ativa: true, faixas: [{ ate: 100, nota: 3, extra: 1 }] })).status,
    ).toBe(400);
    expect((await gravarRegra({ ativa: "sim", faixas: [] })).status).toBe(400);
    // Desligada pode guardar a tabela vazia.
    expect((await gravarRegra({ ativa: false, faixas: [] })).status).toBe(200);
  });

  it("ligada: perf_nacional da ficha traz a sugestão; o score não muda", async () => {
    const antes = await ficha();
    const r = await gravarRegra({ ativa: true, faixas: FAIXAS });
    expect(r.status).toBe(200);

    const depois = await ficha();
    expect(depois.score).toBe(antes.score);
    const perf = indicadores(depois).find((i) => i.id === "perf_nacional")!;
    expect(perf.sugestaoPontos).toEqual({
      nota: notaEsperada(depois.pontosCbvela),
      pontos: depois.pontosCbvela,
    });
    expect(perf.nota).toBe(indicadores(antes).find((i) => i.id === "perf_nacional")!.nota);
    expect(
      indicadores(depois)
        .filter((i) => i.id !== "perf_nacional")
        .every((i) => i.sugestaoPontos === null),
    ).toBe(true);
  });

  it("ligada: a prévia traz a sugestão do perf_nacional", async () => {
    const f = await ficha();
    expect((await previa()).sugestaoPontos).toEqual({
      indicadorId: "perf_nacional",
      nota: notaEsperada(f.pontosCbvela),
      pontos: f.pontosCbvela,
    });
  });

  it("a sugestão só vale quando o avaliador lança a nota", async () => {
    const f = await ficha();
    const sugerida = notaEsperada(f.pontosCbvela);
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${livia}/avaliacoes`,
      headers: await p.como(EMAILS_DEMO.treinadora),
      payload: {
        notas: [
          { indicadorId: "perf_nacional", valor: sugerida, evidencia: "Ranking CBVela 2026" },
        ],
      },
    });
    expect(r.statusCode).toBe(201);
    const depois = await ficha();
    expect(indicadores(depois).find((i) => i.id === "perf_nacional")!.nota).toBe(sugerida);
  });
});

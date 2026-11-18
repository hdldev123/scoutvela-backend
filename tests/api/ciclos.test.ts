import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Ciclo {
  id: string;
  nome: string;
  inicio: string;
  prazo: string;
  status: string;
  atletasComScore: number;
  fechadoEm: string | null;
}

describe("ciclos de avaliação", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
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
    return { status: r.statusCode, corpo: r.json() };
  };
  const listar = async () =>
    (await chamar(EMAILS_DEMO.gestor, "GET", "/ciclos")).corpo.itens as Ciclo[];
  const contarAud = async (acao: string) =>
    Number(
      (
        await p.db.query<{ n: string }>(
          `select count(*)::text as n from auditoria where acao = $1`,
          [acao],
        )
      ).rows[0]!.n,
    );

  it("acesso: sem token 401; treinador, atleta e IBVAR 403", async () => {
    expect((await chamar(null, "GET", "/ciclos")).status).toBe(401);
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await chamar(email, "GET", "/ciclos")).status).toBe(403);
      expect(
        (
          await chamar(email, "POST", "/ciclos", {
            nome: "Teste",
            inicio: "2026-12-01",
            prazo: "2026-12-31",
          })
        ).status,
      ).toBe(403);
    }
  });

  it("lista do mais recente ao mais antigo, com contagem e fechamento", async () => {
    const itens = await listar();
    expect(itens.map((c) => c.nome)).toEqual([
      "Novembro de 2026",
      "Outubro de 2026",
      "Setembro de 2026",
    ]);
    expect(itens[0]).toMatchObject({
      status: "aberto",
      prazo: "2026-11-30",
      atletasComScore: 0,
      fechadoEm: null,
    });
    expect(itens[1]!.status).toBe("fechado");
    expect(itens[1]!.atletasComScore).toBeGreaterThan(0);
    expect(itens[1]!.fechadoEm).not.toBeNull();
  });

  it("não abre segundo ciclo enquanto há um aberto (409)", async () => {
    const r = await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", {
      nome: "Dezembro de 2026",
      inicio: "2026-12-01",
      prazo: "2026-12-31",
    });
    expect(r.status).toBe(409);
    expect(r.corpo.erro).toBe("requisicao_invalida");
  });

  it("prorroga o prazo do ciclo aberto, com auditoria sem valores", async () => {
    const aberto = (await listar())[0]!;
    const r = await chamar(EMAILS_DEMO.gestor, "PUT", `/ciclos/${aberto.id}`, {
      prazo: "2026-12-05",
    });
    expect(r.status).toBe(200);
    expect(r.corpo.prazo).toBe("2026-12-05");
    const aud = await p.db.query<{ detalhes: unknown }>(
      `select detalhes from auditoria where acao = 'ajustar_prazo_ciclo'`,
    );
    expect(aud.rows).toHaveLength(1);
    expect(JSON.stringify(aud.rows[0]!.detalhes)).not.toContain("2026-12-05");
  });

  it("valida prazo, corpo e id", async () => {
    const aberto = (await listar())[0]!;
    expect(
      (await chamar(EMAILS_DEMO.gestor, "PUT", `/ciclos/${aberto.id}`, { prazo: "2026-10-31" }))
        .status,
    ).toBe(400);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "PUT", `/ciclos/${aberto.id}`, { prazo: "amanhã" })).status,
    ).toBe(400);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", `/ciclos/${crypto.randomUUID()}`, {
          prazo: "2026-12-05",
        })
      ).status,
    ).toBe(404);
    const ruim = await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", {
      nome: "ab",
      inicio: "2026-12-01",
      prazo: "2026-12-31",
    });
    expect(ruim.status).toBe(400);
    expect(ruim.corpo).toEqual({ erro: "requisicao_invalida", mensagem: "Requisição inválida." });
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", {
          nome: "Dezembro",
          inicio: "2026-12-10",
          prazo: "2026-12-01",
        })
      ).status,
    ).toBe(400);
  });

  it("fecha o ciclo: congela score e faixa dos atletas com termo e entra no histórico da ficha", async () => {
    const aberto = (await listar())[0]!;
    const termo = Number(
      (
        await p.db.query<{ n: string }>(
          `select count(*)::text as n from atletas a where a.ativo and exists (select 1 from consentimento_atual c
             where c.atleta_id = a.id and c.tipo = 'termo_piloto' and c.concedido)`,
        )
      ).rows[0]!.n,
    );
    const r = await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${aberto.id}/fechar`);
    expect(r.status).toBe(200);
    expect(r.corpo.atletas).toBe(termo);
    expect(r.corpo.ciclo).toMatchObject({
      status: "fechado",
      atletasComScore: termo,
      fechadoEm: AGORA().toISOString(),
    });

    const id = await p.idDe("SC-T01");
    const ficha = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${id}`);
    const hist = ficha.corpo.historicoScore as { ciclo: string; score: number }[];
    expect(hist.at(-1)!.ciclo).toBe("Novembro de 2026");
    expect(hist.at(-1)!.score).toBeCloseTo(ficha.corpo.score, 2);
    expect(await contarAud("fechar_ciclo")).toBe(1);
  });

  it("não fecha duas vezes nem altera ciclo fechado (409)", async () => {
    const fechado = (await listar())[0]!;
    expect(fechado.status).toBe("fechado");
    expect((await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${fechado.id}/fechar`)).status).toBe(
      409,
    );
    expect(
      (await chamar(EMAILS_DEMO.gestor, "PUT", `/ciclos/${fechado.id}`, { prazo: "2026-12-31" }))
        .status,
    ).toBe(409);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${crypto.randomUUID()}/fechar`)).status,
    ).toBe(404);
  });

  it("abre novo ciclo depois do fechamento; nome repetido dá 409", async () => {
    const corpo = { nome: "Dezembro de 2026", inicio: "2026-12-01", prazo: "2026-12-31" };
    const r = await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", corpo);
    expect(r.status).toBe(201);
    expect(r.corpo).toMatchObject({
      ...corpo,
      status: "aberto",
      atletasComScore: 0,
      fechadoEm: null,
    });
    await chamar(EMAILS_DEMO.gestor, "POST", `/ciclos/${r.corpo.id}/fechar`);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "POST", "/ciclos", { ...corpo, nome: "dezembro de 2026" }))
        .status,
    ).toBe(409);
    expect(await contarAud("abrir_ciclo")).toBe(1);
  });
});

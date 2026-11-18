import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria } from "../../src/email/index.js";
import { executarLembretes } from "../../src/jobs/lembretes.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

// Ciclo aberto do seed: Novembro de 2026, prazo 30/11/2026.
const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Pendencias {
  treinadores: {
    id: string;
    nome: string;
    atletasPendentes: { id: string; nome: string; faltam: number }[];
  }[];
  atletas: { id: string; nome: string; perguntasSemResposta: number }[];
  totais: { treinadoresComPendencia: number; atletasComPendencia: number; diasParaPrazo: number };
}

describe("GET /ciclos/:id/pendencias", () => {
  let p: Piloto;
  let aberto: string;
  let fechado: string;

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    const ciclos = await p.db.query<{ id: string; status: string }>(
      "select id, status from ciclos_avaliacao order by inicio desc",
    );
    aberto = ciclos.rows.find((c) => c.status === "aberto")!.id;
    fechado = ciclos.rows.find((c) => c.status === "fechado")!.id;
  });
  afterAll(() => p.encerrar());

  const pendencias = async (email: string | null, cicloId = aberto) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/ciclos/${cicloId}/pendencias`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<Pendencias>(), texto: r.body };
  };

  it("acesso: sem token 401; treinador, atleta e IBVAR 403", async () => {
    expect((await pendencias(null)).status).toBe(401);
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await pendencias(email)).status).toBe(403);
    }
  });

  it("ciclo inexistente 404; ciclo fechado 409", async () => {
    expect((await pendencias(EMAILS_DEMO.gestor, crypto.randomUUID())).status).toBe(404);
    const r = await pendencias(EMAILS_DEMO.gestor, fechado);
    expect(r.status).toBe(409);
    expect(r.corpo).toMatchObject({ erro: "requisicao_invalida" });
  });

  it("traz treinadores, atletas, totais e dias até o prazo, sem e-mail", async () => {
    const { status, corpo, texto } = await pendencias(EMAILS_DEMO.gestor);
    expect(status).toBe(200);
    expect(corpo.totais).toEqual({
      treinadoresComPendencia: corpo.treinadores.length,
      atletasComPendencia: corpo.atletas.length,
      diasParaPrazo: 24,
    });
    expect(corpo.treinadores.length).toBeGreaterThan(0);
    for (const t of corpo.treinadores) {
      expect(t.atletasPendentes.length).toBeGreaterThan(0);
      expect(t.atletasPendentes.every((a) => a.faltam > 0)).toBe(true);
    }
    expect(corpo.atletas.every((a) => a.perguntasSemResposta > 0)).toBe(true);
    expect(texto).not.toMatch(/@/);
  });

  it("só atletas ativos com termo aceito", async () => {
    const antes = (await pendencias(EMAILS_DEMO.gestor)).corpo;
    const ana = antes.treinadores.find((t) => t.nome === "Ana Ribeiro")!;
    const alvo = ana.atletasPendentes[0]!;

    await p.db.query("update atletas set ativo = false where id = $1", [alvo.id]);
    const classe = (
      await p.db.query<{ classe_id: string }>("select classe_id from atletas limit 1")
    ).rows[0]!.classe_id;
    await p.db.query(
      `insert into atletas (velaid_codigo, nome, genero, data_nascimento, classe_id, treinador_id)
       values ('MG-T98', 'Sem Termo', 'F', '2000-01-01', $1, $2)`,
      [classe, ana.id],
    );

    const depois = (await pendencias(EMAILS_DEMO.gestor)).corpo;
    const ids = depois.treinadores.flatMap((t) => t.atletasPendentes.map((a) => a.id));
    expect(ids).not.toContain(alvo.id);
    expect(depois.atletas.map((a) => a.id)).not.toContain(alvo.id);
    expect(JSON.stringify(depois)).not.toContain("Sem Termo");

    await p.db.query("update atletas set ativo = true where id = $1", [alvo.id]);
  });

  it("atleta sai da lista do treinador quando todos os indicadores T têm nota no ciclo", async () => {
    const antes = (await pendencias(EMAILS_DEMO.gestor)).corpo;
    const ana = antes.treinadores.find((t) => t.nome === "Ana Ribeiro")!;
    const alvo = ana.atletasPendentes[0]!;
    const faltando = await p.db.query<{ id: string }>(
      `select i.id from indicadores i
        where i.tipo = 'T' and not i.calculado
          and not exists (select 1 from avaliacoes n where n.atleta_id = $1 and n.indicador_id = i.id
                            and n.ciclo_id = $2 and n.origem <> 'resposta_sugerida')`,
      [alvo.id, aberto],
    );
    expect(faltando.rows).toHaveLength(alvo.faltam);

    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${alvo.id}/avaliacoes`,
      headers: await p.como(EMAILS_DEMO.treinadora),
      payload: {
        notas: faltando.rows.map((l) => ({
          indicadorId: l.id,
          valor: 3,
          evidencia: "Avaliação do ciclo",
        })),
      },
    });
    expect(r.statusCode).toBe(201);

    const depois = (await pendencias(EMAILS_DEMO.gestor)).corpo;
    const ids = depois.treinadores.flatMap((t) => t.atletasPendentes.map((a) => a.id));
    expect(ids).not.toContain(alvo.id);
  });

  it("o job de lembretes usa a mesma regra", async () => {
    const { corpo } = await pendencias(EMAILS_DEMO.gestor);
    const comConta = await p.db.query<{ atleta_id: string }>(
      "select atleta_id from usuarios where papel = 'atleta' and ativo",
    );
    const atletasComConta = corpo.atletas.filter((a) =>
      comConta.rows.some((u) => u.atleta_id === a.id),
    ).length;

    const email = criarProvedorEmailMemoria();
    const r = await executarLembretes({
      db: p.db,
      email,
      agora: new Date("2026-11-23T12:00:00-03:00"),
      frontUrl: "https://app.scoutvela.dev",
    });
    expect(r.treinadores).toBe(corpo.totais.treinadoresComPendencia);
    expect(r.atletas).toBe(atletasComConta);
  });
});

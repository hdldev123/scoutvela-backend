import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface Item {
  id: string;
  em: string;
  usuario: { id: string; nome: string; papel: string } | null;
  acao: string;
  entidade: string;
  entidadeId: string | null;
}

describe("GET /auditoria", () => {
  let p: Piloto;
  let gestorId: string;
  let atletaId: string;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    gestorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    atletaId = await p.idDe("SP-T07");
    const linha = (
      acao: string,
      entidade: string,
      entidadeId: string | null,
      usuario: string | null,
      em: string,
    ) =>
      p.db.query(
        "insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em) values ($1, $2, $3, $4, '{}'::jsonb, $5)",
        [usuario, acao, entidade, entidadeId, em],
      );
    await linha("lancar_avaliacao", "avaliacoes", atletaId, gestorId, "2026-10-01T12:00:00-03:00");
    await linha("lancar_avaliacao", "avaliacoes", atletaId, gestorId, "2026-10-02T23:30:00-03:00");
    await linha(
      "alterar_consentimento",
      "consentimentos",
      atletaId,
      null,
      "2026-10-03T00:30:00-03:00",
    );
    await linha("atualizar_parametros", "parametros", null, gestorId, "2026-10-05T12:00:00-03:00");
    await linha("lancar_avaliacao", "avaliacoes", "outro", gestorId, "2026-10-06T12:00:00-03:00");
  });
  afterAll(() => p.encerrar());

  const buscar = async (query = "", email: string = EMAILS_DEMO.gestor) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/auditoria${query}`,
      headers: await p.como(email),
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("sem token 401; treinador, atleta e ibvar 403", async () => {
    expect((await p.app.inject({ method: "GET", url: "/auditoria" })).statusCode).toBe(401);
    for (const e of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar])
      expect((await buscar("", e)).status).toBe(403);
  });

  it("lista do mais novo para o mais antigo, com usuário embutido", async () => {
    const { status, corpo } = await buscar("?limite=200");
    expect(status).toBe(200);
    const ids = corpo.itens.map((i: Item) => BigInt(i.id));
    expect(ids).toEqual([...ids].sort((a, b) => (a < b ? 1 : -1)));
    expect(corpo.proximo).toBeNull();
    const param = corpo.itens.find((i: Item) => i.acao === "atualizar_parametros");
    expect(param).toMatchObject({
      entidade: "parametros",
      entidadeId: null,
      usuario: { id: gestorId, papel: "gestor" },
    });
    expect(param.em).toBe("2026-10-05T15:00:00.000Z");
    expect(corpo.itens.find((i: Item) => i.acao === "alterar_consentimento").usuario).toBeNull();
  });

  it("filtros: entidade, acao, usuarioId, atletaId e combinados", async () => {
    const acoes = async (q: string) =>
      (await buscar(q)).corpo.itens.map((i: Item) => i.acao) as string[];
    expect((await acoes("?entidade=parametros")).every((a) => a === "atualizar_parametros")).toBe(
      true,
    );
    expect(await acoes("?acao=alterar_consentimento")).toEqual(["alterar_consentimento"]);
    expect((await buscar(`?atletaId=${atletaId}`)).corpo.itens).toHaveLength(3);
    expect((await buscar(`?atletaId=${atletaId}&acao=lancar_avaliacao`)).corpo.itens).toHaveLength(
      2,
    );
    const doGestor = (await buscar(`?usuarioId=${gestorId}&limite=200`)).corpo.itens as Item[];
    expect(doGestor.length).toBe(4);
    expect(doGestor.every((i) => i.usuario?.id === gestorId)).toBe(true);
    expect((await buscar("?entidade=nada")).corpo.itens).toEqual([]);
  });

  it("filtro por data usa o dia de Brasília", async () => {
    const dia2 = (await buscar(`?atletaId=${atletaId}&desde=2026-10-02&ate=2026-10-02`)).corpo
      .itens as Item[];
    expect(dia2.map((i) => i.acao)).toEqual(["lancar_avaliacao"]);
    expect(dia2[0]!.em).toBe("2026-10-03T02:30:00.000Z");
    const dia3 = (await buscar(`?atletaId=${atletaId}&desde=2026-10-03&ate=2026-10-03`)).corpo
      .itens as Item[];
    expect(dia3.map((i) => i.acao)).toEqual(["alterar_consentimento"]);
    expect(
      (await buscar("?desde=2026-10-04&ate=2026-10-05&entidade=parametros")).corpo.itens,
    ).toHaveLength(1);
    expect((await buscar("?desde=2026-10-07&entidade=parametros")).corpo.itens).toEqual([]);
  });

  it("paginação por cursor cobre tudo sem repetir", async () => {
    const todos = (await buscar("?limite=200")).corpo.itens as Item[];
    const vistos: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 100; i++) {
      const { corpo } = await buscar(`?limite=2${cursor ? `&antesDe=${cursor}` : ""}`);
      vistos.push(...corpo.itens.map((x: Item) => x.id));
      if (!corpo.proximo) break;
      expect(corpo.itens).toHaveLength(2);
      cursor = corpo.proximo;
    }
    expect(vistos).toEqual(todos.map((t) => t.id));
  });

  it("validações -> 400", async () => {
    for (const q of [
      "?limite=0",
      "?limite=201",
      "?limite=abc",
      "?desde=2026-13-01",
      "?ate=01/10/2026",
      "?usuarioId=x",
      "?antesDe=abc",
    ]) {
      expect((await buscar(q)).status).toBe(400);
    }
  });

  it("escrever parâmetros aparece na trilha com antes e depois", async () => {
    const put = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { regras: { RANKING_CBVELA: { janela_semanas: 40 } } },
    });
    expect(put.statusCode).toBe(200);
    const { corpo } = await buscar("?acao=atualizar_parametros&limite=1");
    expect(corpo.itens[0].detalhes.regras).toEqual({
      antes: { RANKING_CBVELA: { janela_semanas: 52 } },
      depois: { RANKING_CBVELA: { janela_semanas: 40 } },
    });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

interface AtletaGestao {
  id: string;
  nome: string;
  velaid: string;
  classe: { id: string; nome: string };
  treinador: { id: string; nome: string } | null;
  numeroVela: string | null;
  ativo: boolean;
  termoAceito: boolean;
  contaVinculada: boolean;
}

describe("GET /atletas (lista de gestão)", () => {
  let p: Piloto;
  let inativoId: string;
  let semTermoId: string;

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    // Um atleta inativo (com termo) e um ativo que ainda não aceitou o termo.
    inativoId = await p.idDe("RS-T14");
    await p.db.query("update atletas set ativo = false where id = $1", [inativoId]);
    const classe = (
      await p.db.query<{ classe_id: string }>("select classe_id from atletas limit 1")
    ).rows[0]!.classe_id;
    semTermoId = (
      await p.db.query<{ id: string }>(
        `insert into atletas (velaid_codigo, nome, genero, data_nascimento, classe_id)
         values ('MG-T99', 'Zeca Sem Termo', 'M', '2000-05-05', $1) returning id`,
        [classe],
      )
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const listar = async (email: string | null, query = "") => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas${query}`,
      headers: email ? await p.como(email) : {},
    });
    return { status: r.statusCode, corpo: r.json<AtletaGestao[]>(), texto: r.body };
  };

  it("sem token 401; treinador, atleta e IBVAR 403", async () => {
    expect((await listar(null)).status).toBe(401);
    for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
      expect((await listar(email)).status).toBe(403);
    }
  });

  it("inclui inativos e quem não aceitou o termo, sem e-mail", async () => {
    const { status, corpo, texto } = await listar(EMAILS_DEMO.gestor);
    expect(status).toBe(200);
    expect(corpo).toHaveLength(15);
    expect(corpo.find((a) => a.id === inativoId)).toMatchObject({
      ativo: false,
      termoAceito: true,
    });
    expect(corpo.find((a) => a.id === semTermoId)).toMatchObject({
      ativo: true,
      termoAceito: false,
      treinador: null,
      contaVinculada: false,
    });
    expect(texto).not.toMatch(/@/);
    expect(Object.keys(corpo[0]!).sort()).toEqual(
      [
        "ativo",
        "classe",
        "contaVinculada",
        "id",
        "nome",
        "numeroVela",
        "termoAceito",
        "treinador",
        "velaid",
      ].sort(),
    );
  });

  it("conta vinculada e treinador vêm do cadastro", async () => {
    const { corpo } = await listar(EMAILS_DEMO.gestor);
    const helena = corpo.find((a) => a.velaid === "SP-T07")!;
    expect(helena).toMatchObject({ contaVinculada: true, treinador: { nome: "Ana Ribeiro" } });
    expect(corpo.find((a) => a.velaid === "SC-T01")!.contaVinculada).toBe(false);
  });

  it("filtros: ativo, termoAceito, classe, treinador e busca", async () => {
    const g = EMAILS_DEMO.gestor;
    expect((await listar(g, "?ativo=false")).corpo.map((a) => a.id)).toEqual([inativoId]);
    expect((await listar(g, "?termoAceito=false")).corpo.map((a) => a.id)).toEqual([semTermoId]);
    expect((await listar(g, "?ativo=true&termoAceito=true")).corpo).toHaveLength(13);

    const todos = (await listar(g)).corpo;
    const ana = todos.find((a) => a.velaid === "SC-T01")!.treinador!.id;
    const daAna = (await listar(g, `?treinadorId=${ana}`)).corpo;
    expect(daAna.length).toBeGreaterThan(0);
    expect(daAna.every((a) => a.treinador?.id === ana)).toBe(true);

    const classe = todos[0]!.classe.id;
    const daClasse = (await listar(g, `?classeId=${encodeURIComponent(classe)}`)).corpo;
    expect(daClasse.length).toBeGreaterThan(0);
    expect(daClasse.every((a) => a.classe.id === classe)).toBe(true);

    expect((await listar(g, "?busca=helena")).corpo.map((a) => a.velaid)).toEqual(["SP-T07"]);
    expect((await listar(g, "?busca=sp-t0")).corpo.map((a) => a.velaid).sort()).toEqual([
      "SP-T07",
      "SP-T08",
    ]);
    // Curinga do LIKE é tratado como texto.
    expect((await listar(g, "?busca=%25")).corpo).toEqual([]);
  });

  it("valida a consulta", async () => {
    expect((await listar(EMAILS_DEMO.gestor, "?ativo=sim")).status).toBe(400);
    expect((await listar(EMAILS_DEMO.gestor, "?treinadorId=nao-e-uuid")).status).toBe(400);
  });

  it("não conflita com GET /atletas/:id nem com GET /atletas/pendentes", async () => {
    const h = await p.como(EMAILS_DEMO.gestor);
    const id = await p.idDe("SC-T01");
    const ficha = await p.app.inject({ method: "GET", url: `/atletas/${id}`, headers: h });
    expect(ficha.statusCode).toBe(200);
    expect(ficha.json().atleta.velaid).toBe("SC-T01");
    const pend = await p.app.inject({ method: "GET", url: "/atletas/pendentes", headers: h });
    expect(pend.statusCode).toBe(200);
    expect(pend.json<{ id: string }[]>().map((a) => a.id)).toContain(semTermoId);
  });
});

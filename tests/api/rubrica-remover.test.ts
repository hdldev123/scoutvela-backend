import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

type Rubrica = { pilarId: string | null; nota: number; descricao: string };

describe("PUT /parametros: rubricasRemover", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto();
  });
  afterAll(() => p.encerrar());

  const gravar = async (corpo: unknown, email: string = EMAILS_DEMO.gestor) => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(email),
      payload: corpo as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const rubricas = async (): Promise<Rubrica[]> =>
    (
      await p.app.inject({
        method: "GET",
        url: "/parametros",
        headers: await p.como(EMAILS_DEMO.gestor),
      })
    ).json().rubricas;

  it("só o gestor altera", async () => {
    expect((await gravar({ rubricasRemover: ["exp"] }, EMAILS_DEMO.treinadora)).status).toBe(403);
  });

  it("escala geral não pode ser removida (null, vazio) e pilares inválidos dão 400", async () => {
    const antes = await rubricas();
    for (const rubricasRemover of [[null], [""], ["nao-existe"], ["exp", "exp"], []]) {
      const r = await gravar({ rubricasRemover });
      expect(r.status, JSON.stringify(rubricasRemover)).toBe(400);
    }
    const nulo = await gravar({ rubricasRemover: [null] });
    expect(nulo.corpo.mensagem ?? JSON.stringify(nulo.corpo)).toContain("escala geral");
    // Pilar sem rubrica própria.
    const semRubrica = await gravar({ rubricasRemover: ["perf"] });
    expect(semRubrica.status).toBe(400);
    expect(await rubricas()).toEqual(antes);
  });

  it("conflito com a edição do mesmo pilar: 400 e nada muda", async () => {
    const antes = await rubricas();
    const r = await gravar({
      rubricas: [{ pilarId: "exp", nota: 3, descricao: "Descrição válida" }],
      rubricasRemover: ["exp"],
    });
    expect(r.status).toBe(400);
    expect(await rubricas()).toEqual(antes);
  });

  it("remove as rubricas do pilar e audita antes e depois", async () => {
    const antes = await rubricas();
    const doPilar = antes.filter((r) => r.pilarId === "exp");
    expect(doPilar.length).toBeGreaterThan(0);

    const r = await gravar({ rubricasRemover: ["exp"] });
    expect(r.status).toBe(200);
    expect(r.corpo.rubricas.some((x: Rubrica) => x.pilarId === "exp")).toBe(false);
    expect(r.corpo.rubricas.filter((x: Rubrica) => x.pilarId === null)).toEqual(
      antes.filter((x) => x.pilarId === null),
    );

    const aud = (
      await p.db.query<{ detalhes: Record<string, unknown> }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      )
    ).rows[0]!.detalhes;
    expect(aud.rubricasRemovidas).toEqual({ antes: doPilar, depois: [] });
  });

  it("remover e editar pilares diferentes na mesma requisição vale; pilar já sem rubrica dá 400", async () => {
    const r = await gravar({
      rubricas: [{ pilarId: "perf", nota: 5, descricao: "Pódio em Mundial da classe" }],
      rubricasRemover: ["exp"],
    });
    expect(r.status).toBe(400); // exp já foi removida no teste anterior
    const ok = await gravar({
      rubricas: [{ pilarId: "perf", nota: 5, descricao: "Pódio em Mundial da classe" }],
    });
    expect(ok.status).toBe(200);
    const junto = await gravar({
      rubricas: [{ pilarId: "tec", nota: 4, descricao: "Técnica consistente" }],
      rubricasRemover: ["perf"],
    });
    expect(junto.status).toBe(200);
    const atual = await rubricas();
    expect(atual.some((x) => x.pilarId === "perf")).toBe(false);
    expect(atual.some((x) => x.pilarId === "tec")).toBe(true);
  });
});

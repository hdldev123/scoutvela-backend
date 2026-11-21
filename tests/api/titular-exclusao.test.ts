import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

describe("PUT /pedidos-titular/:id: pedido de exclusão", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(() => new Date("2026-11-06T12:00:00-03:00"));
  });
  afterAll(() => p.encerrar());

  const pedido = async (velaid: string, tipo: string) => {
    const atleta = await p.idDe(velaid);
    const gestor = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    const r = await p.db.query<{ id: string }>(
      `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
       values ($1, $2, 'Quero que apaguem meus dados.', $3) returning id::text as id`,
      [atleta, tipo, gestor],
    );
    return { id: r.rows[0]!.id, atleta };
  };
  const responder = async (id: string, corpo: object) => {
    const r = await p.app.inject({
      method: "PUT",
      url: `/pedidos-titular/${id}`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: corpo,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const estado = async (id: string) =>
    (await p.db.query<{ status: string }>("select status from pedidos_titular where id = $1", [id]))
      .rows[0]!.status;

  it("responder um pedido de exclusão pela rota genérica: 409 apontando para a anonimização", async () => {
    const { id } = await pedido("SP-T07", "exclusao");
    const r = await responder(id, { resposta: "Feito." });
    expect(r.status).toBe(409);
    expect(r.corpo.mensagem).toContain("POST /atletas/{id}/anonimizar");
    expect(await estado(id)).toBe("aberto");
  });

  it("recusa formal: precisa de 20 caracteres, fecha o pedido sem anonimizar e audita recusar_exclusao", async () => {
    const { id, atleta } = await pedido("SP-T08", "exclusao");
    const curta = await responder(id, { resposta: "Não é possível.", recusar: true });
    expect(curta.status).toBe(400);
    expect(await estado(id)).toBe("aberto");

    const ok = await responder(id, {
      resposta: "Mantemos os dados por obrigação regulatória da CBVela (art. 16, I).",
      recusar: true,
    });
    expect(ok.status).toBe(200);
    expect(ok.corpo.status).toBe("respondido");
    expect(await estado(id)).toBe("respondido");
    const a = (
      await p.db.query<{ ativo: boolean; anonimizado_em: Date | null }>(
        "select ativo, anonimizado_em from atletas where id = $1",
        [atleta],
      )
    ).rows[0]!;
    expect(a.anonimizado_em).toBeNull();
    const aud = await p.db.query<{ acao: string }>(
      "select acao from auditoria where entidade = 'pedidos_titular' and entidade_id = $1",
      [id],
    );
    expect(aud.rows.map((l) => l.acao)).toEqual(["recusar_exclusao"]);
  });

  it("recusar em pedido que não é de exclusão: 400; os demais tipos seguem como antes", async () => {
    const acesso = await pedido("CE-T10", "acesso");
    expect(
      (await responder(acesso.id, { resposta: "Segue o acesso.", recusar: true })).status,
    ).toBe(400);
    expect((await responder(acesso.id, { resposta: "Segue o acesso." })).status).toBe(200);
  });
});

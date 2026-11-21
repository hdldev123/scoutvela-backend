import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarAdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("GET /pedidos-titular: estado da anonimização", () => {
  let p: Piloto;
  const admin = criarAdminAuthFalso();
  beforeAll(async () => {
    p = await criarPiloto(AGORA, { adminAuth: admin });
  });
  afterAll(() => p.encerrar());

  const gestorId = async () =>
    (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
  const novoPedido = async (atleta: string, tipo: "exclusao" | "acesso") =>
    (
      await p.db.query<{ id: string }>(
        `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
         values ($1, $2, 'Descrição do pedido de teste.', $3) returning id::text as id`,
        [atleta, tipo, await gestorId()],
      )
    ).rows[0]!.id;
  const anonimizar = async (atleta: string, pedido: string) => {
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${atleta}/anonimizar`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { pedidoTitularId: pedido, confirmacao: "ANONIMIZAR" },
    });
    return r.statusCode;
  };
  const listar = async () => {
    const r = await p.app.inject({
      method: "GET",
      url: "/pedidos-titular",
      headers: await p.como(EMAILS_DEMO.gestor),
    });
    expect(r.statusCode).toBe(200);
    return r.json() as {
      id: string;
      anonimizacao: { em: string; pendencias: { arquivos: number; conta: boolean } } | null;
    }[];
  };

  it("nulo antes e nos pedidos que não anonimizaram; preenchido, com pendências, no que anonimizou", async () => {
    const id = await p.idDe("CE-T09");
    const outro = await p.idDe("SC-T01");
    const pedido = await novoPedido(id, "exclusao");
    const acesso = await novoPedido(id, "acesso");
    const alheio = await novoPedido(outro, "exclusao");

    let lista = await listar();
    expect(lista.find((x) => x.id === pedido)!.anonimizacao).toBeNull();

    // Uma evidência cujo arquivo não consegue sair do Storage vira pendência registrada.
    const enviado = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/evidencias`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: {
        nomeArquivo: "doc.pdf",
        tipoMime: "application/pdf",
        conteudoBase64: pdf().toString("base64"),
      },
    });
    expect(enviado.statusCode).toBe(201);
    p.armazenamento.falharRemocao = true;
    expect(await anonimizar(id, pedido)).toBe(200);
    p.armazenamento.falharRemocao = false;

    lista = await listar();
    const doPedido = lista.find((x) => x.id === pedido)!;
    expect(doPedido.anonimizacao).toMatchObject({
      em: AGORA().toISOString(),
      pendencias: { arquivos: 1, conta: false },
    });
    expect(lista.find((x) => x.id === acesso)!.anonimizacao).toBeNull();
    expect(lista.find((x) => x.id === alheio)!.anonimizacao).toBeNull();

    // Retomada com o Storage de volta: a pendência some.
    expect(await anonimizar(id, pedido)).toBe(200);
    lista = await listar();
    expect(lista.find((x) => x.id === pedido)!.anonimizacao).toMatchObject({
      pendencias: { arquivos: 0, conta: false },
    });
  });

  it("conta de login que não saiu aparece como pendência", async () => {
    const id = await p.idDe("SP-T07");
    await p.db.query(
      `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
       values ($1, 'sp.t07@teste.dev', 'Helena Teste', 'atleta', $2)`,
      [crypto.randomUUID(), id],
    );
    const pedido = await novoPedido(id, "exclusao");
    admin.falharRemocao = true;
    expect(await anonimizar(id, pedido)).toBe(200);
    admin.falharRemocao = false;
    const item = (await listar()).find((x) => x.id === pedido)!;
    expect(item.anonimizacao!.pendencias).toEqual({ arquivos: 0, conta: true });

    expect(await anonimizar(id, pedido)).toBe(200);
    const depois = (await listar()).find((x) => x.id === pedido)!;
    expect(depois.anonimizacao!.pendencias).toEqual({ arquivos: 0, conta: false });
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarAdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("evidência removida", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA, { adminAuth: criarAdminAuthFalso() });
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    metodo: "GET" | "POST" | "DELETE",
    url: string,
    corpo?: unknown,
    email: string = EMAILS_DEMO.gestor,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: await p.como(email),
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const enviar = async (id: string) => {
    const r = await chamar("POST", `/atletas/${id}/evidencias`, {
      nomeArquivo: "laudo.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
    });
    expect(r.status).toBe(201);
    return r.corpo.id as string;
  };

  it("anexo removido de atleta ainda visível: lista com removidoEm e o link devolve 410 sem chamar o Storage", async () => {
    const id = await p.idDe("RJ-T05");
    const anexo = await enviar(id);
    const lista = await chamar("GET", `/atletas/${id}/evidencias`);
    expect(lista.corpo.anexos[0].removidoEm).toBeNull();

    // Fluxo real: o anexo ainda não ligado a nenhuma nota é removido pela API.
    expect((await chamar("DELETE", `/evidencias/${anexo}`)).status).toBe(204);
    const depois = await chamar("GET", `/atletas/${id}/evidencias`);
    expect(depois.corpo.anexos[0]).toMatchObject({ nomeArquivo: "removido" });
    expect(depois.corpo.anexos[0].removidoEm).toEqual(expect.any(String));

    // Se o Storage fosse chamado, o fake responderia 503.
    p.armazenamento.falhar = true;
    const link = await chamar("GET", `/evidencias/${anexo}/link`);
    p.armazenamento.falhar = false;
    expect(link.status).toBe(410);
    expect(link.corpo.erro).toBe("evidencia_removida");
  });

  it("atleta anonimizado: o atleta fecha antes, então lista e link dão 404 (e não 410)", async () => {
    const id = await p.idDe("CE-T09");
    const anexo = await enviar(id);
    const pedido = (
      await p.db.query<{ id: string }>(
        `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
         values ($1, 'exclusao', 'Quero que apaguem meus dados.', (select id from usuarios where email = $2))
         returning id::text as id`,
        [id, EMAILS_DEMO.gestor],
      )
    ).rows[0]!.id;
    const anon = await chamar("POST", `/atletas/${id}/anonimizar`, {
      pedidoTitularId: pedido,
      confirmacao: "ANONIMIZAR",
    });
    expect(anon.status).toBe(200);
    // O registro do anexo foi marcado como removido pela anonimização...
    const linha = await p.db.query<{ removido_em: Date | null }>(
      "select removido_em from evidencias_anexos where id = $1",
      [anexo],
    );
    expect(linha.rows[0]!.removido_em).not.toBeNull();
    // ...mas pela API o atleta anonimizado já não existe para o acesso: 404 em tudo.
    expect((await chamar("GET", `/atletas/${id}/evidencias`)).status).toBe(404);
    expect((await chamar("GET", `/evidencias/${anexo}/link`)).status).toBe(404);
    expect((await chamar("DELETE", `/evidencias/${anexo}`)).status).toBe(404);
  });
});

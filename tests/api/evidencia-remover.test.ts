import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limparAnexosNaoVinculados } from "../../src/jobs/limpar-anexos.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("DELETE /evidencias/:id e limpeza de anexos", () => {
  let p: Piloto;
  let idT: string; // SC-T01, atleta da treinadora Ana
  let indicador: string;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    idT = await p.idDe("SC-T01");
    indicador = (
      await p.db.query<{ id: string }>(
        `select i.id from indicadores i join pilares pl on pl.id = i.pilar_id
          where i.tipo = 'T' and not i.calculado and not pl.sensivel order by pl.ordem, i.ordem limit 1`,
      )
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    metodo: "GET" | "POST" | "DELETE",
    url: string,
    corpo?: object,
  ) => {
    const r = await p.app.inject({
      method: metodo,
      url,
      headers: await p.como(email),
      ...(corpo ? { payload: corpo } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const enviar = async (email: string, id = idT) => {
    const r = await chamar(email, "POST", `/atletas/${id}/evidencias`, {
      nomeArquivo: "doc.pdf",
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
    });
    expect(r.status).toBe(201);
    return r.corpo.id as string;
  };
  const caminhoDe = async (anexo: string) =>
    (
      await p.db.query<{ caminho: string }>("select caminho from evidencias_anexos where id = $1", [
        anexo,
      ])
    ).rows[0]!.caminho;
  const removidoEm = async (id: string) =>
    (
      await p.db.query<{ removido_em: Date | null }>(
        "select removido_em from evidencias_anexos where id = $1",
        [id],
      )
    ).rows[0]!.removido_em;

  it("remove anexo não vinculado: arquivo sai do Storage, registro fica marcado e a auditoria leva só ids", async () => {
    const anexo = await enviar(EMAILS_DEMO.treinadora);
    const caminho = await caminhoDe(anexo);
    expect(p.armazenamento.arquivos.has(caminho)).toBe(true);

    const r = await chamar(EMAILS_DEMO.treinadora, "DELETE", `/evidencias/${anexo}`);
    expect(r.status).toBe(204);
    expect(p.armazenamento.arquivos.has(caminho)).toBe(false);

    const lista = await chamar(EMAILS_DEMO.gestor, "GET", `/atletas/${idT}/evidencias`);
    const item = lista.corpo.anexos.find((a: { id: string }) => a.id === anexo);
    expect(item).toMatchObject({ nomeArquivo: "removido" });
    expect(item.removidoEm).toEqual(expect.any(String));
    // O atleta continua visível, então o link do anexo removido dá 410.
    expect((await chamar(EMAILS_DEMO.gestor, "GET", `/evidencias/${anexo}/link`)).status).toBe(410);
    expect((await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${anexo}`)).status).toBe(410);

    const aud = await p.db.query<{ detalhes: unknown }>(
      "select detalhes from auditoria where acao = 'remover_anexo' and entidade_id = $1",
      [idT],
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]!.detalhes).toEqual({ anexoId: anexo, origem: "usuario" });
  });

  it("anexo removido não pode mais ser ligado a uma nota", async () => {
    const anexo = await enviar(EMAILS_DEMO.treinadora);
    await chamar(EMAILS_DEMO.treinadora, "DELETE", `/evidencias/${anexo}`);
    const r = await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${idT}/avaliacoes`, {
      notas: [{ indicadorId: indicador, valor: 3, evidencia: "Observação", anexoId: anexo }],
    });
    expect(r.status).toBe(400);
  });

  it("anexo ligado a uma avaliação responde 409 e nada muda", async () => {
    const anexo = await enviar(EMAILS_DEMO.treinadora);
    const lancou = await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${idT}/avaliacoes`, {
      notas: [{ indicadorId: indicador, valor: 4, evidencia: "Observação", anexoId: anexo }],
    });
    expect(lancou.status).toBe(201);
    const caminho = await caminhoDe(anexo);
    const r = await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${anexo}`);
    expect(r.status).toBe(409);
    expect(p.armazenamento.arquivos.has(caminho)).toBe(true);
    expect(await removidoEm(anexo)).toBeNull();
  });

  it("acesso por papel: gestor remove de qualquer um; treinador só o que enviou e no próprio atleta; atleta e IBVAR não", async () => {
    const doGestor = await enviar(EMAILS_DEMO.gestor);
    // Treinadora com acesso ao atleta, mas não foi quem enviou: 403.
    expect((await chamar(EMAILS_DEMO.treinadora, "DELETE", `/evidencias/${doGestor}`)).status).toBe(
      403,
    );
    expect((await chamar(EMAILS_DEMO.atleta, "DELETE", `/evidencias/${doGestor}`)).status).toBe(
      403,
    );
    expect((await chamar(EMAILS_DEMO.ibvar, "DELETE", `/evidencias/${doGestor}`)).status).toBe(403);
    // Anexo de atleta que não é dela: 404.
    const alheio = await enviar(EMAILS_DEMO.gestor, await p.idDe("RS-T02"));
    expect((await chamar(EMAILS_DEMO.treinadora, "DELETE", `/evidencias/${alheio}`)).status).toBe(
      404,
    );
    const inexistente = "00000000-0000-4000-8000-000000000000";
    expect((await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${inexistente}`)).status).toBe(
      404,
    );
    expect((await chamar(EMAILS_DEMO.gestor, "DELETE", `/evidencias/${doGestor}`)).status).toBe(
      204,
    );
  });

  it("falha do Storage: 503 e o registro não muda", async () => {
    const anexo = await enviar(EMAILS_DEMO.treinadora);
    p.armazenamento.falharRemocao = true;
    const r = await chamar(EMAILS_DEMO.treinadora, "DELETE", `/evidencias/${anexo}`);
    p.armazenamento.falharRemocao = false;
    expect(r.status).toBe(503);
    expect(await removidoEm(anexo)).toBeNull();
    const aud = await p.db.query(
      "select 1 from auditoria where acao = 'remover_anexo' and detalhes->>'anexoId' = $1",
      [anexo],
    );
    expect(aud.rows).toHaveLength(0);
  });

  it("job: remove só os não vinculados com mais de 24 h", async () => {
    const velho = await enviar(EMAILS_DEMO.treinadora);
    const vinculado = await enviar(EMAILS_DEMO.treinadora);
    const novo = await enviar(EMAILS_DEMO.treinadora);
    await chamar(EMAILS_DEMO.treinadora, "POST", `/atletas/${idT}/avaliacoes`, {
      notas: [{ indicadorId: indicador, valor: 2, evidencia: "Observação", anexoId: vinculado }],
    });
    // Só o `enviado_em` envelhece (a única alteração feita por SQL, só neste teste: trigger desligado).
    await p.db.exec("alter table evidencias_anexos disable trigger evidencias_somente_insercao");
    await p.db.query("update evidencias_anexos set enviado_em = $2 where id = any($1::uuid[])", [
      [velho, vinculado],
      new Date("2026-11-04T12:00:00-03:00"),
    ]);
    await p.db.exec("alter table evidencias_anexos enable trigger evidencias_somente_insercao");
    const caminhoVelho = await caminhoDe(velho);

    const r = await limparAnexosNaoVinculados({
      db: p.db,
      armazenamento: p.armazenamento,
      agora: AGORA(),
    });
    expect(r.falhas).toBe(0);
    expect(r.removidos).toBeGreaterThanOrEqual(1);
    expect(p.armazenamento.arquivos.has(caminhoVelho)).toBe(false);
    expect(await removidoEm(velho)).not.toBeNull();
    expect(await removidoEm(vinculado)).toBeNull();
    expect(await removidoEm(novo)).toBeNull();

    const aud = await p.db.query<{ usuario_id: string | null; detalhes: { origem: string } }>(
      "select usuario_id, detalhes from auditoria where acao = 'remover_anexo' and detalhes->>'anexoId' = $1",
      [velho],
    );
    expect(aud.rows[0]).toMatchObject({ usuario_id: null, detalhes: { origem: "limpeza" } });

    const deNovo = await limparAnexosNaoVinculados({
      db: p.db,
      armazenamento: p.armazenamento,
      agora: AGORA(),
    });
    expect(deNovo.removidos).toBe(0);
  });
});

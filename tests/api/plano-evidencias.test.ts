import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

const PLANO = {
  forcas: "Leitura de vento e consistência em regatas longas",
  lacunas: "Largadas em flota grande",
  meta12m: "Top 20 no Mundial da classe",
  meta24m: "Campanha completa no circuito internacional",
  recomendacao: "Manter o ciclo atual de treinos",
};

const pdf = (extra = 64) => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(extra, 0x20)]);
const png = () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const jpeg = () => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46]);

describe("plano individual", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  const ficha = async (email: string, velaid: string) => {
    const r = await p.app.inject({ method: "GET", url: `/atletas/${await p.idDe(velaid)}`, headers: await p.como(email) });
    return { status: r.statusCode, corpo: r.json() };
  };
  const salvar = async (email: string, velaid: string, corpo: unknown) => {
    const r = await p.app.inject({
      method: "PUT",
      url: `/atletas/${await p.idDe(velaid)}/plano`,
      headers: await p.como(email),
      payload: corpo as object,
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("ficha traz a sugestão calculada e plano nulo antes de registrar", async () => {
    const { status, corpo } = await ficha(EMAILS_DEMO.gestor, "SC-T01");
    expect(status).toBe(200);
    expect(corpo.plano).toBeNull();
    expect(Object.keys(corpo.sugestaoPlano).sort()).toEqual(["forcas", "lacunas", "meta12m", "meta24m", "recomendacao"]);
    for (const v of Object.values(corpo.sugestaoPlano)) expect(String(v).length).toBeGreaterThan(0);
  });

  it("meta de 12 meses usa o nível 'mundial' em minúsculas", async () => {
    const id = await p.idDe("SC-T01");
    const antes = (await ficha(EMAILS_DEMO.gestor, "SC-T01")).corpo;
    const tinha = (antes.resultados as { nivel: string }[]).some((r) => r.nivel === "mundial");
    expect(antes.sugestaoPlano.meta12m).toBe(tinha ? "Top 10 no Mundial da classe" : "Primeiro Mundial da classe, top 50%");
    if (!tinha) {
      await p.db.query(
        `insert into resultados_regata (atleta_id, nivel, evento, data, posicao, tamanho_frota, internacional, fonte, link_oficial)
         values ($1, 'mundial', 'Mundial Teste', '2026-06-01', 30, 120, true, 'manual', 'https://exemplo.org/resultado')`,
        [id],
      );
      const depois = (await ficha(EMAILS_DEMO.gestor, "SC-T01")).corpo;
      expect(depois.sugestaoPlano.meta12m).toBe("Top 10 no Mundial da classe");
    }
  });

  it("treinador registra no próprio atleta (201), nova versão dá 200 e a ficha mostra o último", async () => {
    const primeiro = await salvar(EMAILS_DEMO.treinadora, "SC-T01", PLANO);
    expect(primeiro.status).toBe(201);
    expect(primeiro.corpo).toMatchObject({ ...PLANO, registradoPor: { nome: "Ana Ribeiro" } });
    const segundo = await salvar(EMAILS_DEMO.gestor, "SC-T01", { ...PLANO, meta12m: "Top 10 no Mundial da classe" });
    expect(segundo.status).toBe(200);
    const { corpo } = await ficha(EMAILS_DEMO.treinadora, "SC-T01");
    expect(corpo.plano.meta12m).toBe("Top 10 no Mundial da classe");
    expect(corpo.plano.registradoEm).toBe("2026-11-06T15:00:00.000Z");
    const n = await p.db.query<{ n: string }>("select count(*)::text as n from plano_individual");
    expect(Number(n.rows[0]!.n)).toBe(2);
  });

  it("papéis: atleta e ibvar não registram; treinador não registra em atleta de outro; 404 e 400", async () => {
    expect((await salvar(EMAILS_DEMO.atleta, "SP-T07", PLANO)).status).toBe(403);
    expect((await salvar(EMAILS_DEMO.ibvar, "SC-T01", PLANO)).status).toBe(403);
    expect((await salvar(EMAILS_DEMO.treinadora, "RS-T02", PLANO)).status).toBe(404);
    expect((await salvar(EMAILS_DEMO.gestor, "SC-T01", { ...PLANO, forcas: "   " })).status).toBe(400);
    expect((await salvar(EMAILS_DEMO.gestor, "SC-T01", { ...PLANO, lacunas: "x".repeat(1001) })).status).toBe(400);
    expect((await salvar(EMAILS_DEMO.gestor, "SC-T01", { ...PLANO, extra: "x" })).status).toBe(400);
    const semCampo: Record<string, string> = { ...PLANO };
    delete semCampo.recomendacao;
    expect((await salvar(EMAILS_DEMO.gestor, "SC-T01", semCampo)).status).toBe(400);
  });

  it("atleta vê o próprio plano; IBVAR recebe plano e sugestão nulos", async () => {
    await salvar(EMAILS_DEMO.gestor, "SP-T07", PLANO);
    const dela = (await ficha(EMAILS_DEMO.atleta, "SP-T07")).corpo;
    expect(dela.plano).toMatchObject(PLANO);
    expect(dela.sugestaoPlano).not.toBeNull();
    const ibvar = await ficha(EMAILS_DEMO.ibvar, "SC-T01");
    expect(ibvar.status).toBe(200);
    expect(ibvar.corpo.plano).toBeNull();
    expect(ibvar.corpo.sugestaoPlano).toBeNull();
  });

  it("auditoria registra quais campos mudaram, sem o texto do plano", async () => {
    const r = await p.db.query<{ detalhes: unknown }>(`select detalhes from auditoria where acao = 'registrar_plano'`);
    expect(r.rows.length).toBeGreaterThanOrEqual(2);
    const json = JSON.stringify(r.rows);
    for (const texto of Object.values(PLANO)) expect(json).not.toContain(texto);
    expect(r.rows[0]!.detalhes).toMatchObject({ primeiraVersao: true });
  });

  it("série histórica: plano_individual não aceita UPDATE nem DELETE", async () => {
    await expect(p.db.exec("update plano_individual set forcas = 'x'")).rejects.toThrow(/aceita só inserção/);
    await expect(p.db.exec("delete from plano_individual")).rejects.toThrow(/aceita só inserção/);
  });
});

describe("evidências anexadas", () => {
  let p: Piloto;
  let idT: string; // SC-T01 (treinadora Ana, com consentimento do IBVAR)
  let indT: string; // indicador de nota num pilar não restrito ao IBVAR
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    idT = await p.idDe("SC-T01");
    const r = await p.db.query<{ id: string }>(
      `select i.id from indicadores i join pilares pl on pl.id = i.pilar_id
        where i.tipo = 'T' and not i.calculado and not pl.sensivel order by pl.ordem, i.ordem limit 1`,
    );
    indT = r.rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const enviar = async (email: string, idAtleta: string, corpo: Record<string, unknown>) => {
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${idAtleta}/evidencias`,
      headers: await p.como(email),
      payload: corpo,
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const corpoPdf = (extra: Record<string, unknown> = {}) => ({
    nomeArquivo: "relatorio-regata.pdf",
    tipoMime: "application/pdf",
    conteudoBase64: pdf().toString("base64"),
    ...extra,
  });
  const get = async (email: string, url: string) => {
    const r = await p.app.inject({ method: "GET", url, headers: await p.como(email) });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("treinador anexa PDF, PNG e JPEG; arquivo vai ao storage em atletaId/uuid.ext e metadados ao banco", async () => {
    const a = await enviar(EMAILS_DEMO.treinadora, idT, corpoPdf({ indicadorId: indT }));
    expect(a.status).toBe(201);
    expect(a.corpo).toMatchObject({
      nomeArquivo: "relatorio-regata.pdf",
      tipoMime: "application/pdf",
      tamanhoBytes: pdf().length,
      indicadorId: indT,
      enviadoEm: "2026-11-06T15:00:00.000Z",
    });
    const linha = await p.db.query<{ caminho: string; sha256: string }>(`select caminho, sha256 from evidencias_anexos where id = $1`, [a.corpo.id]);
    expect(linha.rows[0]!.caminho).toMatch(new RegExp(`^${idT}/[0-9a-f-]{36}\\.pdf$`));
    expect(linha.rows[0]!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(p.armazenamento.arquivos.get(linha.rows[0]!.caminho)?.tipoMime).toBe("application/pdf");

    const b = await enviar(EMAILS_DEMO.gestor, idT, { nomeArquivo: "foto.png", tipoMime: "image/png", conteudoBase64: png().toString("base64") });
    const c = await enviar(EMAILS_DEMO.gestor, idT, { nomeArquivo: "foto.jpg", tipoMime: "image/jpeg", conteudoBase64: jpeg().toString("base64") });
    expect([b.status, c.status]).toEqual([201, 201]);
    expect(b.corpo.indicadorId).toBeNull();
  });

  it("recusa assinatura que não bate com o tipo, tamanho acima de 5 MB, nome e base64 inválidos", async () => {
    const trocado = await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ tipoMime: "image/png" }));
    expect(trocado.status).toBe(400);
    const texto = await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ conteudoBase64: Buffer.from("isto nao e pdf").toString("base64") }));
    expect(texto.status).toBe(400);
    const grande = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024 - 4)]);
    expect(grande.length).toBe(5 * 1024 * 1024 + 1);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ conteudoBase64: grande.toString("base64") }))).status).toBe(400);
    const limite = Buffer.concat([Buffer.from("%PDF-"), Buffer.alloc(5 * 1024 * 1024 - 5)]);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ conteudoBase64: limite.toString("base64") }))).status).toBe(201);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ tipoMime: "text/html" }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ nomeArquivo: "../etc/passwd" }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ nomeArquivo: "a\nb.pdf" }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ nomeArquivo: "" }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ nomeArquivo: "a".repeat(201) }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ conteudoBase64: "***não-é-base64***" }))).status).toBe(400);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf({ indicadorId: "nao_existe" }))).status).toBe(400);
  });

  it("acesso por papel: atleta e ibvar não anexam; treinador só nos próprios; falha do storage dá 503", async () => {
    expect((await enviar(EMAILS_DEMO.atleta, await p.idDe("SP-T07"), corpoPdf())).status).toBe(403);
    expect((await enviar(EMAILS_DEMO.ibvar, idT, corpoPdf())).status).toBe(403);
    expect((await enviar(EMAILS_DEMO.treinadora, await p.idDe("RS-T02"), corpoPdf())).status).toBe(404);
    p.armazenamento.falhar = true;
    const antes = Number((await p.db.query<{ n: string }>("select count(*)::text as n from evidencias_anexos")).rows[0]!.n);
    expect((await enviar(EMAILS_DEMO.gestor, idT, corpoPdf())).status).toBe(503);
    const depois = Number((await p.db.query<{ n: string }>("select count(*)::text as n from evidencias_anexos")).rows[0]!.n);
    p.armazenamento.falhar = false;
    expect(depois).toBe(antes);
  });

  it("lista: gestor, treinador do atleta e o próprio atleta; ibvar 403; outros 404", async () => {
    const idHelena = await p.idDe("SP-T07");
    await enviar(EMAILS_DEMO.gestor, idHelena, corpoPdf({ nomeArquivo: "helena.pdf" }));
    const gestor = await get(EMAILS_DEMO.gestor, `/atletas/${idT}/evidencias`);
    expect(gestor.status).toBe(200);
    expect(gestor.corpo.anexos.length).toBeGreaterThanOrEqual(3);
    expect((await get(EMAILS_DEMO.treinadora, `/atletas/${idT}/evidencias`)).status).toBe(200);
    const propria = await get(EMAILS_DEMO.atleta, `/atletas/${idHelena}/evidencias`);
    expect(propria.status).toBe(200);
    expect(propria.corpo.anexos.map((a: { nomeArquivo: string }) => a.nomeArquivo)).toEqual(["helena.pdf"]);
    expect((await get(EMAILS_DEMO.ibvar, `/atletas/${idT}/evidencias`)).status).toBe(403);
    expect((await get(EMAILS_DEMO.atleta, `/atletas/${idT}/evidencias`)).status).toBe(404);
    expect((await get(EMAILS_DEMO.treinadora, `/atletas/${await p.idDe("RS-T02")}/evidencias`)).status).toBe(404);
  });

  it("link temporário respeita o acesso e vai para a auditoria sem nome de arquivo", async () => {
    const idHelena = await p.idDe("SP-T07");
    const dela = (await get(EMAILS_DEMO.gestor, `/atletas/${idHelena}/evidencias`)).corpo.anexos[0];
    const ok = await get(EMAILS_DEMO.atleta, `/evidencias/${dela.id}/link`);
    expect(ok.status).toBe(200);
    expect(ok.corpo.url).toContain(`https://storage.teste/assinado/${idHelena}/`);
    expect(ok.corpo.expiraEm).toEqual(expect.any(String));
    expect((await get(EMAILS_DEMO.gestor, `/evidencias/${dela.id}/link`)).status).toBe(200);
    expect((await get(EMAILS_DEMO.ibvar, `/evidencias/${dela.id}/link`)).status).toBe(403);
    const idMarcos = await p.idDe("RS-T02");
    const deOutro = await enviar(EMAILS_DEMO.gestor, idMarcos, corpoPdf({ nomeArquivo: "marcos.pdf" }));
    expect((await get(EMAILS_DEMO.treinadora, `/evidencias/${deOutro.corpo.id}/link`)).status).toBe(404);
    const daAna = (await get(EMAILS_DEMO.gestor, `/atletas/${idT}/evidencias`)).corpo.anexos[0];
    expect((await get(EMAILS_DEMO.atleta, `/evidencias/${daAna.id}/link`)).status).toBe(404);
    expect((await get(EMAILS_DEMO.gestor, "/evidencias/00000000-0000-4000-8000-000000000000/link")).status).toBe(404);
    expect((await get(EMAILS_DEMO.gestor, "/evidencias/nao-e-uuid/link")).status).toBe(400);

    const aud = await p.db.query(`select detalhes from auditoria where acao in ('acessar_evidencia', 'anexar_evidencia')`);
    expect(aud.rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(aud.rows)).not.toContain("marcos.pdf");
    const json = JSON.stringify(aud.rows);
    expect(json).not.toContain("helena.pdf");
    expect(json).not.toContain("relatorio-regata");
    expect(json).not.toContain(".png");
    const acessos = await p.db.query(`select 1 from auditoria where acao = 'acessar_evidencia'`);
    expect(acessos.rows).toHaveLength(2);
  });

  it("nota com anexoId: aparece na ficha; anexo de outro atleta ou inexistente dá 400; prévia ignora", async () => {
    const meus = (await get(EMAILS_DEMO.gestor, `/atletas/${idT}/evidencias`)).corpo.anexos as { id: string; nomeArquivo: string }[];
    const anexo = meus.find((a) => a.nomeArquivo === "relatorio-regata.pdf")!;
    const nota = (extra: Record<string, unknown>) => ({ notas: [{ indicadorId: indT, valor: 4, evidencia: "Observação em treino", ...extra }] });
    const lancar = async (email: string, id: string, corpo: unknown, sufixo = "") =>
      (await p.app.inject({ method: "POST", url: `/atletas/${id}/avaliacoes${sufixo}`, headers: await p.como(email), payload: corpo as object })).statusCode;

    const alheio = (await get(EMAILS_DEMO.gestor, `/atletas/${await p.idDe("SP-T07")}/evidencias`)).corpo.anexos[0];
    expect(await lancar(EMAILS_DEMO.gestor, idT, nota({ anexoId: alheio.id }))).toBe(400);
    expect(await lancar(EMAILS_DEMO.gestor, idT, nota({ anexoId: "00000000-0000-4000-8000-000000000000" }))).toBe(400);
    expect(await lancar(EMAILS_DEMO.gestor, idT, nota({ anexoId: "nao-uuid" }))).toBe(400);
    // A prévia não grava nem valida o anexo.
    expect(await lancar(EMAILS_DEMO.gestor, idT, nota({ anexoId: alheio.id }), "/previa")).toBe(200);
    const antes = Number((await p.db.query<{ n: string }>("select count(*)::text as n from avaliacoes where anexo_id is not null")).rows[0]!.n);
    expect(antes).toBe(0);

    expect(await lancar(EMAILS_DEMO.treinadora, idT, nota({ anexoId: anexo.id }))).toBe(201);
    const gravado = await p.db.query<{ anexo_id: string }>(`select anexo_id from avaliacao_atual where atleta_id = $1 and indicador_id = $2`, [idT, indT]);
    expect(gravado.rows[0]!.anexo_id).toBe(anexo.id);

    type Ficha = { pilares: { indicadores: { id: string; anexo: { id: string; nomeArquivo: string } | null }[] | null }[] };
    const indicador = (f: Ficha) => f.pilares.flatMap((x) => x.indicadores ?? []).find((i) => i.id === indT)!;
    const gestor = (await get(EMAILS_DEMO.gestor, `/atletas/${idT}`)).corpo as Ficha;
    expect(indicador(gestor).anexo).toEqual({ id: anexo.id, nomeArquivo: "relatorio-regata.pdf" });
    const ibvar = await get(EMAILS_DEMO.ibvar, `/atletas/${idT}`);
    expect(ibvar.status).toBe(200);
    expect(indicador(ibvar.corpo as Ficha).anexo).toBeNull();
    expect(JSON.stringify(ibvar.corpo)).not.toContain("relatorio-regata");

    // Nova nota sem anexo: a ficha deixa de apontar para o anexo antigo (cada lançamento tem o seu).
    expect(await lancar(EMAILS_DEMO.gestor, idT, nota({ valor: 3 }))).toBe(201);
    expect(indicador((await get(EMAILS_DEMO.gestor, `/atletas/${idT}`)).corpo as Ficha).anexo).toBeNull();
  });

  it("evidencias_anexos não aceita UPDATE nem DELETE", async () => {
    await expect(p.db.exec("update evidencias_anexos set nome_arquivo = 'x'")).rejects.toThrow(/aceita só inserção/);
    await expect(p.db.exec("delete from evidencias_anexos")).rejects.toThrow(/aceita só inserção/);
  });
});

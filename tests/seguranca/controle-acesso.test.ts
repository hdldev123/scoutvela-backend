import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cabecalhoAuth, tokenPara } from "../apoio/app.js";
import { jpegValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto, type Piloto } from "../apoio/piloto.js";

/**
 * Auditoria de segurança (25/11/2026): provas de controle de acesso contra a API local, com o seed
 * fictício. Cada caso tenta ler ou mudar um objeto de outra pessoa (BOLA/IDOR, OWASP API1) ou chamar
 * uma rota sem sessão (API2). Nenhum caso pode receber 2xx.
 */

type Metodo = "GET" | "POST" | "PUT" | "DELETE";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const UUID_QUALQUER = "00000000-0000-4000-8000-000000000000";

describe("segurança: controle de acesso", () => {
  let p: Piloto;
  let helena: string; // atleta@scoutvela.dev, atleta da treinadora Ana
  let outroAtleta: string; // atleta do treinador Marcos
  let semConsentimento: string; // atleta sem consentimento para o IBVAR
  let cabMarcos: { authorization: string };

  const chamar = async (
    cab: { authorization: string } | null,
    method: Metodo,
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: cab ?? {},
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json<Record<string, unknown>>() : null };
  };

  const anexar = async (email: string, atletaId: string, categoria: string) => {
    const r = await chamar(await p.como(email), "POST", `/atletas/${atletaId}/evidencias`, {
      nomeArquivo: "foto.jpg",
      tipoMime: "image/jpeg",
      conteudoBase64: jpegValido().toString("base64"),
      categoria,
    });
    expect(r.status).toBe(201);
    return r.corpo!.id as string;
  };

  beforeAll(async () => {
    p = await criarPiloto(AGORA);
    helena = await p.idDe("SP-T07");
    outroAtleta = (
      await p.db.query<{ id: string }>(
        `select a.id from atletas a join usuarios u on u.id = a.treinador_id
          where u.email = 'marcos.pires@scoutvela.dev' and a.ativo order by a.nome limit 1`,
      )
    ).rows[0]!.id;
    semConsentimento = (
      await p.db.query<{ id: string }>(
        `select a.id from atletas a
          where a.ativo and not exists (select 1 from consentimento_atual c
                where c.atleta_id = a.id and c.tipo = 'compartilhar_ibvar' and c.concedido)
          order by a.nome limit 1`,
      )
    ).rows[0]!.id;
    const authMarcos = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where email = $2", [
      authMarcos,
      "marcos.pires@scoutvela.dev",
    ]);
    cabMarcos = cabecalhoAuth(await tokenPara(authMarcos));
  });
  afterAll(() => p.encerrar());

  it("toda rota da API, menos /health, recusa quem não tem sessão (401, ou 400 de validação antes)", async () => {
    const doc = p.app.swagger() as { paths: Record<string, Record<string, unknown>> };
    const abertas: string[] = [];
    let total = 0;
    for (const [caminho, operacoes] of Object.entries(doc.paths)) {
      if (caminho === "/health") continue;
      for (const metodo of Object.keys(operacoes)) {
        const url = caminho
          .replace("{indicadorId}", "tec_trim")
          .replace(/\{[^}]+\}/g, UUID_QUALQUER);
        const m = metodo.toUpperCase() as Metodo;
        const r = await chamar(null, m, url, m === "GET" || m === "DELETE" ? undefined : {});
        total++;
        if (![400, 401].includes(r.status)) abertas.push(`${m} ${caminho} -> ${r.status}`);
      }
    }
    expect(total).toBeGreaterThan(80);
    expect(abertas).toEqual([]);
  });

  it("atleta não lê nem escreve nos dados de outro atleta (BOLA)", async () => {
    const cab = await p.como(EMAILS_DEMO.atleta);
    const tentativas: [Metodo, string, unknown?][] = [
      ["GET", `/atletas/${outroAtleta}`],
      ["GET", `/atletas/${outroAtleta}/indicadores/tec_trim/historico`],
      ["GET", `/atletas/${outroAtleta}/autoavaliacao`],
      ["GET", `/atletas/${outroAtleta}/pesagens`],
      ["GET", `/atletas/${outroAtleta}/conquistas`],
      ["GET", `/atletas/${outroAtleta}/resultados`],
      ["GET", `/atletas/${outroAtleta}/evidencias`],
      [
        "POST",
        `/atletas/${outroAtleta}/evidencias`,
        {
          nomeArquivo: "x.jpg",
          tipoMime: "image/jpeg",
          conteudoBase64: jpegValido().toString("base64"),
        },
      ],
    ];
    for (const [m, url, corpo] of tentativas) {
      const r = await chamar(cab, m, url, corpo);
      expect([403, 404], `${m} ${url}`).toContain(r.status);
    }
    // Objeto de outro atleta acessado pelo id: anexo e conversa.
    const anexoAlheio = await anexar(EMAILS_DEMO.gestor, outroAtleta, "evidencia");
    expect([403, 404]).toContain(
      (await chamar(cab, "GET", `/evidencias/${anexoAlheio}/link`)).status,
    );
    expect([403, 404]).toContain(
      (await chamar(cab, "DELETE", `/evidencias/${anexoAlheio}`)).status,
    );
    const conversa = await chamar(await p.como(EMAILS_DEMO.gestor), "POST", "/conversas", {
      tipo: "gestao_atleta",
      atletaId: outroAtleta,
    });
    expect([200, 201]).toContain(conversa.status);
    const idConversa = conversa.corpo!.id as string;
    for (const [m, url, corpo] of [
      ["GET", `/conversas/${idConversa}/mensagens`],
      ["POST", `/conversas/${idConversa}/mensagens`, { texto: "oi" }],
      ["PUT", `/conversas/${idConversa}/lidas`],
    ] as [Metodo, string, unknown?][]) {
      expect([403, 404], `${m} ${url}`).toContain((await chamar(cab, m, url, corpo)).status);
    }
  });

  it("treinador não alcança atleta de outro treinador nem os objetos dele (BOLA)", async () => {
    const cabHelena = await p.como(EMAILS_DEMO.atleta);
    // Objetos da Helena (atleta da Ana) criados por ela mesma.
    const balanca = await anexar(EMAILS_DEMO.atleta, helena, "balanca");
    const pesagem = await chamar(cabHelena, "POST", "/me/pesagens", {
      pesoKg: 70,
      anexoId: balanca,
    });
    expect(pesagem.status).toBe(201);
    const sumula = await anexar(EMAILS_DEMO.atleta, helena, "sumula");
    const resultado = await chamar(cabHelena, "POST", "/me/resultados", {
      evento: "Campeonato Sul-Americano",
      nivel: "continental",
      ano: 2025,
      posicao: 4,
      anexoId: sumula,
    });
    expect(resultado.status).toBe(201);
    const comprovante = await anexar(EMAILS_DEMO.atleta, helena, "evidencia");
    const conquista = await chamar(cabHelena, "POST", "/me/conquistas", {
      titulo: "Campeã estadual",
      ano: 2024,
      anexoId: comprovante,
    });
    expect(conquista.status).toBe(201);
    const revisao = await chamar(cabHelena, "POST", "/revisoes", {
      indicadorId: "tec_trim",
      motivo: "Discordo da nota de trim lançada neste ciclo.",
    });
    expect(revisao.status).toBe(201);

    const tentativas: [Metodo, string, unknown?][] = [
      ["GET", `/atletas/${helena}`],
      ["GET", `/atletas/${helena}/autoavaliacao`],
      ["GET", `/atletas/${helena}/pesagens`],
      ["GET", `/atletas/${helena}/evidencias`],
      ["GET", `/evidencias/${balanca}/link`],
      [
        "POST",
        `/atletas/${helena}/avaliacoes`,
        { notas: [{ indicadorId: "tec_trim", valor: 5, evidencia: "Ótimo trim." }] },
      ],
      [
        "PUT",
        `/atletas/${helena}/plano`,
        {
          forcas: "Boa leitura de vento.",
          lacunas: "Largada.",
          meta12m: "Top 10 no Brasileiro.",
          meta24m: "Pódio no Sul-Americano.",
          recomendacao: "Treino de largada.",
        },
      ],
      ["POST", `/atletas/${helena}/pedidos-ajuste`, { mensagem: "Revise." }],
      ["PUT", `/pesagens/${pesagem.corpo!.id as string}/validacao`, { decisao: "validar" }],
      ["PUT", `/resultados/${resultado.corpo!.id as string}/validacao`, { decisao: "validar" }],
      ["PUT", `/conquistas/${conquista.corpo!.id as string}/validacao`, { decisao: "validar" }],
      ["PUT", `/revisoes/${revisao.corpo!.id as string}`, { resposta: "Mantida." }],
      ["GET", `/revisoes/${revisao.corpo!.id as string}/lancamentos`],
      ["POST", "/conversas", { tipo: "treinador_atleta", atletaId: helena }],
    ];
    for (const [m, url, corpo] of tentativas) {
      const r = await chamar(cabMarcos, m, url, corpo);
      expect([400, 403, 404], `${m} ${url} -> ${r.status}`).toContain(r.status);
      expect(r.status, `${m} ${url}`).not.toBe(400);
    }
  });

  it("IBVAR não lê atleta sem consentimento nem dados sensíveis de quem consentiu", async () => {
    const cab = await p.como(EMAILS_DEMO.ibvar);
    for (const url of [
      `/atletas/${semConsentimento}`,
      `/atletas/${semConsentimento}/indicadores/tec_trim/historico`,
      `/atletas/${helena}/autoavaliacao`,
      `/atletas/${helena}/pesagens`,
      `/atletas/${helena}/evidencias`,
      `/atletas/${helena}/conquistas`,
      `/atletas/${helena}/resultados`,
      `/conversas`,
      `/me/avisos`,
    ]) {
      const r = await chamar(cab, "GET", url);
      if (url === "/me/avisos") {
        expect(r.status === 403 || (r.corpo?.itens as unknown[]).length === 0, url).toBe(true);
      } else {
        expect([403, 404], url).toContain(r.status);
      }
    }
  });

  it("A1: login sem confirmação de e-mail no token não assume um cadastro ainda sem login", async () => {
    // Pré-condição realista: o convite do gestor falhou e o cadastro ficou sem auth_user_id.
    await p.db.query(
      `insert into usuarios (email, nome, papel) values ('novo.gestor@exemplo.com', 'Novo Gestor', 'gestor')`,
    );
    // Token de uma conta criada por terceiro com o mesmo e-mail, sem a claim email_verified.
    const sub = crypto.randomUUID();
    const token = await tokenPara(sub, { email: "novo.gestor@exemplo.com" });
    const r = await chamar(cabecalhoAuth(token), "GET", "/me");
    expect(r.status).toBe(403);
    const u = await p.db.query<{ auth_user_id: string | null }>(
      "select auth_user_id from usuarios where email = 'novo.gestor@exemplo.com'",
    );
    expect(u.rows[0]!.auth_user_id).toBeNull();
  });
});

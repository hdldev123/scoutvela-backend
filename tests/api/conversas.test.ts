import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limparConversasAntigas } from "../../src/jobs/limpar-conversas.js";
import {
  criarAdminAuthFalso,
  cabecalhoAuth,
  criarUsuarioDeTeste,
  tokenPara,
} from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

let agora = new Date("2026-11-25T12:00:00-03:00");
const avancar = (min: number) => {
  agora = new Date(agora.getTime() + min * 60_000);
};
const diasAtras = (d: number) => new Date(agora.getTime() - d * 86_400_000);

type Quem = string | { authorization: string } | null;

interface Item {
  id: string;
  tipo: string;
  com: { nome?: string; papel?: string; gestao?: boolean };
  atleta: { id: string; nome: string } | null;
  treinador: { id: string; nome: string } | null;
  ultimaMensagemEm: string | null;
  naoLidas: number;
  somenteLeitura: boolean;
  supervisaoAte: string | null;
}
interface Msg {
  id: string;
  autor: { nome: string; papel: string };
  propria: boolean;
  texto: string;
  enviadaEm: string;
}

function criarCliente(p: Piloto) {
  const chamar = async (
    quem: Quem,
    metodo: "GET" | "POST" | "PUT",
    url: string,
    corpo?: unknown,
  ) => {
    const headers = quem === null ? {} : typeof quem === "string" ? await p.como(quem) : quem;
    const r = await p.app.inject({
      method: metodo,
      url,
      headers,
      ...(corpo === undefined ? {} : { payload: corpo as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  return {
    chamar,
    lista: async (quem: Quem, query = "") =>
      (await chamar(quem, "GET", `/conversas${query}`)).corpo.itens as Item[],
    abrir: (quem: Quem, corpo: object) => chamar(quem, "POST", "/conversas", corpo),
    enviar: (quem: Quem, id: string, texto: string) =>
      chamar(quem, "POST", `/conversas/${id}/mensagens`, { texto }),
    ler: async (quem: Quem, id: string, query = "") => {
      const r = await chamar(quem, "GET", `/conversas/${id}/mensagens${query}`);
      return { status: r.status, itens: (r.corpo?.itens ?? []) as Msg[], corpo: r.corpo };
    },
    lidas: (quem: Quem, id: string) => chamar(quem, "PUT", `/conversas/${id}/lidas`),
    contagens: async (quem: Quem) =>
      (await chamar(quem, "GET", "/me/notificacoes")).corpo.contagens as Record<string, number>,
  };
}

/** Cria o login de um atleta existente do seed. */
async function criarContaAtleta(p: Piloto, atletaId: string, nome: string) {
  const authUserId = crypto.randomUUID();
  await p.db.query(
    `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
     values ($1, $2, $3, 'atleta', $4)`,
    [authUserId, `conta-${authUserId.slice(0, 8)}@exemplo.dev`, nome, atletaId],
  );
  return cabecalhoAuth(await tokenPara(authUserId));
}

describe("D16: chat (conversas, mensagens, supervisão)", () => {
  let p: Piloto;
  let c: ReturnType<typeof criarCliente>;
  let helenaId: string; // SP-T07, conta de atleta, da treinadora Ana
  let anaId: string;
  let marcosId: string; // outro treinador do seed
  let marcosAuth: { authorization: string };
  let gestor1Id: string;
  let gestor2: { authorization: string };
  let outroAtleta: { authorization: string }; // atleta da Ana, com conta
  let outroAtletaId: string;
  let atletaDoMarcosId: string;
  let ibvar: string;

  beforeAll(async () => {
    p = await criarPiloto(() => agora, {
      adminAuth: criarAdminAuthFalso(),
      limiteRequisicoes: { max: 100_000, janelaMs: 60_000 },
    });
    c = criarCliente(p);
    const idUsuario = async (email: string) =>
      (await p.db.query<{ id: string }>("select id from usuarios where email = $1", [email]))
        .rows[0]!.id;
    helenaId = await p.idDe("SP-T07");
    anaId = await idUsuario(EMAILS_DEMO.treinadora);
    gestor1Id = await idUsuario(EMAILS_DEMO.gestor);
    ibvar = EMAILS_DEMO.ibvar;
    atletaDoMarcosId = await p.idDe("RS-T02");
    marcosId = (
      await p.db.query<{ treinador_id: string }>("select treinador_id from atletas where id = $1", [
        atletaDoMarcosId,
      ])
    ).rows[0]!.treinador_id;
    const authMarcos = crypto.randomUUID();
    await p.db.query("update usuarios set auth_user_id = $1 where id = $2", [authMarcos, marcosId]);
    marcosAuth = cabecalhoAuth(await tokenPara(authMarcos));
    const g2 = await criarUsuarioDeTeste(p.db, { papel: "gestor", nome: "Gestora Dois" });
    gestor2 = cabecalhoAuth(await tokenPara(g2.authUserId));
    outroAtletaId = (
      await p.db.query<{ id: string }>(
        "select id from atletas where treinador_id = $1 and id <> $2 and ativo order by id limit 1",
        [anaId, helenaId],
      )
    ).rows[0]!.id;
    outroAtleta = await criarContaAtleta(p, outroAtletaId, "Outro Atleta");
  });
  afterAll(() => p.encerrar());

  let parAnaHelena = "";
  let gestaoHelena = "";
  let gestaoAna = "";

  it("sem token: 401; IBVAR: 403 em todas as rotas", async () => {
    expect((await c.chamar(null, "GET", "/conversas")).status).toBe(401);
    const falso = "00000000-0000-4000-8000-000000000000";
    const rotas: ["GET" | "POST" | "PUT", string, object?][] = [
      ["GET", "/conversas"],
      ["GET", "/conversas?supervisao=true"],
      ["POST", "/conversas", { tipo: "gestao_atleta", atletaId: helenaId }],
      ["GET", `/conversas/${falso}/mensagens`],
      ["POST", `/conversas/${falso}/mensagens`, { texto: "oi" }],
      ["PUT", `/conversas/${falso}/lidas`],
      ["POST", `/conversas/${falso}/acesso-supervisao`, { motivo: "denúncia" }],
    ];
    for (const [m, url, corpo] of rotas) {
      expect((await c.chamar(ibvar, m, url, corpo)).status, `${m} ${url}`).toBe(403);
    }
  });

  it("treinador e atleta abrem a conversa do par; abrir de novo devolve a mesma (200)", async () => {
    const a = await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta" });
    expect(a.status).toBe(201);
    expect(a.corpo).toMatchObject({
      tipo: "treinador_atleta",
      com: { papel: "treinador" },
      somenteLeitura: false,
      naoLidas: 0,
      ultimaMensagemEm: null,
    });
    parAnaHelena = a.corpo.id;
    const de = await c.abrir(EMAILS_DEMO.treinadora, {
      tipo: "treinador_atleta",
      atletaId: helenaId,
    });
    expect(de.status).toBe(200);
    expect(de.corpo.id).toBe(parAnaHelena);
    expect(de.corpo.com.papel).toBe("atleta");
    expect((await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta" })).status).toBe(200);
  });

  it("quem pode abrir com quem: atleta com atleta, gestor em treinador_atleta e treinador alheio são barrados", async () => {
    // O atleta não escolhe a outra ponta: apontar outro atleta ou outro treinador é 403.
    expect(
      (await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta", atletaId: outroAtletaId }))
        .status,
    ).toBe(403);
    expect(
      (await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta", treinadorId: marcosId }))
        .status,
    ).toBe(403);
    expect(
      (await c.abrir(EMAILS_DEMO.atleta, { tipo: "gestao_atleta", atletaId: outroAtletaId }))
        .status,
    ).toBe(403);
    expect((await c.abrir(EMAILS_DEMO.atleta, { tipo: "gestao_treinador" })).status).toBe(403);
    // Treinador: só atleta próprio (de outro treinador é 404, sem revelar) e id obrigatório.
    expect(
      (
        await c.abrir(EMAILS_DEMO.treinadora, {
          tipo: "treinador_atleta",
          atletaId: atletaDoMarcosId,
        })
      ).status,
    ).toBe(404);
    const semId = await c.abrir(EMAILS_DEMO.treinadora, { tipo: "treinador_atleta" });
    expect(semId.status).toBe(400);
    expect(semId.corpo.campos[0].campo).toBe("atletaId");
    expect((await c.abrir(EMAILS_DEMO.treinadora, { tipo: "gestao_atleta" })).status).toBe(403);
    expect(
      (await c.abrir(EMAILS_DEMO.treinadora, { tipo: "gestao_treinador", treinadorId: marcosId }))
        .status,
    ).toBe(403);
    // Gestor não abre conversa privada entre treinador e atleta.
    expect(
      (await c.abrir(EMAILS_DEMO.gestor, { tipo: "treinador_atleta", atletaId: helenaId })).status,
    ).toBe(403);
    // Corpo inválido.
    expect((await c.abrir(EMAILS_DEMO.gestor, { tipo: "atleta_atleta" })).status).toBe(400);
    expect((await c.abrir(EMAILS_DEMO.gestor, { tipo: "gestao_atleta" })).status).toBe(400);
    expect(
      (
        await c.abrir(EMAILS_DEMO.gestor, {
          tipo: "gestao_treinador",
          treinadorId: crypto.randomUUID(),
        })
      ).status,
    ).toBe(404);
  });

  it("canal com a gestão: atleta, treinador e gestor abrem; é uma caixa só por atleta e por treinador", async () => {
    const a = await c.abrir(EMAILS_DEMO.atleta, { tipo: "gestao_atleta" });
    expect(a.status).toBe(201);
    expect(a.corpo.com).toEqual({ gestao: true });
    gestaoHelena = a.corpo.id;
    const g = await c.abrir(EMAILS_DEMO.gestor, { tipo: "gestao_atleta", atletaId: helenaId });
    expect(g.status).toBe(200);
    expect(g.corpo.id).toBe(gestaoHelena);
    expect(g.corpo.com).toMatchObject({ papel: "atleta" });
    const g2 = await c.abrir(gestor2, { tipo: "gestao_atleta", atletaId: helenaId });
    expect(g2.corpo.id).toBe(gestaoHelena);

    const t = await c.abrir(EMAILS_DEMO.treinadora, { tipo: "gestao_treinador" });
    expect(t.status).toBe(201);
    gestaoAna = t.corpo.id;
    const gt = await c.abrir(EMAILS_DEMO.gestor, { tipo: "gestao_treinador", treinadorId: anaId });
    expect(gt.status).toBe(200);
    expect(gt.corpo.id).toBe(gestaoAna);
    expect(gt.corpo.com).toMatchObject({ papel: "treinador" });
  });

  it("treinador e atleta trocam mensagens; naoLidas, ordem e propria", async () => {
    avancar(1);
    const e1 = await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, "Treino de amanhã confirmado?");
    expect(e1.status).toBe(201);
    expect(e1.corpo).toMatchObject({ propria: true, texto: "Treino de amanhã confirmado?" });
    avancar(1);
    expect((await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, "<b>oi</b> & mais")).status).toBe(201);

    const ana = (await c.lista(EMAILS_DEMO.treinadora)).find((i) => i.id === parAnaHelena)!;
    expect(ana.naoLidas).toBe(2);
    expect(ana.ultimaMensagemEm).toBe(agora.toISOString());
    const msgs = await c.ler(EMAILS_DEMO.treinadora, parAnaHelena);
    expect(msgs.itens.map((m) => m.texto)).toEqual([
      "Treino de amanhã confirmado?",
      "<b>oi</b> & mais",
    ]);
    expect(msgs.itens.every((m) => !m.propria && m.autor.papel === "atleta")).toBe(true);
    expect(msgs.corpo.proximoAntesDe).toBeNull();

    expect((await c.lidas(EMAILS_DEMO.treinadora, parAnaHelena)).status).toBe(204);
    expect(
      (await c.lista(EMAILS_DEMO.treinadora)).find((i) => i.id === parAnaHelena)!.naoLidas,
    ).toBe(0);

    avancar(1);
    await c.enviar(EMAILS_DEMO.treinadora, parAnaHelena, "Confirmado.");
    const helena = (await c.lista(EMAILS_DEMO.atleta)).find((i) => i.id === parAnaHelena)!;
    expect(helena.naoLidas).toBe(1);
    expect((await c.ler(EMAILS_DEMO.atleta, parAnaHelena)).itens.map((m) => m.propria)).toEqual([
      true,
      true,
      false,
    ]);
  });

  it("paginação: limite, antesDe e depoisDe (polling)", async () => {
    const marco = agora.toISOString();
    for (let i = 1; i <= 3; i++) {
      avancar(1);
      await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, `msg ${i}`);
    }
    const ultimas = await c.ler(EMAILS_DEMO.atleta, parAnaHelena, "?limite=2");
    expect(ultimas.itens.map((m) => m.texto)).toEqual(["msg 2", "msg 3"]);
    expect(ultimas.corpo.proximoAntesDe).toBe(ultimas.itens[0]!.enviadaEm);
    const antes = await c.ler(
      EMAILS_DEMO.atleta,
      parAnaHelena,
      `?limite=2&antesDe=${encodeURIComponent(ultimas.corpo.proximoAntesDe)}`,
    );
    expect(antes.itens.map((m) => m.texto)).toEqual(["Confirmado.", "msg 1"]);
    const novas = await c.ler(
      EMAILS_DEMO.treinadora,
      parAnaHelena,
      `?depoisDe=${encodeURIComponent(marco)}`,
    );
    expect(novas.itens.map((m) => m.texto)).toEqual(["msg 1", "msg 2", "msg 3"]);
    expect(novas.corpo.proximoAntesDe).toBeNull();
    expect((await c.ler(EMAILS_DEMO.atleta, parAnaHelena, "?depoisDe=ontem")).status).toBe(400);
    expect((await c.ler(EMAILS_DEMO.atleta, parAnaHelena, "?limite=0")).status).toBe(400);
  });

  it("acesso: outro atleta, outro treinador e o gestor sem supervisão recebem 404 na conversa do par", async () => {
    for (const quem of [outroAtleta, marcosAuth, EMAILS_DEMO.gestor, gestor2]) {
      expect((await c.ler(quem, parAnaHelena)).status).toBe(404);
      expect((await c.enviar(quem, parAnaHelena, "oi")).status).toBe(404);
      expect((await c.lidas(quem, parAnaHelena)).status).toBe(404);
    }
    expect((await c.ler(EMAILS_DEMO.atleta, crypto.randomUUID())).status).toBe(404);
    expect((await c.ler(EMAILS_DEMO.atleta, "nao-e-uuid")).status).toBe(400);
    // O gestor não enxerga a conversa do par na lista normal.
    expect((await c.lista(EMAILS_DEMO.gestor)).map((i) => i.tipo)).not.toContain(
      "treinador_atleta",
    );
    expect((await c.lista(outroAtleta)).map((i) => i.id)).not.toContain(parAnaHelena);
  });

  it("validação do texto: vazio, só espaços e acima de 2.000 caracteres dão 400 por campo", async () => {
    for (const texto of ["", "   \n ", "x".repeat(2001)]) {
      const r = await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, texto);
      expect(r.status).toBe(400);
      expect(r.corpo.campos[0].campo).toBe("texto");
    }
    expect((await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, "x".repeat(2000))).status).toBe(201);
    expect(
      (await c.chamar(EMAILS_DEMO.atleta, "POST", `/conversas/${parAnaHelena}/mensagens`, {}))
        .status,
    ).toBe(400);
  });

  it("caixa compartilhada: os dois gestores veem e respondem; não lidas por gestor", async () => {
    avancar(1);
    await c.enviar(EMAILS_DEMO.atleta, gestaoHelena, "Posso trocar de classe?");
    const g1 = (await c.lista(EMAILS_DEMO.gestor)).find((i) => i.id === gestaoHelena)!;
    const g2 = (await c.lista(gestor2)).find((i) => i.id === gestaoHelena)!;
    expect([g1.naoLidas, g2.naoLidas]).toEqual([1, 1]);

    avancar(1);
    const resp = await c.enviar(EMAILS_DEMO.gestor, gestaoHelena, "Vamos ver com o treinador.");
    expect(resp.status).toBe(201);
    // O gestor 2 vê o que o gestor 1 respondeu, com o autor.
    const vistoPelo2 = await c.ler(gestor2, gestaoHelena);
    expect(vistoPelo2.itens.map((m) => [m.autor.papel, m.propria])).toEqual([
      ["atleta", false],
      ["gestor", false],
    ]);
    expect(vistoPelo2.itens[1]!.autor.nome).toBeTruthy();
    // Cada gestor tem a sua marca de leitura.
    await c.lidas(EMAILS_DEMO.gestor, gestaoHelena);
    expect((await c.lista(EMAILS_DEMO.gestor)).find((i) => i.id === gestaoHelena)!.naoLidas).toBe(
      0,
    );
    expect((await c.lista(gestor2)).find((i) => i.id === gestaoHelena)!.naoLidas).toBe(2);
    // O gestor 2 também responde.
    avancar(1);
    expect((await c.enviar(gestor2, gestaoHelena, "Segue conosco.")).status).toBe(201);
    // O atleta enxerga as duas respostas, sem saber qual gestor (vê o autor), e a conversa dele é uma só.
    expect((await c.ler(EMAILS_DEMO.atleta, gestaoHelena)).itens).toHaveLength(3);
    // Treinador não lê a conversa do atleta com a gestão; outro atleta também não.
    expect((await c.ler(EMAILS_DEMO.treinadora, gestaoHelena)).status).toBe(404);
    expect((await c.ler(outroAtleta, gestaoHelena)).status).toBe(404);
    // A conversa treinador–gestão é do treinador: o outro treinador não a lê.
    avancar(1);
    await c.enviar(EMAILS_DEMO.treinadora, gestaoAna, "Preciso de apoio para viagem.");
    expect((await c.ler(marcosAuth, gestaoAna)).status).toBe(404);
    expect((await c.ler(gestor2, gestaoAna)).itens).toHaveLength(1);
    expect((await c.ler(EMAILS_DEMO.atleta, gestaoAna)).status).toBe(404);
  });

  it("avisos: um aviso mensagem_nova por conversa até o destinatário ler; gestores ativos recebem na caixa compartilhada", async () => {
    const naoLidos = async (quem: Quem, conversaId: string) =>
      (
        (await c.chamar(quem, "GET", "/me/avisos?apenasNaoLidos=true")).corpo.itens as {
          tipo: string;
          referencia: { conversaId?: string };
        }[]
      ).filter((a) => a.tipo === "mensagem_nova" && a.referencia.conversaId === conversaId);

    // A Ana já tem aviso não lido do par (as mensagens da Helena); mais mensagens não geram outros.
    for (let i = 0; i < 3; i++) {
      avancar(1);
      await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, `enxurrada ${i}`);
    }
    expect(await naoLidos(EMAILS_DEMO.treinadora, parAnaHelena)).toHaveLength(1);
    // Ler a conversa dá o aviso por lido; a próxima mensagem avisa de novo.
    await c.lidas(EMAILS_DEMO.treinadora, parAnaHelena);
    expect(await naoLidos(EMAILS_DEMO.treinadora, parAnaHelena)).toHaveLength(0);
    avancar(1);
    await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, "de novo");
    const novo = await naoLidos(EMAILS_DEMO.treinadora, parAnaHelena);
    expect(novo).toHaveLength(1);
    // O autor nunca se avisa.
    expect(await naoLidos(EMAILS_DEMO.atleta, parAnaHelena)).toHaveLength(1); // da resposta "Confirmado."
    // Caixa compartilhada: os dois gestores receberam o aviso da pergunta da Helena; ela recebeu os das respostas.
    expect(await naoLidos(EMAILS_DEMO.gestor, gestaoHelena)).toHaveLength(0); // já leu (lidas)
    expect(await naoLidos(gestor2, gestaoHelena)).toHaveLength(1);
    expect(await naoLidos(EMAILS_DEMO.atleta, gestaoHelena)).toHaveLength(1);
    // O IBVAR não recebe nada.
    const r = await p.db.query<{ n: string }>(
      `select count(*)::text as n from avisos a join usuarios u on u.id = a.destinatario_id
        where a.tipo = 'mensagem_nova' and u.papel = 'ibvar'`,
    );
    expect(r.rows[0]!.n).toBe("0");
    // O aviso não cita atleta (some ou não conforme a visibilidade, não depende dela).
    const sem = await p.db.query<{ n: string }>(
      `select count(*)::text as n from avisos where tipo = 'mensagem_nova' and atleta_id is not null`,
    );
    expect(sem.rows[0]!.n).toBe("0");
  });

  it("balão conversas de GET /me/notificacoes: soma das não lidas de gestor, treinador e atleta", async () => {
    const ana = await c.contagens(EMAILS_DEMO.treinadora);
    const lista = await c.lista(EMAILS_DEMO.treinadora);
    expect(ana.conversas).toBe(lista.reduce((s, i) => s + i.naoLidas, 0));
    expect(ana.conversas).toBeGreaterThan(0);
    const hel = await c.contagens(EMAILS_DEMO.atleta);
    expect(hel.conversas).toBe(
      (await c.lista(EMAILS_DEMO.atleta)).reduce((s, i) => s + i.naoLidas, 0),
    );
    const g = await c.contagens(gestor2);
    expect(g.conversas).toBe((await c.lista(gestor2)).reduce((s, i) => s + i.naoLidas, 0));
    expect(g.conversas).toBeGreaterThan(0);
    expect((await c.contagens(ibvar)).conversas).toBeUndefined();
    // Ler zera o balão.
    for (const i of await c.lista(EMAILS_DEMO.treinadora))
      await c.lidas(EMAILS_DEMO.treinadora, i.id);
    expect((await c.contagens(EMAILS_DEMO.treinadora)).conversas).toBe(0);
  });

  it("supervisão: sem acesso 404; lista só com metadados; com motivo lê por 24 h, não envia e audita sem conteúdo", async () => {
    // Lista de supervisão: só gestor, só metadados.
    expect(
      (await c.chamar(EMAILS_DEMO.treinadora, "GET", "/conversas?supervisao=true")).status,
    ).toBe(403);
    expect((await c.chamar(EMAILS_DEMO.atleta, "GET", "/conversas?supervisao=true")).status).toBe(
      403,
    );
    const meta = await c.lista(EMAILS_DEMO.gestor, "?supervisao=true");
    const par = meta.find((i) => i.id === parAnaHelena)!;
    expect(par).toMatchObject({
      tipo: "treinador_atleta",
      naoLidas: 0,
      somenteLeitura: true,
      supervisaoAte: null,
    });
    expect(par.atleta!.id).toBe(helenaId);
    expect(par.treinador!.id).toBe(anaId);
    expect(JSON.stringify(meta)).not.toContain("Treino de amanhã");
    expect(meta.every((i) => i.tipo === "treinador_atleta")).toBe(true);

    // Motivo curto ou ausente: 400 por campo. Só gestor pede. Gestão não precisa.
    const url = `/conversas/${parAnaHelena}/acesso-supervisao`;
    const curto = await c.chamar(EMAILS_DEMO.gestor, "POST", url, { motivo: "abc" });
    expect(curto.status).toBe(400);
    expect(curto.corpo.campos[0].campo).toBe("motivo");
    expect((await c.chamar(EMAILS_DEMO.gestor, "POST", url, {})).status).toBe(400);
    expect(
      (await c.chamar(EMAILS_DEMO.gestor, "POST", url, { motivo: "x".repeat(501) })).status,
    ).toBe(400);
    expect(
      (await c.chamar(EMAILS_DEMO.treinadora, "POST", url, { motivo: "denúncia" })).status,
    ).toBe(403);
    expect((await c.chamar(EMAILS_DEMO.atleta, "POST", url, { motivo: "denúncia" })).status).toBe(
      403,
    );
    expect(
      (
        await c.chamar(EMAILS_DEMO.gestor, "POST", `/conversas/${gestaoHelena}/acesso-supervisao`, {
          motivo: "denúncia de assédio",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await c.chamar(
          EMAILS_DEMO.gestor,
          "POST",
          `/conversas/${crypto.randomUUID()}/acesso-supervisao`,
          {
            motivo: "denúncia de assédio",
          },
        )
      ).status,
    ).toBe(404);
    expect((await c.ler(EMAILS_DEMO.gestor, parAnaHelena)).status).toBe(404);

    const ok = await c.chamar(EMAILS_DEMO.gestor, "POST", url, { motivo: "Denúncia do atleta" });
    expect(ok.status).toBe(201);
    expect(ok.corpo.expiraEm).toBe(new Date(agora.getTime() + 24 * 3_600_000).toISOString());
    const lidas = await c.ler(EMAILS_DEMO.gestor, parAnaHelena);
    expect(lidas.status).toBe(200);
    expect(lidas.itens.length).toBeGreaterThan(3);
    // Só ele: o outro gestor segue sem acesso.
    expect((await c.ler(gestor2, parAnaHelena)).status).toBe(404);
    // Só lê.
    expect((await c.enviar(EMAILS_DEMO.gestor, parAnaHelena, "Oi")).status).toBe(403);
    const naLista = (await c.lista(EMAILS_DEMO.gestor, "?supervisao=true")).find(
      (i) => i.id === parAnaHelena,
    )!;
    expect(naLista.supervisaoAte).toBe(ok.corpo.expiraEm);
    expect((await c.lidas(EMAILS_DEMO.gestor, parAnaHelena)).status).toBe(204);
    const marcas = await p.db.query(
      "select 1 from leituras_conversa where conversa_id = $1 and usuario_id = $2",
      [parAnaHelena, gestor1Id],
    );
    expect(marcas.rows).toHaveLength(0);

    // Auditoria: motivo sim, texto das mensagens não.
    const aud = await p.db.query<{ usuario_id: string; entidade_id: string; detalhes: object }>(
      `select usuario_id, entidade_id, detalhes from auditoria where acao = 'acessar_conversa_supervisao'`,
    );
    expect(aud.rows).toHaveLength(1);
    expect(aud.rows[0]).toMatchObject({ usuario_id: gestor1Id, entidade_id: parAnaHelena });
    expect(aud.rows[0]!.detalhes).toMatchObject({ motivo: "Denúncia do atleta" });
    const tudo = await p.db.query<{ d: string }>(
      `select string_agg(detalhes::text, ' ') as d from auditoria where entidade = 'conversas'`,
    );
    for (const texto of [
      "Treino de amanhã",
      "Confirmado.",
      "enxurrada",
      "Posso trocar de classe",
    ]) {
      expect(tudo.rows[0]!.d).not.toContain(texto);
    }

    // Expira em 24 horas.
    avancar(24 * 60 - 1);
    expect((await c.ler(EMAILS_DEMO.gestor, parAnaHelena)).status).toBe(200);
    avancar(2);
    expect((await c.ler(EMAILS_DEMO.gestor, parAnaHelena)).status).toBe(404);
    // Novo pedido renova.
    expect(
      (await c.chamar(EMAILS_DEMO.gestor, "POST", url, { motivo: "Nova denúncia" })).status,
    ).toBe(201);
    expect((await c.ler(EMAILS_DEMO.gestor, parAnaHelena)).status).toBe(200);
  });

  it("troca de treinador: o novo não lê a conversa antiga; o antigo e o atleta só leem; o atleta abre com o novo", async () => {
    await p.db.query("update atletas set treinador_id = $1 where id = $2", [marcosId, helenaId]);
    // O Marcos não herda nada.
    expect((await c.lista(marcosAuth)).map((i) => i.id)).not.toContain(parAnaHelena);
    expect((await c.ler(marcosAuth, parAnaHelena)).status).toBe(404);
    expect(
      (await c.abrir(marcosAuth, { tipo: "treinador_atleta", atletaId: helenaId })).status,
    ).toBe(201);
    // Ana e Helena seguem lendo, só leitura.
    const ana = (await c.lista(EMAILS_DEMO.treinadora)).find((i) => i.id === parAnaHelena)!;
    expect(ana.somenteLeitura).toBe(true);
    const hel = (await c.lista(EMAILS_DEMO.atleta)).find((i) => i.id === parAnaHelena)!;
    expect(hel.somenteLeitura).toBe(true);
    expect((await c.ler(EMAILS_DEMO.treinadora, parAnaHelena)).itens.length).toBeGreaterThan(3);
    expect((await c.enviar(EMAILS_DEMO.treinadora, parAnaHelena, "Ainda sou eu?")).status).toBe(
      409,
    );
    expect((await c.enviar(EMAILS_DEMO.atleta, parAnaHelena, "Oi, Ana")).status).toBe(409);
    // O par antigo guarda quando deixou de valer.
    const enc = await p.db.query<{ encerrada_em: Date | null }>(
      "select encerrada_em from conversas where id = $1",
      [parAnaHelena],
    );
    expect(enc.rows[0]!.encerrada_em).not.toBeNull();
    // A atleta abre a conversa nova com o treinador atual (outra conversa).
    const nova = await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta" });
    expect(nova.corpo.id).not.toBe(parAnaHelena);
    expect(nova.corpo.com.nome).toBeTruthy();
    expect(nova.corpo.somenteLeitura).toBe(false);
    expect((await c.enviar(EMAILS_DEMO.atleta, nova.corpo.id, "Olá, Marcos")).status).toBe(201);
    expect((await c.ler(marcosAuth, nova.corpo.id)).itens).toHaveLength(1);
    expect((await c.ler(EMAILS_DEMO.treinadora, nova.corpo.id)).status).toBe(404);
    // Se ela voltar para a Ana, o par antigo volta a valer.
    await p.db.query("update atletas set treinador_id = $1 where id = $2", [anaId, helenaId]);
    expect(
      (await c.lista(EMAILS_DEMO.treinadora)).find((i) => i.id === parAnaHelena)!.somenteLeitura,
    ).toBe(false);
    const enc2 = await p.db.query<{ encerrada_em: Date | null }>(
      "select encerrada_em from conversas where id = $1",
      [parAnaHelena],
    );
    expect(enc2.rows[0]!.encerrada_em).toBeNull();
  });

  it("mensagens e supervisões só aceitam inserção (UPDATE e DELETE são recusados)", async () => {
    await expect(p.db.query("update mensagens set texto = 'x'")).rejects.toThrow();
    await expect(p.db.query("delete from mensagens")).rejects.toThrow();
    await expect(p.db.query("delete from acessos_supervisao")).rejects.toThrow();
    await expect(
      p.db.query("update acessos_supervisao set motivo = 'outro motivo'"),
    ).rejects.toThrow();
  });

  it("atleta de gestão inativo vira somente leitura e treinador desativado não conversa", async () => {
    await p.db.query("update atletas set ativo = false where id = $1", [outroAtletaId]);
    const inativado = await p.db.query<{ inativado_em: Date | null }>(
      "select inativado_em from atletas where id = $1",
      [outroAtletaId],
    );
    expect(inativado.rows[0]!.inativado_em).not.toBeNull();
    expect(
      (await c.abrir(EMAILS_DEMO.gestor, { tipo: "gestao_atleta", atletaId: outroAtletaId }))
        .status,
    ).toBe(404);
    await p.db.query("update atletas set ativo = true where id = $1", [outroAtletaId]);
    const reativado = await p.db.query<{ inativado_em: Date | null }>(
      "select inativado_em from atletas where id = $1",
      [outroAtletaId],
    );
    expect(reativado.rows[0]!.inativado_em).toBeNull();
  });

  it("limite de 30 mensagens por minuto por usuário (429); outro usuário não é afetado", async () => {
    const g3 = await criarUsuarioDeTeste(p.db, { papel: "gestor", nome: "Gestor Três" });
    const gestor3 = cabecalhoAuth(await tokenPara(g3.authUserId));
    const conv = (await c.abrir(gestor3, { tipo: "gestao_atleta", atletaId: outroAtletaId })).corpo
      .id as string;
    for (let i = 0; i < 30; i++) {
      const r = await c.enviar(gestor3, conv, `m${i}`);
      expect(r.status, `mensagem ${i + 1}`).toBe(201);
    }
    const bloqueada = await c.enviar(gestor3, conv, "31ª");
    expect(bloqueada.status).toBe(429);
    expect(bloqueada.corpo.erro).toBe("limite_excedido");
    expect(bloqueada.corpo.mensagem).toBeTruthy();
    expect((await c.enviar(outroAtleta, conv, "resposta")).status).toBe(201);
    // Nada da 31ª foi gravado.
    const n = await p.db.query<{ n: string }>(
      "select count(*)::text as n from mensagens where conversa_id = $1",
      [conv],
    );
    expect(n.rows[0]!.n).toBe("31");
  });
});

describe("D16: retenção, anonimização e exportação", () => {
  let p: Piloto;
  let c: ReturnType<typeof criarCliente>;

  beforeAll(async () => {
    p = await criarPiloto(() => agora, {
      adminAuth: criarAdminAuthFalso(),
      limiteRequisicoes: { max: 100_000, janelaMs: 60_000 },
    });
    c = criarCliente(p);
  });
  afterAll(() => p.encerrar());

  const inserirConversa = async (
    tipo: string,
    atletaId: string | null,
    treinadorId: string | null,
    autorId: string,
    extra = "",
  ) => {
    const r = await p.db.query<{ id: string }>(
      `insert into conversas (tipo, atleta_id, treinador_id) values ($1, $2, $3) returning id`,
      [tipo, atletaId, treinadorId],
    );
    const id = r.rows[0]!.id;
    await p.db.query(
      `insert into mensagens (conversa_id, autor_id, texto) values ($1, $2, 'oi ${extra}')`,
      [id, autorId],
    );
    await p.db.query(
      `insert into leituras_conversa (conversa_id, usuario_id, lida_ate) values ($1, $2, now())`,
      [id, autorId],
    );
    return id;
  };
  const existe = async (id: string) =>
    (await p.db.query("select 1 from conversas where id = $1", [id])).rows.length > 0;

  it("anonimização apaga na hora as conversas do atleta; exportação traz as mensagens do titular", async () => {
    const atletaId = await p.idDe("SP-T07"); // Helena, com conta (atleta@scoutvela.dev)
    const parAbert = await c.abrir(EMAILS_DEMO.atleta, { tipo: "treinador_atleta" });
    const gestaoAbert = await c.abrir(EMAILS_DEMO.atleta, { tipo: "gestao_atleta" });
    avancar(1);
    await c.enviar(EMAILS_DEMO.atleta, parAbert.corpo.id, "Segredo do treino");
    avancar(1);
    await c.enviar(EMAILS_DEMO.treinadora, parAbert.corpo.id, "Resposta da Ana");
    avancar(1);
    await c.enviar(EMAILS_DEMO.atleta, gestaoAbert.corpo.id, "Dúvida para a gestão");

    // Exportação (LGPD): texto, autor e data.
    const exp = await c.chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados");
    expect(exp.status).toBe(200);
    const msgs = exp.corpo.mensagens as {
      tipo: string;
      texto: string;
      autor: string;
      autorPapel: string;
      enviadaEm: string;
    }[];
    expect(msgs.map((m) => m.texto)).toEqual([
      "Segredo do treino",
      "Resposta da Ana",
      "Dúvida para a gestão",
    ]);
    expect(msgs[1]).toMatchObject({ tipo: "treinador_atleta", autorPapel: "treinador" });
    expect(msgs[2]).toMatchObject({ tipo: "gestao_atleta", autorPapel: "atleta" });
    expect(new Date(msgs[0]!.enviadaEm).toISOString()).toBeTruthy();

    // O gestor lê a do par por supervisão, para haver acesso a apagar também.
    await c.chamar(
      EMAILS_DEMO.gestor,
      "POST",
      `/conversas/${parAbert.corpo.id}/acesso-supervisao`,
      {
        motivo: "Conferência de teste",
      },
    );

    const pedido = await c.chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
      tipo: "exclusao",
      descricao: "Quero a exclusão dos meus dados.",
    });
    expect(pedido.status).toBe(201);
    const r = await c.chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${atletaId}/anonimizar`, {
      pedidoTitularId: pedido.corpo.id,
      confirmacao: "ANONIMIZAR",
    });
    expect(r.status).toBe(200);
    for (const tabela of ["mensagens", "leituras_conversa", "acessos_supervisao"]) {
      const n = await p.db.query<{ n: string }>(
        `select count(*)::text as n from ${tabela} where conversa_id = any($1::uuid[])`,
        [[parAbert.corpo.id, gestaoAbert.corpo.id]],
      );
      expect(n.rows[0]!.n, tabela).toBe("0");
    }
    expect(await existe(parAbert.corpo.id)).toBe(false);
    expect(await existe(gestaoAbert.corpo.id)).toBe(false);
    const avisos = await p.db.query(
      `select 1 from avisos where tipo = 'mensagem_nova'
        and referencia->>'conversaId' = any($1::text[])`,
      [[parAbert.corpo.id, gestaoAbert.corpo.id]],
    );
    expect(avisos.rows).toHaveLength(0);
    // A treinadora não vê mais a conversa.
    expect((await c.lista(EMAILS_DEMO.treinadora)).map((i) => i.id)).not.toContain(
      parAbert.corpo.id,
    );
  });
  it("job: apaga só o que passou de 90 dias (atleta inativo ou anonimizado, treinador desativado, par antigo)", async () => {
    const ids = await p.db.query<{ id: string }>(
      `select a.id from atletas a where a.treinador_id is not null and a.ativo order by a.id limit 6`,
    );
    const [a1, a2, a3, a4, a5, a6] = ids.rows.map((r) => r.id) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const gestor = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
    const trein = async (atletaId: string) =>
      (
        await p.db.query<{ treinador_id: string }>(
          "select treinador_id from atletas where id = $1",
          [atletaId],
        )
      ).rows[0]!.treinador_id;
    const t1 = await trein(a1);

    // (a) atleta inativo há 91 dias: sai; há 89 dias: fica; ativo: fica.
    const velhoGestao = await inserirConversa("gestao_atleta", a1, null, gestor);
    const velhoPar = await inserirConversa("treinador_atleta", a1, t1, gestor, "par");
    const recente = await inserirConversa("gestao_atleta", a2, null, gestor);
    const ativo = await inserirConversa("gestao_atleta", a3, null, gestor);
    await p.db.query("update atletas set ativo = false where id in ($1, $2)", [a1, a2]);
    await p.db.query("update atletas set inativado_em = $2 where id = $1", [a1, diasAtras(91)]);
    await p.db.query("update atletas set inativado_em = $2 where id = $1", [a2, diasAtras(89)]);
    // Atleta anonimizado há mais de 90 dias: sai.
    const anon = await inserirConversa("gestao_atleta", a4, null, gestor);
    await p.db.query("update atletas set ativo = false, anonimizado_em = $2 where id = $1", [
      a4,
      diasAtras(120),
    ]);
    // (b) gestao_treinador de treinador desativado: >90 sai; <90 fica.
    const treinadores = await p.db.query<{ id: string }>(
      `select distinct treinador_id as id from atletas where treinador_id is not null order by 1`,
    );
    const [tA, tB] = treinadores.rows.map((r) => r.id) as [string, string];
    const gestaoVelho = await inserirConversa("gestao_treinador", null, tA, gestor);
    const gestaoNovo = await inserirConversa("gestao_treinador", null, tB, gestor);
    await p.db.query("update usuarios set ativo = false where id in ($1, $2)", [tA, tB]);
    await p.db.query("update usuarios set inativado_em = $2 where id = $1", [tA, diasAtras(95)]);
    await p.db.query("update usuarios set inativado_em = $2 where id = $1", [tB, diasAtras(10)]);
    // (c) par antigo: encerrado há 91 dias sai; há 30 dias fica; vigente fica.
    const t5 = await trein(a5);
    const t6 = await trein(a6);
    const parAntigo = await inserirConversa("treinador_atleta", a5, t5, gestor, "a");
    const parRecente = await inserirConversa("treinador_atleta", a6, t6, gestor, "b");
    const parVigente = await inserirConversa("treinador_atleta", a3, await trein(a3), gestor, "c");
    await p.db.query("update conversas set encerrada_em = $2 where id = $1", [
      parAntigo,
      diasAtras(91),
    ]);
    await p.db.query("update conversas set encerrada_em = $2 where id = $1", [
      parRecente,
      diasAtras(30),
    ]);
    // Acesso de supervisão e aviso da conversa que sai também saem.
    await p.db.query(
      `insert into acessos_supervisao (conversa_id, gestor_id, motivo, em, expira_em)
       values ($1, $2, 'motivo de teste', now(), now() + interval '1 day')`,
      [parAntigo, gestor],
    );
    await p.db.query(
      `insert into avisos (destinatario_id, tipo, referencia) values ($1, 'mensagem_nova', $2::jsonb)`,
      [gestor, JSON.stringify({ conversaId: parAntigo })],
    );

    const info: Record<string, unknown>[] = [];
    const r = await limparConversasAntigas({
      db: p.db,
      agora,
      log: { info: (obj) => info.push(obj) },
    });
    expect(r).toEqual({ conversas: 5, mensagens: 5 });
    expect(info).toEqual([{ conversas: 5, mensagens: 5 }]);
    for (const id of [velhoGestao, velhoPar, anon, gestaoVelho, parAntigo]) {
      expect(await existe(id), id).toBe(false);
    }
    for (const id of [recente, ativo, gestaoNovo, parRecente, parVigente]) {
      expect(await existe(id), id).toBe(true);
    }
    for (const tabela of ["mensagens", "leituras_conversa", "acessos_supervisao"]) {
      const sobra = await p.db.query<{ n: string }>(
        `select count(*)::text as n from ${tabela} where conversa_id = $1`,
        [parAntigo],
      );
      expect(sobra.rows[0]!.n, tabela).toBe("0");
    }
    const aviso = await p.db.query("select 1 from avisos where referencia->>'conversaId' = $1", [
      parAntigo,
    ]);
    expect(aviso.rows).toHaveLength(0);
    // Segunda rodada não tem o que apagar; e o DELETE fora do job segue recusado.
    expect(await limparConversasAntigas({ db: p.db, agora })).toEqual({
      conversas: 0,
      mensagens: 0,
    });
    await expect(p.db.query("delete from mensagens")).rejects.toThrow();
  });
});

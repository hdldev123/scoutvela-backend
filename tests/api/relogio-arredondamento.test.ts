import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarAdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

// Longe do relógio real do banco: qualquer `now()` esquecido aparece como data diferente.
const AGORA_FIXO = new Date("2026-11-06T12:00:00-03:00");
const AGORA = () => AGORA_FIXO;

describe("auditorias e carimbos usam app.agora()", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA, { adminAuth: criarAdminAuthFalso() });
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await p.app.inject({
      method,
      url,
      headers: await p.como(email),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const idUsuario = async (email: string) =>
    (await p.db.query<{ id: string }>("select id from usuarios where email = $1", [email])).rows[0]!
      .id;

  it("toda auditoria gravada pelas rotas leva o instante de app.agora()", async () => {
    const ultimo = Number(
      (await p.db.query<{ m: string }>("select coalesce(max(id), 0)::text as m from auditoria"))
        .rows[0]!.m,
    );
    const ana = await idUsuario(EMAILS_DEMO.treinadora);

    // parametros (inclui regras.atualizado_em)
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
          regras: { TERMO_EXIGE_REACEITE: { ativa: false } },
        })
      ).status,
    ).toBe(200);
    // termo publicado
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
          versao: "Piloto 18+ · v2",
          titulo: "Termo do piloto, segunda versão",
          texto:
            "Segunda versão do termo do piloto, com o texto revisado pela CBVela para o ciclo seguinte.",
          vigenteDesde: "2026-11-20T00:00:00-03:00",
        })
      ).status,
    ).toBe(201);
    // aceite antecipado do próprio atleta
    expect(
      (await chamar(EMAILS_DEMO.atleta, "POST", "/termo/aceite", { versao: "Piloto 18+ · v2" }))
        .status,
    ).toBe(200);
    // atleta responde ao questionário e decide o consentimento
    const painel = await chamar(EMAILS_DEMO.atleta, "GET", "/painel");
    const pergunta = (
      painel.corpo.modulos as {
        perguntas: { indicadorId: string; resposta: string | null; opcoes: { texto: string }[] }[];
      }[]
    )
      .flatMap((m) => m.perguntas)
      .find((q) => q.resposta === null)!;
    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "POST", "/respostas", {
          indicadorId: pergunta.indicadorId,
          resposta: pergunta.opcoes[0]!.texto,
        })
      ).status,
    ).toBe(201);
    expect(
      (await chamar(EMAILS_DEMO.atleta, "PUT", "/consentimento", { compartilharIbvar: true }))
        .status,
    ).toBe(200);
    // pedido do titular e exportação
    expect(
      (
        await chamar(EMAILS_DEMO.atleta, "POST", "/pedidos-titular", {
          tipo: "acesso",
          descricao: "Quero uma cópia dos meus dados.",
        })
      ).status,
    ).toBe(201);
    expect((await chamar(EMAILS_DEMO.atleta, "GET", "/meus-dados")).status).toBe(200);
    // cadastro, aceite registrado pelo gestor, edição de atleta e de usuário
    const novo = await chamar(EMAILS_DEMO.gestor, "POST", "/atletas", {
      velaidCodigo: "MG-T15",
      classeId: "ilca7",
      treinadorId: ana,
    });
    expect(novo.status).toBe(201);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", `/atletas/${novo.corpo.id}/termo`, {
          versao: "Piloto 18+ · v1",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "PUT", `/atletas/${novo.corpo.id}`, {
          numeroVela: "BRA 9",
        })
      ).status,
    ).toBe(200);
    expect(
      (await chamar(EMAILS_DEMO.gestor, "PUT", `/usuarios/${ana}`, { nome: "Ana R." })).status,
    ).toBe(200);
    // importação de CSV
    expect(
      (
        await chamar(EMAILS_DEMO.gestor, "POST", "/importacoes", {
          tipo: "velaid",
          conteudo: "codigo;nome;genero;data_nascimento\nRS-T20;Maria Souza;F;1999-01-01\n",
        })
      ).status,
    ).toBe(201);

    const gravadas = await p.db.query<{ acao: string; em: Date }>(
      "select acao, em from auditoria where id > $1",
      [ultimo],
    );
    const acoes = new Set(gravadas.rows.map((r) => r.acao));
    for (const esperada of [
      "atualizar_parametros",
      "publicar_termo",
      "aceitar_termo",
      "responder_questionario",
      "alterar_consentimento",
      "pedir_titular",
      "exportar_dados",
      "cadastrar_atleta",
      "enviar_termo",
      "registrar_aceite_termo",
      "editar_atleta",
      "editar_usuario",
      "importar_csv",
    ]) {
      expect(acoes.has(esperada), esperada).toBe(true);
    }
    const fora = gravadas.rows.filter((r) => r.em.getTime() !== AGORA_FIXO.getTime());
    expect(fora.map((r) => r.acao)).toEqual([]);

    const regra = await p.db.query<{ atualizado_em: Date }>(
      "select atualizado_em from regras where codigo = 'TERMO_EXIGE_REACEITE'",
    );
    expect(regra.rows[0]!.atualizado_em.getTime()).toBe(AGORA_FIXO.getTime());
    const velaid = await p.db.query<{ atualizado_em: Date }>(
      "select atualizado_em from velaid_registros where codigo = 'RS-T20'",
    );
    expect(velaid.rows[0]!.atualizado_em.getTime()).toBe(AGORA_FIXO.getTime());
  });
});

describe("arredondamento em 1 casa (numeric(5,1))", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  it("PUT /parametros: a auditoria guarda o mesmo valor que o banco (peso e altura de classe)", async () => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/parametros",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: {
        classes: [
          {
            id: "ilca7",
            pesoMinKg: 82.84,
            pesoMedioKg: 84.55,
            pesoMaxKg: 87.26,
            alturaMinCm: 179.96,
            alturaMediaCm: 185.04,
            alturaMaxCm: 190.45,
          },
        ],
      },
    });
    expect(r.statusCode).toBe(200);
    const banco = (
      await p.db.query<Record<string, string>>(
        `select peso_min_kg, peso_medio_kg, peso_max_kg, altura_min_cm, altura_media_cm, altura_max_cm
           from classes where id = 'ilca7'`,
      )
    ).rows[0]!;
    expect(banco).toEqual({
      peso_min_kg: "82.8",
      peso_medio_kg: "84.6",
      peso_max_kg: "87.3",
      altura_min_cm: "180.0",
      altura_media_cm: "185.0",
      altura_max_cm: "190.5",
    });
    const aud = (
      await p.db.query<{ detalhes: { classes: { depois: Record<string, unknown> } } }>(
        "select detalhes from auditoria where acao = 'atualizar_parametros' order by id desc limit 1",
      )
    ).rows[0]!;
    expect(aud.detalhes.classes.depois.ilca7).toMatchObject({
      pesoKg: [82.8, 84.6, 87.3],
      alturaCm: [180, 185, 190.5],
    });
  });

  it("POST /avaliacoes: a medida é gravada e usada na prévia com 1 casa", async () => {
    const id = await p.idDe("SC-T01");
    const headers = await p.como(EMAILS_DEMO.gestor);
    const corpo = { medida: { pesoKg: 84.26, alturaCm: 183.04, evidencia: "Pesagem oficial" } };
    const previa = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/avaliacoes/previa`,
      headers,
      payload: corpo,
    });
    expect(previa.statusCode).toBe(200);
    const lancou = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/avaliacoes`,
      headers,
      payload: corpo,
    });
    expect(lancou.statusCode).toBe(201);
    // Prévia e gravação batem: o "depois" da prévia é o score que a ficha mostra.
    expect(lancou.json().depois.score).toBe(previa.json().depois.score);
    const medida = (
      await p.db.query<{ peso_kg: string; altura_cm: string }>(
        "select peso_kg, altura_cm from medidas_corporais where atleta_id = $1 order by id desc limit 1",
        [id],
      )
    ).rows[0]!;
    expect(medida).toEqual({ peso_kg: "84.3", altura_cm: "183.0" });
  });
});

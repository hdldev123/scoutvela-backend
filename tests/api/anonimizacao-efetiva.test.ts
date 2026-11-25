import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  cabecalhoAuth,
  criarAdminAuthFalso,
  tokenPara,
  type AdminAuthFalso,
} from "../apoio/app.js";
import { jpegValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");
const MARCADOR = "[removido na anonimização]";
const NOME = "Fulana Pesquisavel da Silva";
const VELAID = "ZZ-A99";
const EMAIL = "fulana.pesquisavel@exemplo.dev";
const NUMERO_VELA = "BRA 7766Z";
const WS_ID = "BRAFP1234";
const CLUBE = "Clube Pesquisavel";
const pdf = () => Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 0x20)]);

describe("anonimização efetiva (de fato)", () => {
  let p: Piloto;
  let admin: AdminAuthFalso;
  let atletaId: string;
  let contaId: string;
  let authAtleta: string;
  let pedidoExclusao: string;
  let fotoCaminho: string;

  beforeAll(async () => {
    admin = criarAdminAuthFalso();
    p = await criarPiloto(AGORA, { adminAuth: admin });
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    quem: string | { authorization: string } | null,
    method: "GET" | "POST" | "PUT" | "DELETE",
    url: string,
    payload?: unknown,
  ) => {
    const headers = quem === null ? {} : typeof quem === "string" ? await p.como(quem) : quem;
    const r = await p.app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const gestor = (m: "GET" | "POST" | "PUT" | "DELETE", url: string, body?: unknown) =>
    chamar(EMAILS_DEMO.gestor, m, url, body);

  /** Procura o termo em TODAS as colunas de texto e jsonb de TODAS as tabelas do schema public. */
  async function achados(termos: string[]): Promise<string[]> {
    const colunas = await p.db.query<{ t: string; c: string }>(
      `select table_name as t, column_name as c
         from information_schema.columns
        where table_schema = 'public'
          and table_name in (select table_name from information_schema.tables
                              where table_schema = 'public' and table_type = 'BASE TABLE')
          and (data_type in ('text', 'character varying', 'character', 'jsonb', 'json')
               or (data_type = 'ARRAY' and udt_name in ('_text', '_varchar')))`,
    );
    const lista: string[] = [];
    for (const { t, c } of colunas.rows) {
      for (const termo of termos) {
        const r = await p.db.query<{ n: string }>(
          `select count(*)::text as n from "${t}" where "${c}"::text ilike $1`,
          [`%${termo}%`],
        );
        if (Number(r.rows[0]!.n) > 0) lista.push(`${t}.${c} ~ ${termo}`);
      }
    }
    return lista;
  }

  it("monta um atleta cadastrado por POST /atletas com dados em todas as tabelas", async () => {
    await p.db.query(
      `insert into velaid_registros (codigo, nome, genero, data_nascimento, clube, cidade, uf, ws_id, email, fonte)
       values ($1, $2, 'F', '2000-03-15', $3, 'Niterói', 'RJ', $4, $5, 'simulado')`,
      [VELAID, NOME, CLUBE, WS_ID, EMAIL],
    );
    const treinadorId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
    const cad = await gestor("POST", "/atletas", {
      wsId: WS_ID,
      email: EMAIL,
      velaid: VELAID,
      classeId: "ilca6",
      treinadorId,
      confirmaMaioridade: true,
      criarConta: true,
    });
    expect(cad.status).toBe(201);
    expect(cad.corpo.conta).toBe("convite_enviado");
    atletaId = cad.corpo.id;
    const conta = (
      await p.db.query<{ id: string; auth_user_id: string }>(
        "select id, auth_user_id from usuarios where atleta_id = $1",
        [atletaId],
      )
    ).rows[0]!;
    contaId = conta.id;
    authAtleta = conta.auth_user_id;
    const atleta = cabecalhoAuth(await tokenPara(authAtleta));
    // O atleta completa o cadastro no primeiro acesso (nome, gênero e nascimento).
    expect(
      (
        await chamar(atleta, "PUT", "/me/cadastro", {
          nome: NOME,
          genero: "F",
          dataNascimento: "2000-03-15",
        })
      ).status,
    ).toBe(200);

    expect((await gestor("PUT", `/atletas/${atletaId}`, { numeroVela: NUMERO_VELA })).status).toBe(
      200,
    );
    const termo = (await gestor("GET", "/termo")).corpo.versao;
    expect((await gestor("POST", `/atletas/${atletaId}/termo`, { versao: termo })).status).toBe(
      200,
    );

    const resultado = await gestor("POST", `/atletas/${atletaId}/resultados`, {
      nivel: "mundial",
      evento: `Mundial ILCA 6 de ${NOME}`,
      data: "2026-08-10",
      posicao: 12,
      tamanhoFrota: 80,
      linkOficial: "https://resultados.exemplo.dev/fulana-pesquisavel",
    });
    expect(resultado.status).toBe(201);

    const evidenciaTexto = `Observada por ${NOME} em treino`;
    const lanc = await gestor("POST", `/atletas/${atletaId}/avaliacoes`, {
      notas: [{ indicadorId: "tec_boat_handling", valor: 4, evidencia: evidenciaTexto }],
      medida: { pesoKg: 70.2, evidencia: `Pesagem de ${NOME}` },
    });
    expect(lanc.status).toBe(201);

    expect(
      (
        await gestor("PUT", `/atletas/${atletaId}/gates`, {
          gate: 1,
          status: "alerta",
          justificativa: `Conversa com ${NOME} sobre o peso`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await gestor("PUT", `/atletas/${atletaId}/plano`, {
          forcas: `${NOME} lê bem o vento`,
          lacunas: "Largadas",
          meta12m: "Top 20",
          meta24m: "Top 10",
          recomendacao: "Manter",
        })
      ).status,
    ).toBe(201);
    const anexo = await gestor("POST", `/atletas/${atletaId}/evidencias`, {
      nomeArquivo: `laudo ${NOME}.pdf`,
      tipoMime: "application/pdf",
      conteudoBase64: pdf().toString("base64"),
    });
    expect(anexo.status).toBe(201);

    const foto = await chamar(atleta, "POST", "/me/foto", {
      tipoMime: "image/jpeg",
      conteudoBase64: jpegValido().toString("base64"),
    });
    expect(foto.status).toBe(200);
    fotoCaminho = (
      await p.db.query<{ foto_caminho: string }>(
        "select foto_caminho from usuarios where id = $1",
        [contaId],
      )
    ).rows[0]!.foto_caminho;

    expect(
      (
        await chamar(atleta, "POST", "/revisoes", {
          indicadorId: "tec_boat_handling",
          motivo: `Sou ${NOME} e discordo da nota de boat handling.`,
        })
      ).status,
    ).toBe(201);
    const pedido = await chamar(atleta, "POST", "/pedidos-titular", {
      tipo: "exclusao",
      descricao: `Eu, ${NOME}, quero que apaguem meus dados.`,
    });
    expect(pedido.status).toBe(201);
    pedidoExclusao = pedido.corpo.id;
    expect(
      (
        await chamar(atleta, "POST", "/pedidos-titular", {
          tipo: "acesso",
          descricao: `Quero ver os dados de ${NOME}.`,
        })
      ).status,
    ).toBe(201);

    // Linha de auditoria do formato antigo (com o VelaID), como a de um banco já em uso.
    await p.db.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
       values (null, 'cadastrar_atleta', 'atletas', $1, $2::jsonb)`,
      [atletaId, JSON.stringify({ velaid: VELAID, nome: NOME, classeId: "ilca6" })],
    );
  });

  it("o cadastro novo não grava o VelaID na auditoria", async () => {
    const r = await p.db.query<{ detalhes: Record<string, unknown> }>(
      `select detalhes from auditoria where entidade_id = $1 and acao in ('cadastrar_atleta', 'enviar_termo')
        order by id`,
      [atletaId],
    );
    expect(r.rows).toHaveLength(3);
    const novos = r.rows.slice(0, 2);
    for (const l of novos) {
      expect(l.detalhes).not.toHaveProperty("velaid");
      expect(l.detalhes).not.toHaveProperty("wsId");
    }
  });

  it("antes de anonimizar a busca acha os dados (a busca não é vazia)", async () => {
    const antes = await achados([NOME, VELAID, EMAIL, NUMERO_VELA, WS_ID, CLUBE]);
    expect(antes.length).toBeGreaterThan(8);
  });

  it("anonimiza: nome, VelaID, e-mail e número de vela não aparecem em coluna nenhuma", async () => {
    const r = await gestor("POST", `/atletas/${atletaId}/anonimizar`, {
      pedidoTitularId: pedidoExclusao,
      confirmacao: "ANONIMIZAR",
    });
    expect(r.status).toBe(200);
    expect(r.corpo.pendencias).toEqual({ arquivos: 0, conta: false });

    const sobras = await achados([
      NOME,
      "Pesquisavel",
      VELAID,
      EMAIL,
      "fulana.pesquisavel",
      NUMERO_VELA,
      WS_ID,
      CLUBE,
    ]);
    expect(sobras).toEqual([]);
  });

  it("o que ficou: série histórica sem texto, data de nascimento generalizada, regata sem link", async () => {
    const a = (
      await p.db.query<{ nome: string; ativo: boolean; dn: string; genero: string }>(
        "select nome, ativo, data_nascimento::text as dn, genero from atletas where id = $1",
        [atletaId],
      )
    ).rows[0]!;
    expect(a).toEqual({ nome: "Atleta anonimizado", ativo: false, dn: "2000-07-01", genero: "F" });

    const q = async (sql: string) =>
      (await p.db.query<Record<string, unknown>>(sql, [atletaId])).rows;
    expect(
      (await q("select evidencia from avaliacoes where atleta_id = $1")).every(
        (l) => l.evidencia === MARCADOR,
      ),
    ).toBe(true);
    const medidas = await q(
      "select peso_kg::float8 as peso, evidencia from medidas_corporais where atleta_id = $1",
    );
    expect(medidas.every((l) => l.evidencia === MARCADOR)).toBe(true);
    expect(medidas.some((l) => l.peso === 70.2)).toBe(true); // o valor fica
    expect(
      await q("select status, justificativa from gates_decisoes where atleta_id = $1"),
    ).toEqual([{ status: "alerta", justificativa: MARCADOR }]);
    expect(
      await q(
        "select forcas, lacunas, meta_12m, meta_24m, recomendacao from plano_individual where atleta_id = $1",
      ),
    ).toEqual([
      {
        forcas: MARCADOR,
        lacunas: MARCADOR,
        meta_12m: MARCADOR,
        meta_24m: MARCADOR,
        recomendacao: MARCADOR,
      },
    ]);
    expect(
      await q(
        "select evento, link_oficial, anonimizado, posicao, tamanho_frota, nivel from resultados_regata where atleta_id = $1 and fonte = 'manual'",
      ),
    ).toEqual([
      {
        evento: "Evento anonimizado",
        link_oficial: null,
        anonimizado: true,
        posicao: 12,
        tamanho_frota: 80,
        nivel: "mundial",
      },
    ]);
    expect(
      await q("select motivo, status, resposta from pedidos_revisao where atleta_id = $1"),
    ).toEqual([{ motivo: MARCADOR, status: "aberto", resposta: null }]);
    const titular = await q(
      "select tipo, descricao, status, resposta from pedidos_titular where atleta_id = $1 order by id",
    );
    expect(titular.map((l) => l.descricao)).toEqual([MARCADOR, MARCADOR]);
    expect(titular[0]!.status).toBe("respondido");
    expect(String(titular[0]!.resposta)).toMatch(/^Dados pessoais anonimizados em 06\/11\/2026\./);
    expect(titular[1]!.status).toBe("aberto");

    // Auditoria: sem velaid nem nome; ação, entidade, data e usuário ficam.
    const aud = await p.db.query<{ acao: string; detalhes: Record<string, unknown> | null }>(
      "select acao, detalhes from auditoria where entidade_id = $1 order by id",
      [atletaId],
    );
    expect(aud.rows.some((l) => l.acao === "cadastrar_atleta")).toBe(true);
    for (const l of aud.rows) {
      expect(l.detalhes ?? {}).not.toHaveProperty("velaid");
      expect(l.detalhes ?? {}).not.toHaveProperty("nome");
    }
    expect(aud.rows.some((l) => l.acao === "anonimizar_atleta")).toBe(true);

    // Arquivos: evidência e foto saíram do Storage.
    expect(p.armazenamento.arquivos.has(fotoCaminho)).toBe(false);
    expect([...p.armazenamento.arquivos.keys()].filter((k) => k.startsWith(atletaId))).toEqual([]);
  });

  it("fora da transação da anonimização os gatilhos continuam recusando qualquer alteração", async () => {
    const recusa = /aceita só inserção/;
    await expect(p.db.exec("update avaliacoes set evidencia = 'x'")).rejects.toThrow(recusa);
    await expect(
      p.db.query("update avaliacoes set evidencia = $1 where atleta_id = $2", [MARCADOR, atletaId]),
    ).rejects.toThrow(recusa);
    await expect(p.db.exec("update avaliacoes set valor = 0")).rejects.toThrow(recusa);
    await expect(p.db.exec("delete from avaliacoes")).rejects.toThrow(recusa);
    await expect(p.db.exec("update medidas_corporais set evidencia = 'x'")).rejects.toThrow(recusa);
    await expect(p.db.exec("update gates_decisoes set justificativa = 'x'")).rejects.toThrow(
      recusa,
    );
    await expect(p.db.exec("update plano_individual set forcas = 'x'")).rejects.toThrow(recusa);
    await expect(p.db.exec("update respostas_atleta set resposta = 'x'")).rejects.toThrow(recusa);
    await expect(p.db.exec("update consentimentos set concedido = true")).rejects.toThrow(recusa);
    await expect(p.db.exec("update auditoria set detalhes = '{}'::jsonb")).rejects.toThrow(recusa);
    await expect(p.db.exec("delete from auditoria")).rejects.toThrow(recusa);
  });

  it("dentro da transação a exceção vale só para o atleta da variável e só para o texto livre", async () => {
    const recusa = /aceita só inserção/;
    const outro = await p.idDe("RJ-T03");
    // Variável de outro atleta: recusa.
    await expect(
      p.db.transacao(async (tx) => {
        await tx.query(`select set_config('scoutvela.anonimizando', $1, true)`, [outro]);
        await tx.query("update avaliacoes set evidencia = $2 where atleta_id = $1", [
          atletaId,
          "x",
        ]);
      }),
    ).rejects.toThrow(recusa);
    // Variável certa, mas mudando outra coluna ou texto que não é o marcador: recusa.
    for (const sql of [
      "update avaliacoes set valor = 0 where atleta_id = $1",
      "update avaliacoes set evidencia = 'texto qualquer' where atleta_id = $1",
      "update auditoria set acao = 'x' where entidade_id = $1::text",
      "update consentimentos set concedido = true where atleta_id = $1",
    ]) {
      await expect(
        p.db.transacao(async (tx) => {
          await tx.query(`select set_config('scoutvela.anonimizando', $1, true)`, [atletaId]);
          await tx.query(sql, [atletaId]);
        }),
      ).rejects.toThrow(recusa);
    }
    // Depois do commit a variável não vale mais (set local).
    const v = await p.db.query<{ v: string | null }>(
      `select nullif(current_setting('scoutvela.anonimizando', true), '') as v`,
    );
    expect(v.rows[0]!.v).toBeNull();
  });

  it("atleta anonimizado não volta: o check do banco recusa ativo = true", async () => {
    await expect(
      p.db.query("update atletas set ativo = true where id = $1", [atletaId]),
    ).rejects.toThrow(/atletas_anonimizado_inativo/);
  });

  it("o banco recusa novo registro em nome do atleta anonimizado (reforço dos 409 das rotas)", async () => {
    await expect(
      p.db.query(
        `insert into respostas_atleta (atleta_id, indicador_id, resposta)
         values ($1, 'amb_apoio_familiar', 'x')`,
        [atletaId],
      ),
    ).rejects.toThrow(/anonimizado/);
    await expect(
      p.db.query(
        `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
         values ($1, 'acesso', 'Texto de pelo menos dez', (select id from usuarios limit 1))`,
        [atletaId],
      ),
    ).rejects.toThrow(/anonimizado/);
  });

  describe("rotas que gravam recusam o atleta anonimizado com 409", () => {
    const ok409 = (r: { status: number; corpo: { mensagem?: string } | null }) => {
      expect(r.status).toBe(409);
      expect(r.corpo?.mensagem).toMatch(/anonimizado/);
    };

    it("gestor: edição, reativação, termo, avaliações, gates, financeiro, resultados, plano e evidências", async () => {
      ok409(await gestor("PUT", `/atletas/${atletaId}`, { ativo: true, numeroVela: "BRA 1" }));
      const termo = (await gestor("GET", "/termo")).corpo.versao;
      ok409(await gestor("POST", `/atletas/${atletaId}/termo`, { versao: termo }));
      ok409(
        await gestor("POST", `/atletas/${atletaId}/avaliacoes`, {
          notas: [{ indicadorId: "tec_boat_handling", valor: 3, evidencia: "Treino de teste" }],
        }),
      );
      ok409(await gestor("PUT", `/atletas/${atletaId}/gates`, { gate: 1, status: "apto" }));
      ok409(
        await gestor("PUT", `/atletas/${atletaId}/financeiro`, {
          perfilSuporte: "A",
          mesesAssegurados: 12,
          patrocinioPrivado: "sim",
          componentes: [],
        }),
      );
      ok409(
        await gestor("POST", `/atletas/${atletaId}/resultados`, {
          nivel: "mundial",
          evento: "Outro evento",
          data: "2026-09-10",
          posicao: 1,
          tamanhoFrota: 10,
          linkOficial: "https://resultados.exemplo.dev/x",
        }),
      );
      ok409(
        await gestor("PUT", `/atletas/${atletaId}/plano`, {
          forcas: "a",
          lacunas: "b",
          meta12m: "c",
          meta24m: "d",
          recomendacao: "e",
        }),
      );
      ok409(
        await gestor("POST", `/atletas/${atletaId}/evidencias`, {
          nomeArquivo: "novo.pdf",
          tipoMime: "application/pdf",
          conteudoBase64: pdf().toString("base64"),
        }),
      );
      expect([...p.armazenamento.arquivos.keys()].filter((k) => k.startsWith(atletaId))).toEqual(
        [],
      );
    });

    it("gestor: editar a conta de usuário vinculada (nome e reativação) e criar conta para ele", async () => {
      ok409(await gestor("PUT", `/usuarios/${contaId}`, { ativo: true }));
      ok409(await gestor("PUT", `/usuarios/${contaId}`, { nome: "Fulana Voltou" }));
      ok409(
        await gestor("POST", "/usuarios", {
          nome: "Outra Conta",
          email: "outra.conta@exemplo.dev",
          papel: "atleta",
          atletaId,
        }),
      );
      const u = (
        await p.db.query<{ nome: string; ativo: boolean }>(
          "select nome, ativo from usuarios where id = $1",
          [contaId],
        )
      ).rows[0]!;
      expect(u).toEqual({ nome: "Atleta anonimizado", ativo: false });
    });

    it("gestor: responder revisão e pedido do titular do atleta anonimizado", async () => {
      const rev = (
        await p.db.query<{ id: string }>(
          "select id::text as id from pedidos_revisao where atleta_id = $1",
          [atletaId],
        )
      ).rows[0]!.id;
      ok409(await gestor("PUT", `/revisoes/${rev}`, { resposta: "Mantida a nota." }));
      const acesso = (
        await p.db.query<{ id: string }>(
          "select id::text as id from pedidos_titular where atleta_id = $1 and tipo = 'acesso'",
          [atletaId],
        )
      ).rows[0]!.id;
      ok409(await gestor("PUT", `/pedidos-titular/${acesso}`, { resposta: "Segue o acesso." }));
    });

    it("a própria conta (se ainda tivesse sessão) não grava: o login fica inativo e sem auth_user_id", async () => {
      const atleta = cabecalhoAuth(await tokenPara(authAtleta));
      const r = await chamar(atleta, "POST", "/respostas", {
        indicadorId: "amb_apoio_familiar",
        resposta: "Apoia pouco",
      });
      expect([401, 403]).toContain(r.status);
      expect(admin.removidas).toContain(authAtleta);
    });

    it("o anonimizado não aparece no ranking nem nas listas ativas", async () => {
      const rk = await gestor("GET", "/ranking");
      expect(
        (rk.corpo.itens as { atleta: { id: string } }[]).some((i) => i.atleta.id === atletaId),
      ).toBe(false);
    });
  });

  it("repetir o pedido (retomada) continua funcionando e não reabre nada", async () => {
    const r = await gestor("POST", `/atletas/${atletaId}/anonimizar`, {
      pedidoTitularId: pedidoExclusao,
      confirmacao: "ANONIMIZAR",
    });
    expect(r.status).toBe(200);
    expect(r.corpo.pendencias).toEqual({ arquivos: 0, conta: false });
  });
});

describe("anonimização: evidência que escapa e arquivos órfãos", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA, { adminAuth: criarAdminAuthFalso() });
  });
  afterAll(() => p.encerrar());

  const gestorId = async () =>
    (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.gestor,
      ])
    ).rows[0]!.id;
  const pedidoDe = async (atleta: string) =>
    (
      await p.db.query<{ id: string }>(
        `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
         values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
        [atleta, await gestorId()],
      )
    ).rows[0]!.id;
  const anonimizarRota = async (atletaId: string, pedido: string) => {
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${atletaId}/anonimizar`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { pedidoTitularId: pedido, confirmacao: "ANONIMIZAR" },
    });
    return { status: r.statusCode, corpo: r.json() };
  };

  it("evidência ainda disponível na retomada é marcada como removida e sai do Storage", async () => {
    const id = await p.idDe("CE-T09");
    const pedido = await pedidoDe(id);
    expect((await anonimizarRota(id, pedido)).status).toBe(200);

    // Simula o envio que escapou (a rota nova o recusaria): grava com a exceção da anonimização.
    const caminho = `${id}/99999999-9999-4999-8999-999999999999.pdf`;
    await p.armazenamento.salvar(caminho, pdf(), "application/pdf");
    await p.db.transacao(async (tx) => {
      await tx.query(`select set_config('scoutvela.anonimizando', $1, true)`, [id]);
      await tx.query(
        `insert into evidencias_anexos (atleta_id, nome_arquivo, tipo_mime, tamanho_bytes, caminho, sha256, enviado_por)
         values ($1, 'laudo Fulana.pdf', 'application/pdf', 73, $2, $3, $4)`,
        [id, caminho, "a".repeat(64), await gestorId()],
      );
    });
    const r = await anonimizarRota(id, pedido);
    expect(r.status).toBe(200);
    const linha = (
      await p.db.query<{ nome_arquivo: string; removido_em: Date | null }>(
        "select nome_arquivo, removido_em from evidencias_anexos where caminho = $1",
        [caminho],
      )
    ).rows[0]!;
    expect(linha.nome_arquivo).toBe("removido");
    expect(linha.removido_em).not.toBeNull();
    expect(p.armazenamento.arquivos.has(caminho)).toBe(false);
  });

  it("arquivo sob o prefixo do atleta sem registro no banco também sai", async () => {
    const id = await p.idDe("SC-T01");
    const solto = `${id}/88888888-8888-4888-8888-888888888888.pdf`;
    await p.armazenamento.salvar(solto, pdf(), "application/pdf");
    const r = await anonimizarRota(id, await pedidoDe(id));
    expect(r.status).toBe(200);
    expect(p.armazenamento.arquivos.has(solto)).toBe(false);
  });

  it("foto antiga órfã (troca que falhou) e arquivos_pendentes saem na anonimização", async () => {
    const id = await p.idDe("SP-T07");
    const gestor = await p.como(EMAILS_DEMO.gestor);
    // Cria uma conta de atleta para o SP-T07 com auth.
    const authId = crypto.randomUUID();
    const conta = (
      await p.db.query<{ id: string }>(
        `insert into usuarios (auth_user_id, email, nome, papel, atleta_id)
         values ($1, 'sp.t07@teste.dev', 'Helena Teste', 'atleta', $2) returning id`,
        [authId, id],
      )
    ).rows[0]!.id;
    const atleta = cabecalhoAuth(await tokenPara(authId));
    const enviarFoto = () =>
      p.app.inject({
        method: "POST",
        url: "/me/foto",
        headers: atleta,
        payload: { tipoMime: "image/jpeg", conteudoBase64: jpegValido().toString("base64") },
      });
    expect((await enviarFoto()).statusCode).toBe(200);
    const primeira = (
      await p.db.query<{ foto_caminho: string }>(
        "select foto_caminho from usuarios where id = $1",
        [conta],
      )
    ).rows[0]!.foto_caminho;

    // Troca com falha ao remover a anterior: o caminho vai para arquivos_pendentes.
    p.armazenamento.falharRemocao = true;
    expect((await enviarFoto()).statusCode).toBe(200);
    p.armazenamento.falharRemocao = false;
    const pendentes = await p.db.query<{ caminho: string; motivo: string }>(
      "select caminho, motivo from arquivos_pendentes",
    );
    expect(pendentes.rows).toEqual([{ caminho: primeira, motivo: "troca_foto" }]);
    expect(p.armazenamento.arquivos.has(primeira)).toBe(true);

    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/anonimizar`,
      headers: gestor,
      payload: { pedidoTitularId: await pedidoDe(id), confirmacao: "ANONIMIZAR" },
    });
    expect(r.statusCode).toBe(200);
    expect(
      [...p.armazenamento.arquivos.keys()].filter((k) => k.startsWith(`fotos/${conta}/`)),
    ).toEqual([]);
    expect((await p.db.query("select 1 from arquivos_pendentes")).rows).toHaveLength(0);
    expect(
      (
        await p.db.query<{ foto_caminho: string | null }>(
          "select foto_caminho from usuarios where id = $1",
          [conta],
        )
      ).rows[0]!.foto_caminho,
    ).toBeNull();
  });

  it("falha na listagem do Storage vira pendência (a anonimização vale)", async () => {
    const id = await p.idDe("DF-T11");
    p.armazenamento.falharListagem = true;
    const r = await anonimizarRota(id, await pedidoDe(id));
    p.armazenamento.falharListagem = false;
    expect(r.status).toBe(200);
    expect(r.corpo.pendencias.arquivos).toBeGreaterThan(0);
    const r2 = await anonimizarRota(
      id,
      (
        await p.db.query<{ id: string }>(
          "select anonimizado_pedido_id::text as id from atletas where id = $1",
          [id],
        )
      ).rows[0]!.id,
    );
    expect(r2.corpo.pendencias.arquivos).toBe(0);
  });
});

describe("evidência enviada durante a anonimização", () => {
  it("o envio que já tinha subido o arquivo é recusado com 409 e o arquivo é removido", async () => {
    let liberar: () => void = () => undefined;
    let segurar = false;
    let entrou: () => void = () => undefined;
    const noSalvar = new Promise<void>((r) => (entrou = r));
    const { criarArmazenamentoFake } = await import("../apoio/armazenamento.js");
    const base = criarArmazenamentoFake();
    const armazenamento = {
      ...base,
      async salvar(c: string, b: Uint8Array, t: string) {
        if (segurar) {
          entrou();
          await new Promise<void>((r) => (liberar = r));
        }
        return base.salvar(c, b, t);
      },
    };
    const p = await criarPiloto(AGORA, { armazenamento });
    try {
      const id = await p.idDe("CE-T09");
      const gestor = (
        await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
          EMAILS_DEMO.gestor,
        ])
      ).rows[0]!.id;
      const pedido = (
        await p.db.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por)
           values ($1, 'exclusao', 'Quero que apaguem meus dados.', $2) returning id::text as id`,
          [id, gestor],
        )
      ).rows[0]!.id;
      segurar = true;
      const upload = p.app.inject({
        method: "POST",
        url: `/atletas/${id}/evidencias`,
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: {
          nomeArquivo: "laudo.pdf",
          tipoMime: "application/pdf",
          conteudoBase64: pdf().toString("base64"),
        },
      });
      await noSalvar; // passou da checagem de acesso e está gravando no Storage
      segurar = false;
      const an = await p.app.inject({
        method: "POST",
        url: `/atletas/${id}/anonimizar`,
        headers: await p.como(EMAILS_DEMO.gestor),
        payload: { pedidoTitularId: pedido, confirmacao: "ANONIMIZAR" },
      });
      expect(an.statusCode).toBe(200);
      liberar();
      const up = await upload;
      expect(up.statusCode).toBe(409);
      expect(up.json().mensagem).toMatch(/anonimizado/);
      expect(
        (await p.db.query("select 1 from evidencias_anexos where atleta_id = $1", [id])).rows,
      ).toHaveLength(0);
      expect([...base.arquivos.keys()].filter((k) => k.startsWith(id))).toEqual([]);
    } finally {
      await p.encerrar();
    }
  });
});

describe("foto de perfil: remoção antes de zerar o caminho", () => {
  it("DELETE /me/foto: se o Storage falhar, 503 e o caminho continua; repetir conclui", async () => {
    const p = await criarPiloto(AGORA);
    try {
      const h = await p.como(EMAILS_DEMO.atleta);
      const enviar = await p.app.inject({
        method: "POST",
        url: "/me/foto",
        headers: h,
        payload: { tipoMime: "image/jpeg", conteudoBase64: jpegValido().toString("base64") },
      });
      expect(enviar.statusCode).toBe(200);
      const caminho = () =>
        p.db
          .query<{ foto_caminho: string | null }>(
            "select foto_caminho from usuarios where email = $1",
            [EMAILS_DEMO.atleta],
          )
          .then((r) => r.rows[0]!.foto_caminho);
      const antes = (await caminho())!;

      p.armazenamento.falharRemocao = true;
      const falha = await p.app.inject({ method: "DELETE", url: "/me/foto", headers: h });
      p.armazenamento.falharRemocao = false;
      expect(falha.statusCode).toBe(503);
      expect(await caminho()).toBe(antes);
      expect(p.armazenamento.arquivos.has(antes)).toBe(true);

      const ok = await p.app.inject({ method: "DELETE", url: "/me/foto", headers: h });
      expect(ok.statusCode).toBe(204);
      expect(await caminho()).toBeNull();
      expect(p.armazenamento.arquivos.has(antes)).toBe(false);
    } finally {
      await p.encerrar();
    }
  });
});

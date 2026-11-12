import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { buscarAtletaVisivel, cicloAberto } from "../repositories/atletas.js";
import { buscarTermoVigente } from "../repositories/termo.js";
import { carregarParametros } from "../repositories/parametros.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

const esquemaConsentimento = z.object({
  termoAceitoEm: z.string().nullable().describe("Instante ISO do aceite do termo do piloto"),
  termoVersao: z.string().nullable().describe("Última versão do termo aceita"),
  termoVigenteVersao: z.string().describe("Versão do termo vigente hoje"),
  termoPendente: z.boolean().describe("true quando o atleta ainda não aceitou a versão vigente"),
  compartilharIbvar: z.boolean(),
  atualizadoEm: z.string().nullable().describe("Instante ISO da última decisão sobre o IBVAR"),
});

const esquemaPainel = z.object({
  atleta: z.object({ id: z.string(), nome: z.string() }),
  ciclo: z.object({ nome: z.string(), prazo: z.string() }).nullable(),
  score: z.number(),
  faixa: z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string() }),
  completo: z.boolean(),
  modulos: z.array(
    z.object({
      pilarId: z.string(),
      nome: z.string(),
      nomeCurto: z.string(),
      peso: z.number(),
      quemPreenche: z.enum(["atleta", "treinador", "ambos"]),
      preenchidos: z.number().int(),
      total: z.number().int(),
      respostasFeitas: z.number().int(),
      respostasTotal: z.number().int(),
      situacao: z.enum(["sua_vez", "com_treinador", "completo"]),
      perguntas: z.array(
        z.object({
          indicadorId: z.string(),
          enunciado: z.string(),
          registradoNaoPontua: z
            .boolean()
            .describe("Fica registrado, mas não entra na nota (tipo R)"),
          opcoes: z.array(z.object({ ordem: z.number().int(), texto: z.string() })),
          resposta: z.string().nullable(),
        }),
      ),
    }),
  ),
  pendencias: z.array(z.string()).describe("nomeCurto dos pilares com resposta faltando"),
  consentimento: esquemaConsentimento,
});

const esquemaRevisao = z.object({
  id: z.string(),
  atleta: z.object({ id: z.string(), nome: z.string() }),
  pilar: z.object({ id: z.string(), nomeCurto: z.string() }).nullable(),
  indicador: z.object({ id: z.string(), nome: z.string() }).nullable(),
  motivo: z.string(),
  status: z.enum(["aberto", "respondido"]),
  criadoEm: z.string(),
  resposta: z.string().nullable(),
  respondidoEm: z.string().nullable(),
});

async function auditar(
  db: Db,
  usuarioId: string,
  acao: string,
  entidade: string,
  entidadeId: string | null,
  detalhes: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes) values ($1, $2, $3, $4, $5::jsonb)`,
    [usuarioId, acao, entidade, entidadeId, JSON.stringify(detalhes)],
  );
}

async function cicloAbertoId(db: Db): Promise<string | null> {
  const r = await db.query<{ id: string }>(
    `select id from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  return r.rows[0]?.id ?? null;
}

async function lerConsentimento(db: Db, atletaId: string, agora: Date) {
  const vigente = await buscarTermoVigente(db, agora);
  const r = await db.query<{
    tipo: string;
    concedido: boolean;
    versao_termo: string | null;
    registrado_em: Date;
  }>(
    `select tipo, concedido, versao_termo, registrado_em from consentimento_atual where atleta_id = $1::uuid`,
    [atletaId],
  );
  const termo = r.rows.find((x) => x.tipo === "termo_piloto");
  const ibvar = r.rows.find((x) => x.tipo === "compartilhar_ibvar");
  return {
    termoAceitoEm: termo?.concedido ? iso(termo.registrado_em) : null,
    termoVersao: termo?.concedido ? termo.versao_termo : null,
    termoVigenteVersao: vigente.versao,
    termoPendente: !(termo?.concedido && termo.versao_termo === vigente.versao),
    compartilharIbvar: ibvar?.concedido ?? false,
    atualizadoEm: ibvar ? iso(ibvar.registrado_em) : null,
  };
}

interface LinhaRevisao {
  id: string;
  atleta_id: string;
  atleta_nome: string;
  pilar_id: string | null;
  pilar_nome_curto: string | null;
  indicador_id: string | null;
  indicador_nome: string | null;
  motivo: string;
  status: "aberto" | "respondido";
  criado_em: Date;
  resposta: string | null;
  respondido_em: Date | null;
}

const SQL_REVISAO = `select r.id::text as id, r.atleta_id, a.nome as atleta_nome,
         r.pilar_id, p.nome_curto as pilar_nome_curto, r.indicador_id, i.nome as indicador_nome,
         r.motivo, r.status, r.criado_em, r.resposta, r.respondido_em
    from pedidos_revisao r
    join atletas a on a.id = r.atleta_id
    left join pilares p on p.id = r.pilar_id
    left join indicadores i on i.id = r.indicador_id`;

const paraRevisao = (l: LinhaRevisao) => ({
  id: l.id,
  atleta: { id: l.atleta_id, nome: l.atleta_nome },
  pilar: l.pilar_id ? { id: l.pilar_id, nomeCurto: l.pilar_nome_curto ?? "" } : null,
  indicador: l.indicador_id ? { id: l.indicador_id, nome: l.indicador_nome ?? "" } : null,
  motivo: l.motivo,
  status: l.status,
  criadoEm: iso(l.criado_em),
  resposta: l.resposta,
  respondidoEm: l.respondido_em ? iso(l.respondido_em) : null,
});

export async function rotasPainel(app: FastifyInstance): Promise<void> {
  const rotas = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  rotas.get(
    "/painel",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["painel"],
        summary: "Painel do atleta: score, módulos do questionário e consentimento",
        description:
          "Não expõe as notas sugeridas das opções: a resposta só vira nota quando o treinador confirma.",
        security: seguranca,
        response: { 200: esquemaPainel, 401: esquemaErro, 403: esquemaErro, 404: esquemaErro },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      const base = usuario.atletaId
        ? await buscarAtletaVisivel(app.db, usuario, usuario.atletaId, app.agora())
        : null;
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      const [parametros, ciclo, consentimento, perguntasRows] = await Promise.all([
        carregarParametros(app.db),
        cicloAberto(app.db),
        lerConsentimento(app.db, base.id, app.agora()),
        app.db.query<{
          indicador_id: string;
          enunciado: string;
          ordem: number | null;
          texto: string | null;
        }>(
          `select q.indicador_id, q.enunciado, o.ordem, o.texto
             from perguntas_atleta q left join opcoes_resposta o on o.indicador_id = q.indicador_id
            order by q.indicador_id, o.ordem`,
        ),
      ]);
      const [avaliado] = await carregarEAvaliarAtletas(app.db, parametros, [base], app.agora());
      if (!avaliado) throw naoEncontrado("Atleta não encontrado.");
      const { dados, calculo } = avaliado;

      const perguntas = new Map<
        string,
        { enunciado: string; opcoes: { ordem: number; texto: string }[] }
      >();
      for (const l of perguntasRows.rows) {
        const q = perguntas.get(l.indicador_id) ?? { enunciado: l.enunciado, opcoes: [] };
        if (l.ordem !== null && l.texto !== null) q.opcoes.push({ ordem: l.ordem, texto: l.texto });
        perguntas.set(l.indicador_id, q);
      }
      const calcPilar = new Map(calculo.pilares.map((p) => [p.pilarId, p]));

      const modulos = parametros.pilares.map((p) => {
        const c = calcPilar.get(p.id)!;
        const doAtleta = p.indicadores.filter(
          (i) => (i.tipo === "A" || i.tipo === "R") && perguntas.has(i.id),
        );
        const respostasFeitas = doAtleta.filter((i) => dados.respostas[i.id] != null).length;
        const temA = p.indicadores.some((i) => i.tipo === "A");
        const temT = p.indicadores.some((i) => i.tipo === "T");
        const quemPreenche = temA
          ? temT
            ? ("ambos" as const)
            : ("atleta" as const)
          : ("treinador" as const);
        const situacao =
          doAtleta.length > 0 && respostasFeitas < doAtleta.length
            ? ("sua_vez" as const)
            : c.preenchidos < c.total
              ? ("com_treinador" as const)
              : ("completo" as const);
        return {
          pilarId: p.id,
          nome: p.nome,
          nomeCurto: p.nomeCurto,
          peso: p.peso,
          quemPreenche,
          preenchidos: c.preenchidos,
          total: c.total,
          respostasFeitas,
          respostasTotal: doAtleta.length,
          situacao,
          perguntas: doAtleta.map((i) => {
            const q = perguntas.get(i.id)!;
            return {
              indicadorId: i.id,
              enunciado: q.enunciado,
              registradoNaoPontua: i.tipo === "R",
              opcoes: q.opcoes,
              resposta: dados.respostas[i.id] ?? null,
            };
          }),
        };
      });

      return {
        atleta: { id: base.id, nome: base.nome },
        ciclo,
        score: calculo.score,
        faixa: {
          id: calculo.faixa.id,
          nome: calculo.faixa.nome,
          nomeCurto: calculo.faixa.nomeCurto,
        },
        completo: calculo.completo,
        modulos,
        pendencias: modulos
          .filter((m) => m.respostasFeitas < m.respostasTotal)
          .map((m) => m.nomeCurto),
        consentimento,
      };
    },
  );

  rotas.post(
    "/respostas",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["painel"],
        summary: "Responde uma pergunta do questionário",
        description:
          "A resposta deve ser o texto exato de uma opção. Se a opção tem nota sugerida, ela fica pendente: só entra no score quando o treinador confirmar.",
        security: seguranca,
        body: z.object({
          indicadorId: z.string().min(1).max(80),
          resposta: z.string().min(1).max(200),
        }),
        response: {
          201: z.object({ ok: z.literal(true), notaSugerida: z.number().int().nullable() }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const usuario = req.usuario;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const { indicadorId, resposta } = req.body;

      const op = await app.db.query<{ nota_sugerida: number | null }>(
        `select o.nota_sugerida from opcoes_resposta o where o.indicador_id = $1 and o.texto = $2`,
        [indicadorId, resposta],
      );
      if (!op.rows[0]) {
        const existe = await app.db.query(
          `select 1 from perguntas_atleta where indicador_id = $1`,
          [indicadorId],
        );
        throw new ErroApi(
          400,
          "requisicao_invalida",
          existe.rows.length === 0
            ? "Este indicador não tem pergunta para o atleta."
            : "Resposta inválida para esta pergunta.",
        );
      }
      const notaSugerida = op.rows[0].nota_sugerida;
      const agora = app.agora();

      await app.db.transacao(async (tx) => {
        const cicloId = await cicloAbertoId(tx);
        await tx.query(
          `insert into respostas_atleta (atleta_id, indicador_id, ciclo_id, resposta, respondido_em, respondido_por)
           values ($1::uuid, $2, $3, $4, $5, $6::uuid)`,
          [usuario.atletaId, indicadorId, cicloId, resposta, agora, usuario.id],
        );
        if (notaSugerida !== null) {
          await tx.query(
            `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em)
             values ($1::uuid, $2, $3, $4, 'Questionário do atleta', 'resposta_sugerida', null, $5)`,
            [usuario.atletaId, indicadorId, cicloId, notaSugerida, agora],
          );
        }
        await auditar(
          tx,
          usuario.id,
          "responder_questionario",
          "respostas_atleta",
          usuario.atletaId,
          {
            indicadorId,
            geraSugestao: notaSugerida !== null,
          },
        );
      });
      return reply.code(201).send({ ok: true as const, notaSugerida });
    },
  );

  rotas.put(
    "/consentimento",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["painel"],
        summary: "Concede ou retira o compartilhamento do score com o IBVAR",
        description: "Cada decisão vira uma nova linha no histórico de consentimentos (LGPD).",
        security: seguranca,
        body: z.object({ compartilharIbvar: z.boolean() }),
        response: {
          200: esquemaConsentimento,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const atletaId = usuario.atletaId;
      const { compartilharIbvar } = req.body;
      await app.db.transacao(async (tx) => {
        await tx.query(
          `insert into consentimentos (atleta_id, tipo, concedido, registrado_em, registrado_por)
           values ($1::uuid, 'compartilhar_ibvar', $2, $3, $4::uuid)`,
          [atletaId, compartilharIbvar, app.agora(), usuario.id],
        );
        await auditar(tx, usuario.id, "alterar_consentimento", "consentimentos", atletaId, {
          tipo: "compartilhar_ibvar",
          concedido: compartilharIbvar,
        });
      });
      return lerConsentimento(app.db, atletaId, app.agora());
    },
  );

  rotas.post(
    "/revisoes",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["revisoes"],
        summary: "Pede revisão de uma nota (LGPD, art. 20)",
        security: seguranca,
        body: z
          .object({
            pilarId: z.string().min(1).max(40).optional(),
            indicadorId: z.string().min(1).max(80).optional(),
            motivo: z
              .string()
              .trim()
              .min(10, "O motivo precisa ter ao menos 10 caracteres.")
              .max(2000),
          })
          .refine((b) => b.pilarId || b.indicadorId, {
            message: "Informe o pilar ou o indicador.",
          }),
        response: {
          201: z.object({ id: z.string(), status: z.literal("aberto") }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const usuario = req.usuario;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const atletaId = usuario.atletaId;
      const { motivo } = req.body;
      let pilarId = req.body.pilarId ?? null;
      const indicadorId = req.body.indicadorId ?? null;

      if (pilarId) {
        const p = await app.db.query(`select 1 from pilares where id = $1`, [pilarId]);
        if (p.rows.length === 0)
          throw new ErroApi(400, "requisicao_invalida", "Pilar inexistente.");
      }
      if (indicadorId) {
        const i = await app.db.query<{ pilar_id: string }>(
          `select pilar_id from indicadores where id = $1`,
          [indicadorId],
        );
        if (!i.rows[0]) throw new ErroApi(400, "requisicao_invalida", "Indicador inexistente.");
        if (pilarId && pilarId !== i.rows[0].pilar_id) {
          throw new ErroApi(
            400,
            "requisicao_invalida",
            "O indicador não pertence ao pilar informado.",
          );
        }
        pilarId = i.rows[0].pilar_id;
      }

      const id = await app.db.transacao(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into pedidos_revisao (atleta_id, pilar_id, indicador_id, motivo, criado_por, criado_em)
           values ($1::uuid, $2, $3, $4, $5::uuid, $6) returning id::text as id`,
          [atletaId, pilarId, indicadorId, motivo, usuario.id, app.agora()],
        );
        const novo = r.rows[0]!.id;
        await auditar(tx, usuario.id, "pedir_revisao", "pedidos_revisao", novo, {
          pilarId,
          indicadorId,
        });
        return novo;
      });
      return reply.code(201).send({ id, status: "aberto" as const });
    },
  );

  rotas.get(
    "/revisoes",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["revisoes"],
        summary:
          "Lista pedidos de revisão (gestor: todos, abertos primeiro; treinador: dos próprios atletas; atleta: os seus)",
        security: seguranca,
        querystring: z.object({ status: z.enum(["aberto", "respondido"]).optional() }),
        response: { 200: z.array(esquemaRevisao), 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      const proprio = usuario.papel === "atleta";
      if (proprio && !usuario.atletaId) return [];
      const condicoes: string[] = [];
      const params: unknown[] = [];
      if (proprio) {
        params.push(usuario.atletaId);
        condicoes.push(`r.atleta_id = $${params.length}::uuid`);
      } else if (usuario.papel === "treinador") {
        params.push(usuario.id);
        condicoes.push(`a.treinador_id = $${params.length}::uuid`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        condicoes.push(`r.status = $${params.length}`);
      }
      const r = await app.db.query<LinhaRevisao>(
        `${SQL_REVISAO}
          ${condicoes.length ? `where ${condicoes.join(" and ")}` : ""}
          order by (r.status = 'aberto') desc, r.criado_em desc, r.id desc`,
        params,
      );
      return r.rows.map(paraRevisao);
    },
  );

  rotas.put(
    "/revisoes/:id",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["revisoes"],
        summary: "Responde um pedido de revisão",
        description: "Pedido já respondido devolve 409 (código requisicao_invalida).",
        security: seguranca,
        params: z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") }),
        body: z.object({
          resposta: z
            .string()
            .trim()
            .min(3, "A resposta precisa ter ao menos 3 caracteres.")
            .max(2000),
        }),
        response: {
          200: esquemaRevisao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      const { id } = req.params;
      await app.db.transacao(async (tx) => {
        const r = await tx.query(
          `update pedidos_revisao
              set status = 'respondido', resposta = $2, respondido_por = $3::uuid, respondido_em = $4
            where id = $1::bigint and status = 'aberto'
        returning id`,
          [id, req.body.resposta, usuario.id, app.agora()],
        );
        if (r.rows.length === 0) {
          const existe = await tx.query(`select 1 from pedidos_revisao where id = $1::bigint`, [
            id,
          ]);
          if (existe.rows.length === 0) throw naoEncontrado("Pedido de revisão não encontrado.");
          throw new ErroApi(409, "requisicao_invalida", "Este pedido já foi respondido.");
        }
        await auditar(tx, usuario.id, "responder_revisao", "pedidos_revisao", id, {});
      });
      const r = await app.db.query<LinhaRevisao>(`${SQL_REVISAO} where r.id = $1::bigint`, [id]);
      return paraRevisao(r.rows[0]!);
    },
  );
}

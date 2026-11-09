import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { conflito, esquemaErro, naoEncontrado } from "../erros.js";

/**
 * Direitos do titular (LGPD, art. 18) para o atleta: exportar os próprios dados e
 * pedir acesso, correção, exclusão ou revogação. A exclusão em si é manual (procedimento do gestor),
 * porque a série histórica só aceita inserção.
 */

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

const tiposPedido = ["acesso", "correcao", "exclusao", "revogacao"] as const;

const esquemaPedido = z.object({
  id: z.string(),
  atleta: z.object({ id: z.string(), nome: z.string() }),
  tipo: z.enum(tiposPedido),
  descricao: z.string(),
  status: z.enum(["aberto", "respondido"]),
  criadoEm: z.string(),
  resposta: z.string().nullable(),
  respondidoEm: z.string().nullable(),
});

const registros = z.array(z.record(z.string(), z.unknown()));

const esquemaExportacao = z.object({
  geradoEm: z.string(),
  conta: z.object({ nome: z.string(), email: z.string(), papel: z.string() }),
  atleta: z.record(z.string(), z.unknown()),
  consentimentos: registros.describe("Histórico de decisões (termo do piloto e compartilhamento com o IBVAR)"),
  notas: registros.describe("Série histórica: valor, evidência, data e avaliador de cada lançamento"),
  respostas: registros.describe("Respostas do questionário (série histórica)"),
  medidas: registros,
  resultados: registros,
  gates: registros.describe("Decisões do gestor sobre os gates"),
  financeiro: registros.describe("Histórico do financeiro da campanha, com os componentes de cada lançamento"),
  pedidosRevisao: registros,
  pedidosTitular: registros,
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

interface LinhaPedido {
  id: string;
  atleta_id: string;
  atleta_nome: string;
  tipo: (typeof tiposPedido)[number];
  descricao: string;
  status: "aberto" | "respondido";
  criado_em: Date;
  resposta: string | null;
  respondido_em: Date | null;
}

const SQL_PEDIDO = `select p.id::text as id, p.atleta_id, a.nome as atleta_nome, p.tipo, p.descricao,
         p.status, p.criado_em, p.resposta, p.respondido_em
    from pedidos_titular p join atletas a on a.id = p.atleta_id`;

const paraPedido = (l: LinhaPedido) => ({
  id: l.id,
  atleta: { id: l.atleta_id, nome: l.atleta_nome },
  tipo: l.tipo,
  descricao: l.descricao,
  status: l.status,
  criadoEm: iso(l.criado_em),
  resposta: l.resposta,
  respondidoEm: l.respondido_em ? iso(l.respondido_em) : null,
});

export async function rotasTitular(app: FastifyInstance): Promise<void> {
  const rotas = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  rotas.get(
    "/meus-dados",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["titular"],
        summary: "Exporta em JSON tudo o que o sistema guarda sobre o atleta (LGPD)",
        description:
          "Devolve como anexo (meus-dados-scout-vela.json): cadastro, consentimentos, notas com evidência e avaliador, respostas, medidas, resultados, decisões de gate, financeiro, pedidos de revisão e pedidos do titular. Só o atleta logado, só os próprios dados.",
        security: seguranca,
        response: { 200: esquemaExportacao, 401: esquemaErro, 403: esquemaErro, 404: esquemaErro },
      },
    },
    async (req, reply) => {
      const usuario = req.usuario;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const id = usuario.atletaId;
      const q = <T>(sql: string) => app.db.query<T>(sql, [id]).then((r) => r.rows);

      const [cadastro, consentimentos, notas, respostas, medidas, resultados, gates, financeiro, componentes, revisoes, pedidos] =
        await Promise.all([
          q<Record<string, unknown>>(
            `select a.velaid_codigo as "velaid", a.nome, a.genero, a.data_nascimento::text as "dataNascimento",
                    c.nome as classe, c.evento as "classeEvento", a.clube, a.cidade, a.uf, a.numero_vela as "numeroVela",
                    a.ws_id as "wsId", a.email_contato as "emailContato", t.nome as treinador, a.ativo,
                    a.criado_em as "criadoEm"
               from atletas a join classes c on c.id = a.classe_id left join usuarios t on t.id = a.treinador_id
              where a.id = $1::uuid`,
          ),
          q<Record<string, unknown>>(
            `select tipo, concedido, versao_termo as "versaoTermo", registrado_em as "registradoEm"
               from consentimentos where atleta_id = $1::uuid order by registrado_em, id`,
          ),
          q<Record<string, unknown>>(
            `select i.nome as indicador, n.valor, n.evidencia, n.origem, u.nome as avaliador,
                    ci.nome as ciclo, n.lancado_em as "lancadoEm"
               from avaliacoes n join indicadores i on i.id = n.indicador_id
               left join usuarios u on u.id = n.avaliador_id
               left join ciclos_avaliacao ci on ci.id = n.ciclo_id
              where n.atleta_id = $1::uuid order by n.lancado_em, n.id`,
          ),
          q<Record<string, unknown>>(
            `select i.nome as indicador, r.resposta, r.respondido_em as "respondidoEm"
               from respostas_atleta r join indicadores i on i.id = r.indicador_id
              where r.atleta_id = $1::uuid order by r.respondido_em, r.id`,
          ),
          q<Record<string, unknown>>(
            `select m.peso_kg::float8 as "pesoKg", m.altura_cm::float8 as "alturaCm", m.medido_em as "medidoEm",
                    m.evidencia, u.nome as "registradoPor"
               from medidas_corporais m join usuarios u on u.id = m.registrado_por
              where m.atleta_id = $1::uuid order by m.medido_em, m.id`,
          ),
          q<Record<string, unknown>>(
            `select data::text as data, nivel, evento, posicao, tamanho_frota as "tamanhoFrota", internacional,
                    pontos_cbvela::float8 as "pontosCbvela", fonte, link_oficial as "linkOficial"
               from resultados_regata where atleta_id = $1::uuid order by data, id`,
          ),
          q<Record<string, unknown>>(
            `select g.gate, g.status, g.justificativa, u.nome as "decididoPor", g.decidido_em as "decididoEm"
               from gates_decisoes g join usuarios u on u.id = g.decidido_por
              where g.atleta_id = $1::uuid order by g.decidido_em, g.id`,
          ),
          q<Record<string, unknown> & { id: string }>(
            `select f.id::text as id, f.perfil_suporte as "perfilSuporte", f.meses_assegurados as "mesesAssegurados",
                    f.patrocinio_privado as "patrocinioPrivado", u.nome as "informadoPor", f.informado_em as "informadoEm"
               from financeiro_campanha f join usuarios u on u.id = f.informado_por
              where f.atleta_id = $1::uuid order by f.informado_em, f.id`,
          ),
          q<{ financeiro_id: string; nome: string; autonomia: string; apoio_cbvela: string }>(
            `select fc.financeiro_id::text as financeiro_id, c.nome, fc.autonomia, fc.apoio_cbvela
               from financeiro_componentes fc
               join financeiro_campanha f on f.id = fc.financeiro_id
               join componentes_custo c on c.id = fc.componente_id
              where f.atleta_id = $1::uuid order by c.ordem`,
          ),
          q<Record<string, unknown>>(
            `select r.pilar_id as "pilarId", r.indicador_id as "indicadorId", r.motivo, r.status, r.resposta,
                    r.criado_em as "criadoEm", r.respondido_em as "respondidoEm"
               from pedidos_revisao r where r.atleta_id = $1::uuid order by r.criado_em, r.id`,
          ),
          q<Record<string, unknown>>(
            `select tipo, descricao, status, resposta, criado_em as "criadoEm", respondido_em as "respondidoEm"
               from pedidos_titular where atleta_id = $1::uuid order by criado_em, id`,
          ),
        ]);
      if (!cadastro[0]) throw naoEncontrado("Atleta não encontrado.");

      const financeiroComComponentes = financeiro.map(({ id: fid, ...resto }) => ({
        ...resto,
        componentes: componentes
          .filter((c) => c.financeiro_id === fid)
          .map((c) => ({ nome: c.nome, autonomia: c.autonomia, apoioCbvela: c.apoio_cbvela })),
      }));

      await auditar(app.db, usuario.id, "exportar_dados", "atletas", id, {});
      reply.header("Content-Disposition", 'attachment; filename="meus-dados-scout-vela.json"');
      return {
        geradoEm: app.agora().toISOString(),
        conta: { nome: usuario.nome, email: usuario.email, papel: usuario.papel },
        atleta: cadastro[0],
        consentimentos,
        notas,
        respostas,
        medidas,
        resultados,
        gates,
        financeiro: financeiroComComponentes,
        pedidosRevisao: revisoes,
        pedidosTitular: pedidos,
      };
    },
  );

  rotas.post(
    "/pedidos-titular",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["titular"],
        summary: "Registra um pedido do titular (acesso, correção, exclusão ou revogação)",
        description:
          "O pedido fica aberto até o gestor responder. Exclusão e revogação são tratadas manualmente pelo gestor, fora da API.",
        security: seguranca,
        body: z.object({
          tipo: z.enum(tiposPedido),
          descricao: z.string().trim().min(10, "A descrição precisa ter ao menos 10 caracteres.").max(2000),
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
      const { tipo, descricao } = req.body;
      const id = await app.db.transacao(async (tx) => {
        const r = await tx.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por, criado_em)
           values ($1::uuid, $2, $3, $4::uuid, $5) returning id::text as id`,
          [atletaId, tipo, descricao, usuario.id, app.agora()],
        );
        const novo = r.rows[0]!.id;
        await auditar(tx, usuario.id, "pedir_titular", "pedidos_titular", novo, { tipo });
        return novo;
      });
      return reply.code(201).send({ id, status: "aberto" as const });
    },
  );

  rotas.get(
    "/pedidos-titular",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "atleta")],
      schema: {
        tags: ["titular"],
        summary: "Lista pedidos do titular (gestor: todos, abertos primeiro; atleta: os seus)",
        security: seguranca,
        response: { 200: z.array(esquemaPedido), 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const usuario = req.usuario;
      const proprio = usuario.papel === "atleta";
      if (proprio && !usuario.atletaId) return [];
      const r = await app.db.query<LinhaPedido>(
        `${SQL_PEDIDO}
          ${proprio ? "where p.atleta_id = $1::uuid" : ""}
          order by (p.status = 'aberto') desc, p.criado_em desc, p.id desc`,
        proprio ? [usuario.atletaId] : [],
      );
      return r.rows.map(paraPedido);
    },
  );

  rotas.put(
    "/pedidos-titular/:id",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["titular"],
        summary: "Responde um pedido do titular",
        description:
          "Registra a resposta e fecha o pedido. A exclusão de dados NÃO é feita por esta rota: é procedimento manual do gestor, porque a série histórica (notas, respostas, medidas, gates, financeiro) só aceita inserção. Pedido já respondido devolve 409 (código requisicao_invalida).",
        security: seguranca,
        params: z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") }),
        body: z.object({ resposta: z.string().trim().min(3, "A resposta precisa ter ao menos 3 caracteres.").max(2000) }),
        response: {
          200: esquemaPedido,
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
          `update pedidos_titular
              set status = 'respondido', resposta = $2, respondido_por = $3::uuid, respondido_em = $4
            where id = $1::bigint and status = 'aberto'
        returning id`,
          [id, req.body.resposta, usuario.id, app.agora()],
        );
        if (r.rows.length === 0) {
          const existe = await tx.query(`select 1 from pedidos_titular where id = $1::bigint`, [id]);
          if (existe.rows.length === 0) throw naoEncontrado("Pedido não encontrado.");
          throw conflito("Este pedido já foi respondido.");
        }
        await auditar(tx, usuario.id, "responder_titular", "pedidos_titular", id, {});
      });
      const r = await app.db.query<LinhaPedido>(`${SQL_PEDIDO} where p.id = $1::bigint`, [id]);
      return paraPedido(r.rows[0]!);
    },
  );
}

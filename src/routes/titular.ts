import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalida } from "../erros.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import { caminhoDaFotoDoAtleta, linkDaFoto } from "../servicos/foto-perfil.js";

/**
 * Direitos do titular (LGPD, art. 18) para o atleta: exportar os próprios dados e
 * pedir acesso, correção, exclusão ou revogação. A exclusão é atendida pela anonimização (`POST /atletas/:id/anonimizar`),
 * porque a série histórica só aceita inserção.
 */

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

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
  anonimizacao: z
    .object({
      em: z.string().describe("Instante ISO da anonimização"),
      pendencias: z.object({
        arquivos: z.number().int().describe("Arquivos do Storage que ainda não saíram"),
        conta: z.boolean().describe("Conta de login (Supabase Auth) ainda não removida"),
      }),
    })
    .nullable()
    .describe(
      "Só nos pedidos de exclusão que anonimizaram o atleta: quando e o que ainda falta limpar. Nulo nos demais.",
    ),
});

const registros = z.array(z.record(z.string(), z.unknown()));

const esquemaExportacao = z.object({
  geradoEm: z.string(),
  conta: z.object({ nome: z.string(), email: z.string(), papel: z.string() }),
  atleta: z.record(z.string(), z.unknown()),
  consentimentos: registros.describe(
    "Histórico de decisões (termo do piloto e compartilhamento com o IBVAR)",
  ),
  notas: registros.describe(
    "Série histórica: valor, evidência, data e avaliador de cada lançamento",
  ),
  respostas: registros.describe("Respostas do questionário (série histórica)"),
  medidas: registros,
  resultados: registros,
  gates: registros.describe("Decisões do gestor sobre os gates"),
  financeiro: registros.describe(
    "Histórico do financeiro da campanha, com os componentes de cada lançamento",
  ),
  pedidosRevisao: registros,
  pedidosTitular: registros,
  foto: z
    .object({
      tipoMime: z.string(),
      url: z
        .string()
        .nullable()
        .describe("Link assinado de 5 minutos para baixar a foto; nulo se o Storage não respondeu"),
    })
    .nullable()
    .describe("Foto de perfil da conta do atleta (o caminho interno não é exportado)"),
  evidencias: registros.describe(
    "Evidências anexadas: id, nomeArquivo, tipoMime, tamanhoBytes, enviadoEm, indicador, enviadoPor, removida e removidoEm (o arquivo não vai no JSON; o link de cada um sai por GET /evidencias/{id}/link)",
  ),
  plano: registros.describe(
    "Plano individual: todas as versões registradas, da mais antiga para a mais nova",
  ),
});

async function auditar(
  db: Db,
  em: Date,
  usuarioId: string,
  acao: string,
  entidade: string,
  entidadeId: string | null,
  detalhes: Record<string, unknown>,
): Promise<void> {
  await db.query(
    `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em) values ($1, $2, $3, $4, $5::jsonb, $6)`,
    [usuarioId, acao, entidade, entidadeId, JSON.stringify(detalhes), em],
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
  /** Instante da anonimização, só se ESTE pedido foi o que anonimizou o atleta. */
  anonimizado_em: Date | null;
}

const SQL_PEDIDO = `select p.id::text as id, p.atleta_id, a.nome as atleta_nome, p.tipo, p.descricao,
         p.status, p.criado_em, p.resposta, p.respondido_em,
         case when a.anonimizado_pedido_id = p.id then a.anonimizado_em end as anonimizado_em
    from pedidos_titular p join atletas a on a.id = p.atleta_id`;

interface Pendencias {
  arquivos: number;
  conta: boolean;
}

/**
 * O que ainda falta limpar depois da anonimização, pelo estado do banco: arquivos que a remoção não
 * conseguiu apagar (`arquivos_pendentes`, sob a pasta do atleta ou da foto da conta), foto de perfil
 * ainda registrada e conta de login em `anonimizacoes_pendentes`. Não consulta o Storage.
 */
async function pendenciasDaAnonimizacao(
  db: Db,
  atletaIds: string[],
): Promise<Map<string, Pendencias>> {
  const mapa = new Map<string, Pendencias>();
  if (atletaIds.length === 0) return mapa;
  const r = await db.query<{ atleta_id: string; arquivos: string; conta: boolean }>(
    `select a.id::text as atleta_id,
            (select count(*) from (
               select p.caminho from arquivos_pendentes p
                where left(p.caminho, 37) = a.id::text || '/'
               union
               select p.caminho from arquivos_pendentes p
                 join usuarios u on u.atleta_id = a.id
                where left(p.caminho, 43) = 'fotos/' || u.id::text || '/'
               union
               select u.foto_caminho from usuarios u
                where u.atleta_id = a.id and u.foto_caminho is not null
             ) x)::text as arquivos,
            exists (select 1 from anonimizacoes_pendentes ap where ap.atleta_id = a.id) as conta
       from atletas a where a.id = any($1::uuid[])`,
    [atletaIds],
  );
  for (const l of r.rows) {
    mapa.set(l.atleta_id, { arquivos: Number(l.arquivos), conta: l.conta });
  }
  return mapa;
}

async function carregarPedidos(db: Db, filtro: string, params: unknown[]) {
  const r = await db.query<LinhaPedido>(
    `${SQL_PEDIDO} ${filtro}
      order by (p.status = 'aberto') desc, p.criado_em desc, p.id desc`,
    params,
  );
  const anonimizados = [...new Set(r.rows.filter((l) => l.anonimizado_em).map((l) => l.atleta_id))];
  const pendencias = await pendenciasDaAnonimizacao(db, anonimizados);
  return r.rows.map((l) => paraPedido(l, pendencias.get(l.atleta_id)));
}

const paraPedido = (l: LinhaPedido, pendencias?: Pendencias) => ({
  id: l.id,
  atleta: { id: l.atleta_id, nome: l.atleta_nome },
  tipo: l.tipo,
  descricao: l.descricao,
  status: l.status,
  criadoEm: iso(l.criado_em),
  resposta: l.resposta,
  respondidoEm: l.respondido_em ? iso(l.respondido_em) : null,
  anonimizacao: l.anonimizado_em
    ? {
        em: iso(l.anonimizado_em),
        pendencias: pendencias ?? { arquivos: 0, conta: false },
      }
    : null,
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
          "Devolve como anexo (meus-dados-scout-vela.json): cadastro, consentimentos, notas com evidência e avaliador, respostas, medidas, resultados, decisões de gate, financeiro, pedidos de revisão e pedidos do titular, foto de perfil (tipo e link de 5 minutos), lista de evidências anexadas (metadados, sem o arquivo) e plano individual (todas as versões). Só o atleta logado, só os próprios dados.",
        security: seguranca,
        response: { 200: esquemaExportacao, 401: esquemaErro, 403: esquemaErro, 404: esquemaErro },
      },
    },
    async (req, reply) => {
      const usuario = req.usuario;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const id = usuario.atletaId;
      const q = <T>(sql: string) => app.db.query<T>(sql, [id]).then((r) => r.rows);

      const [
        cadastro,
        consentimentos,
        notas,
        respostas,
        medidas,
        resultados,
        gates,
        financeiro,
        componentes,
        revisoes,
        pedidos,
        evidencias,
        plano,
        caminhoFoto,
      ] = await Promise.all([
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
        q<Record<string, unknown>>(
          `select e.id, e.nome_arquivo as "nomeArquivo", e.tipo_mime as "tipoMime", e.tamanho_bytes as "tamanhoBytes",
                    e.enviado_em as "enviadoEm", i.nome as indicador, u.nome as "enviadoPor",
                    (e.removido_em is not null) as removida, e.removido_em as "removidoEm"
               from evidencias_anexos e
               left join indicadores i on i.id = e.indicador_id
               left join usuarios u on u.id = e.enviado_por
              where e.atleta_id = $1::uuid order by e.enviado_em, e.id`,
        ),
        q<Record<string, unknown>>(
          `select p.forcas, p.lacunas, p.meta_12m as "meta12m", p.meta_24m as "meta24m", p.recomendacao,
                    u.nome as "registradoPor", p.registrado_em as "registradoEm"
               from plano_individual p join usuarios u on u.id = p.registrado_por
              where p.atleta_id = $1::uuid order by p.registrado_em, p.id`,
        ),
        caminhoDaFotoDoAtleta(app.db, id),
      ]);
      if (!cadastro[0]) throw naoEncontrado("Atleta não encontrado.");

      const financeiroComComponentes = financeiro.map(({ id: fid, ...resto }) => ({
        ...resto,
        componentes: componentes
          .filter((c) => c.financeiro_id === fid)
          .map((c) => ({ nome: c.nome, autonomia: c.autonomia, apoioCbvela: c.apoio_cbvela })),
      }));

      await auditar(app.db, app.agora(), usuario.id, "exportar_dados", "atletas", id, {});
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
        foto: caminhoFoto
          ? {
              tipoMime: caminhoFoto.endsWith(".png") ? "image/png" : "image/jpeg",
              url: await linkDaFoto(app.armazenamento, caminhoFoto, req.log),
            }
          : null,
        evidencias,
        plano,
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
          "O pedido fica aberto até o gestor responder. Revogação é tratada pelo gestor; a exclusão é atendida pela anonimização (`POST /atletas/{id}/anonimizar`).",
        security: seguranca,
        body: z.object({
          tipo: z.enum(tiposPedido),
          descricao: z
            .string()
            .trim()
            .min(10, "A descrição precisa ter ao menos 10 caracteres.")
            .max(2000),
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
        await travarAtletaEditavel(tx, atletaId);
        const r = await tx.query<{ id: string }>(
          `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por, criado_em)
           values ($1::uuid, $2, $3, $4::uuid, $5) returning id::text as id`,
          [atletaId, tipo, descricao, usuario.id, app.agora()],
        );
        const novo = r.rows[0]!.id;
        await auditar(tx, app.agora(), usuario.id, "pedir_titular", "pedidos_titular", novo, {
          tipo,
        });
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
      return carregarPedidos(
        app.db,
        proprio ? "where p.atleta_id = $1::uuid" : "",
        proprio ? [usuario.atletaId] : [],
      );
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
          "Registra a resposta e fecha o pedido. Pedido de exclusão NÃO é fechado por aqui: devolve 409 apontando para `POST /atletas/{id}/anonimizar`, que anonimiza o atleta e responde o pedido. Única exceção: a recusa formal, `{ resposta, recusar: true }`, com justificativa de ao menos 20 caracteres; fecha o pedido sem anonimizar e fica na auditoria como `recusar_exclusao`. `recusar` só vale para pedido de exclusão (400 nos demais). Pedido já respondido devolve 409 (código requisicao_invalida).",
        security: seguranca,
        params: z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") }),
        body: z.object({
          resposta: z
            .string()
            .trim()
            .min(3, "A resposta precisa ter ao menos 3 caracteres.")
            .max(2000),
          recusar: z
            .boolean()
            .optional()
            .describe(
              "Só para pedido de exclusão: recusa formal, com justificativa de ao menos 20 caracteres. Sem isto, o pedido de exclusão é atendido pela anonimização.",
            ),
        }),
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
      const recusar = req.body.recusar === true;
      await app.db.transacao(async (tx) => {
        const atual = await tx.query<{ tipo: string; status: string }>(
          `select tipo, status from pedidos_titular where id = $1::bigint for update`,
          [id],
        );
        const pedido = atual.rows[0];
        if (!pedido) throw naoEncontrado("Pedido não encontrado.");
        if (pedido.status !== "aberto") throw conflito("Este pedido já foi respondido.");
        if (recusar && pedido.tipo !== "exclusao") {
          throw requisicaoInvalida("A recusa formal vale só para pedido de exclusão.");
        }
        if (pedido.tipo === "exclusao") {
          if (!recusar) {
            throw conflito(
              "Pedido de exclusão não se responde por aqui: use POST /atletas/{id}/anonimizar, que anonimiza o atleta e responde o pedido. Para recusar formalmente, envie recusar: true com a justificativa (ao menos 20 caracteres).",
            );
          }
          if (req.body.resposta.length < 20) {
            throw requisicaoInvalida(
              "A recusa de um pedido de exclusão precisa de justificativa com ao menos 20 caracteres.",
            );
          }
        }
        const r = await tx.query<{ atleta_id: string }>(
          `update pedidos_titular
              set status = 'respondido', resposta = $2, respondido_por = $3::uuid, respondido_em = $4
            where id = $1::bigint and status = 'aberto'
        returning atleta_id`,
          [id, req.body.resposta, usuario.id, app.agora()],
        );
        if (r.rows.length === 0) {
          const existe = await tx.query(`select 1 from pedidos_titular where id = $1::bigint`, [
            id,
          ]);
          if (existe.rows.length === 0) throw naoEncontrado("Pedido não encontrado.");
          throw conflito("Este pedido já foi respondido.");
        }
        // Atleta anonimizado: nada mais é gravado (a resposta da exclusão já ficou na anonimização).
        await travarAtletaEditavel(tx, r.rows[0]!.atleta_id);
        await auditar(
          tx,
          app.agora(),
          usuario.id,
          recusar ? "recusar_exclusao" : "responder_titular",
          "pedidos_titular",
          id,
          {},
        );
      });
      const [pedido] = await carregarPedidos(app.db, "where p.id = $1::bigint", [id]);
      return pedido!;
    },
  );
}

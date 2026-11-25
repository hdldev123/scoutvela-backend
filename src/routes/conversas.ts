import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel, limitePorIp } from "../auth/plugin.js";
import {
  conflito,
  esquemaErro,
  naoEncontrado,
  requisicaoInvalida,
  requisicaoInvalidaCampos,
  semAcesso,
} from "../erros.js";
import {
  HORAS_SUPERVISAO,
  LIMITE_MENSAGENS_POR_MINUTO,
  TAMANHO_MAX_MENSAGEM,
  TIPOS_CONVERSA,
  avisarMensagemNova,
  buscarConversaAcessivel,
  inserirMensagem,
  listarConversas,
  listarConversasParaSupervisao,
  listarMensagens,
  marcarConversaLida,
  tipoDaConversa,
  type LinhaConversa,
  type TipoConversa,
} from "../repositories/conversas.js";
import type { Db } from "../db/db.js";
import type { UsuarioAutenticado } from "../auth/plugin.js";

const esquemaConversa = z.object({
  id: z.uuid(),
  tipo: z.enum(TIPOS_CONVERSA),
  com: z
    .union([
      z.object({ nome: z.string(), papel: z.enum(["atleta", "treinador"]) }),
      z.object({ gestao: z.literal(true) }),
    ])
    .describe(
      "Com quem a pessoa conversa: o outro lado (nome e papel) ou `{ gestao: true }` (caixa compartilhada da gestão da CBVela)",
    ),
  atleta: z.object({ id: z.string(), nome: z.string() }).nullable(),
  treinador: z
    .object({ id: z.string(), nome: z.string() })
    .nullable()
    .describe("Treinador do par (tipos `treinador_atleta` e `gestao_treinador`)"),
  criadaEm: z.string().describe("Instante ISO"),
  ultimaMensagemEm: z.string().nullable().describe("Instante ISO; nulo = ainda sem mensagens"),
  naoLidas: z.number().int().min(0),
  somenteLeitura: z
    .boolean()
    .describe(
      "Verdadeiro quando não dá para enviar: par antigo (troca de treinador), conta desativada ou gestor lendo por supervisão",
    ),
  supervisaoAte: z
    .string()
    .nullable()
    .describe("Só para o gestor: até quando vale o acesso de supervisão dele; nulo = sem acesso"),
});

const esquemaMensagem = z.object({
  id: z.string(),
  autor: z.object({ nome: z.string(), papel: z.string() }),
  propria: z.boolean().describe("Verdadeiro quando quem chama é o autor"),
  texto: z.string().describe("Texto puro: o front escapa, nunca monta HTML"),
  enviadaEm: z.string().describe("Instante ISO"),
});

const idConversa = z.object({ id: z.uuid("Identificador inválido.") });

function paraItem(l: LinhaConversa, usuario: Pick<UsuarioAutenticado, "papel">) {
  const atleta = l.atleta_id ? { id: l.atleta_id, nome: l.atleta_nome ?? "" } : null;
  const treinador = l.treinador_id ? { id: l.treinador_id, nome: l.treinador_nome ?? "" } : null;
  let com: z.infer<typeof esquemaConversa>["com"];
  if (l.tipo === "treinador_atleta") {
    com =
      usuario.papel === "atleta"
        ? { nome: l.treinador_nome ?? "", papel: "treinador" }
        : { nome: l.atleta_nome ?? "", papel: "atleta" };
  } else if (usuario.papel === "gestor") {
    com =
      l.tipo === "gestao_atleta"
        ? { nome: l.atleta_nome ?? "", papel: "atleta" }
        : { nome: l.treinador_nome ?? "", papel: "treinador" };
  } else {
    com = { gestao: true };
  }
  return {
    id: l.id,
    tipo: l.tipo,
    com,
    atleta,
    treinador,
    criadaEm: new Date(l.criada_em).toISOString(),
    ultimaMensagemEm: l.ultima_mensagem_em ? new Date(l.ultima_mensagem_em).toISOString() : null,
    naoLidas: Number(l.nao_lidas),
    somenteLeitura: l.somente_leitura,
    supervisaoAte: l.supervisao_ate ? new Date(l.supervisao_ate).toISOString() : null,
  };
}

const SEM_PERMISSAO = "Você não pode abrir esta conversa.";

/**
 * Quem pode abrir conversa com quem (a regra fica no SQL: o atleta só com o treinador vigente, o treinador
 * só com atleta próprio e ativo, o gestor com qualquer atleta ou treinador ativo). Devolve os ids do par.
 */
async function resolverPar(
  db: Db,
  usuario: UsuarioAutenticado,
  corpo: { tipo: TipoConversa; atletaId?: string | undefined; treinadorId?: string | undefined },
): Promise<{ atletaId: string | null; treinadorId: string | null }> {
  const { tipo } = corpo;
  const faltou = (campo: string) =>
    requisicaoInvalidaCampos([{ campo, mensagem: "Informe com quem abrir a conversa." }]);
  const papel = usuario.papel;

  if (tipo === "treinador_atleta") {
    if (papel === "atleta") {
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      if (corpo.atletaId && corpo.atletaId !== usuario.atletaId) throw semAcesso(SEM_PERMISSAO);
      const r = await db.query<{ treinador_id: string }>(
        `select a.treinador_id::text as treinador_id from atletas a
           join usuarios t on t.id = a.treinador_id and t.ativo
          where a.id = $1::uuid and a.ativo`,
        [usuario.atletaId],
      );
      const t = r.rows[0]?.treinador_id;
      if (!t) throw naoEncontrado("Você ainda não tem um treinador vinculado.");
      if (corpo.treinadorId && corpo.treinadorId !== t) throw semAcesso(SEM_PERMISSAO);
      return { atletaId: usuario.atletaId, treinadorId: t };
    }
    if (papel === "treinador") {
      if (!corpo.atletaId) throw faltou("atletaId");
      const r = await db.query(
        `select 1 from atletas where id = $1::uuid and treinador_id = $2::uuid and ativo`,
        [corpo.atletaId, usuario.id],
      );
      if (r.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
      return { atletaId: corpo.atletaId, treinadorId: usuario.id };
    }
    throw semAcesso(SEM_PERMISSAO);
  }

  if (tipo === "gestao_atleta") {
    if (papel === "atleta") {
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      if (corpo.atletaId && corpo.atletaId !== usuario.atletaId) throw semAcesso(SEM_PERMISSAO);
      const r = await db.query(`select 1 from atletas where id = $1::uuid and ativo`, [
        usuario.atletaId,
      ]);
      if (r.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
      return { atletaId: usuario.atletaId, treinadorId: null };
    }
    if (papel === "gestor") {
      if (!corpo.atletaId) throw faltou("atletaId");
      const r = await db.query(`select 1 from atletas where id = $1::uuid and ativo`, [
        corpo.atletaId,
      ]);
      if (r.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
      return { atletaId: corpo.atletaId, treinadorId: null };
    }
    throw semAcesso(SEM_PERMISSAO);
  }

  // gestao_treinador
  if (papel === "treinador") {
    if (corpo.treinadorId && corpo.treinadorId !== usuario.id) throw semAcesso(SEM_PERMISSAO);
    return { atletaId: null, treinadorId: usuario.id };
  }
  if (papel === "gestor") {
    if (!corpo.treinadorId) throw faltou("treinadorId");
    const r = await db.query(
      `select 1 from usuarios where id = $1::uuid and papel = 'treinador' and ativo`,
      [corpo.treinadorId],
    );
    if (r.rows.length === 0) throw naoEncontrado("Treinador não encontrado.");
    return { atletaId: null, treinadorId: corpo.treinadorId };
  }
  throw semAcesso(SEM_PERMISSAO);
}

export async function rotasConversas(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];
  const quemConversa = () => exigirPapel("gestor", "treinador", "atleta");
  const limiteIp = limitePorIp(app);

  async function auditar(
    db: Db,
    usuarioId: string,
    acao: string,
    entidadeId: string,
    detalhes: Record<string, unknown>,
  ): Promise<void> {
    // Nunca o texto das mensagens: só ids e tipo (o motivo da supervisão é justificativa do gestor).
    await db.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
       values ($1::uuid, $2, 'conversas', $3, $4::jsonb, $5)`,
      [usuarioId, acao, entidadeId, JSON.stringify(detalhes), app.agora()],
    );
  }

  r.get(
    "/conversas",
    {
      preHandler: [app.autenticar, quemConversa()],
      schema: {
        tags: ["conversas"],
        summary: "Minhas conversas (chat), da mais recente para a mais antiga",
        description:
          "Gestor, treinador e atleta; IBVAR: 403. Atleta: a conversa com o treinador atual, as de treinadores antigos (somente leitura) e a com a gestão. Treinador: as com os próprios atletas, as de pares antigos (somente leitura) e a com a gestão. Gestor: as caixas compartilhadas `gestao_atleta` e `gestao_treinador` (todos os gestores ativos veem e respondem; `naoLidas` é por gestor). `naoLidas` conta as mensagens de outras pessoas depois de PUT /conversas/{id}/lidas. Com `?supervisao=true` (só gestor; outros 403): as conversas `treinador_atleta` só com metadados (participantes e datas; `naoLidas` sempre 0, sem trecho nem contagem de mensagens), para o gestor saber que existem; a leitura exige POST /conversas/{id}/acesso-supervisao.",
        security: seguranca,
        querystring: z.object({ supervisao: z.enum(["true", "false"]).optional() }),
        response: {
          200: z.object({ itens: z.array(esquemaConversa) }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      if (req.query.supervisao === "true") {
        if (usuario.papel !== "gestor") throw semAcesso();
        const linhas = await listarConversasParaSupervisao(app.db, usuario, app.agora());
        return { itens: linhas.map((l) => paraItem(l, usuario)) };
      }
      const linhas = await listarConversas(app.db, usuario, app.agora());
      return { itens: linhas.map((l) => paraItem(l, usuario)) };
    },
  );

  r.post(
    "/conversas",
    {
      preHandler: [app.autenticar, quemConversa()],
      schema: {
        tags: ["conversas"],
        summary: "Abre uma conversa (ou devolve a que já existe)",
        description:
          "`tipo`: `treinador_atleta`, `gestao_atleta` ou `gestao_treinador`. Quem pode abrir com quem (regra no SQL): o atleta abre `treinador_atleta` com o próprio treinador atual e `gestao_atleta` (`atletaId` e `treinadorId` são dispensáveis; apontar outra pessoa dá 403); o treinador abre `treinador_atleta` com atleta próprio e ativo (`atletaId` obrigatório; de outro treinador, 404) e `gestao_treinador`; o gestor abre `gestao_atleta` com qualquer atleta ativo (`atletaId`) e `gestao_treinador` com qualquer treinador ativo (`treinadorId`), e não abre `treinador_atleta` (403). Atleta com atleta não existe; IBVAR: 403. Há uma conversa por par, uma `gestao_atleta` por atleta e uma `gestao_treinador` por treinador: se já existe, devolve a existente com 200; se criou, 201. Auditoria `abrir_conversa` só com ids e tipo.",
        security: seguranca,
        body: z
          .object({
            tipo: z.enum(TIPOS_CONVERSA, "Informe o tipo da conversa."),
            atletaId: z.uuid("Identificador do atleta inválido.").optional(),
            treinadorId: z.uuid("Identificador do treinador inválido.").optional(),
          })
          .strict(),
        response: {
          200: esquemaConversa,
          201: esquemaConversa,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const par = await resolverPar(app.db, usuario, body);
      const agora = app.agora();
      const { id, criada } = await app.db.transacao(async (tx) => {
        const ins = await tx.query<{ id: string }>(
          `insert into conversas (tipo, atleta_id, treinador_id, criada_em)
           values ($1, $2::uuid, $3::uuid, $4::timestamptz)
           on conflict do nothing returning id::text as id`,
          [body.tipo, par.atletaId, par.treinadorId, agora],
        );
        if (ins.rows[0]) {
          await auditar(tx, usuario.id, "abrir_conversa", ins.rows[0].id, { tipo: body.tipo });
          return { id: ins.rows[0].id, criada: true };
        }
        const ex = await tx.query<{ id: string }>(
          `select id::text as id from conversas
            where tipo = $1 and atleta_id is not distinct from $2::uuid
              and treinador_id is not distinct from $3::uuid`,
          [body.tipo, par.atletaId, par.treinadorId],
        );
        return { id: ex.rows[0]!.id, criada: false };
      });
      const linha = await buscarConversaAcessivel(app.db, usuario, id, agora);
      if (!linha) throw naoEncontrado("Conversa não encontrada.");
      return reply.code(criada ? 201 : 200).send(paraItem(linha, usuario));
    },
  );

  r.get(
    "/conversas/:id/mensagens",
    {
      preHandler: [app.autenticar, quemConversa()],
      schema: {
        tags: ["conversas"],
        summary: "Mensagens de uma conversa, em ordem cronológica",
        description:
          "Só as partes da conversa; o gestor lê uma `treinador_atleta` só com supervisão vigente (POST /conversas/{id}/acesso-supervisao); sem acesso, 404 (não revela que a conversa existe). Sem filtros: as `limite` mais recentes. `antesDe` (instante ISO): as mensagens anteriores a ele, para rolar o histórico (`proximoAntesDe` da resposta anterior). `depoisDe` (instante ISO): só as mais novas, para consulta a cada 15 a 30 segundos. `propria` é verdadeiro nas mensagens de quem chama. O texto é puro: o front escapa.",
        security: seguranca,
        params: idConversa,
        querystring: z.object({
          depoisDe: z.iso.datetime({ offset: true, error: "Data inválida." }).optional(),
          antesDe: z.iso.datetime({ offset: true, error: "Data inválida." }).optional(),
          limite: z.coerce.number().int().min(1).max(100).default(50),
        }),
        response: {
          200: z.object({
            itens: z.array(esquemaMensagem),
            proximoAntesDe: z
              .string()
              .nullable()
              .describe("Passe em `antesDe` para a página anterior; nulo = não há mais"),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      const conversa = await buscarConversaAcessivel(app.db, usuario, req.params.id, app.agora());
      if (!conversa) throw naoEncontrado("Conversa não encontrada.");
      const { depoisDe, antesDe, limite } = req.query;
      const { linhas, temMaisAntigas } = await listarMensagens(app.db, conversa.id, {
        limite,
        ...(depoisDe ? { depoisDe: new Date(depoisDe) } : {}),
        ...(antesDe ? { antesDe: new Date(antesDe) } : {}),
      });
      return {
        itens: linhas.map((m) => ({
          id: m.id,
          autor: { nome: m.autor_nome, papel: m.autor_papel },
          propria: m.autor_id === usuario.id,
          texto: m.texto,
          enviadaEm: new Date(m.enviada_em).toISOString(),
        })),
        proximoAntesDe:
          temMaisAntigas && linhas[0] ? new Date(linhas[0].enviada_em).toISOString() : null,
      };
    },
  );

  r.post(
    "/conversas/:id/mensagens",
    {
      // Limite por IP antes de autenticar; limite por usuário depois (401 não gasta a cota).
      onRequest: [limiteIp, app.autenticar],
      preHandler: [quemConversa()],
      config: {
        rateLimit: {
          max: LIMITE_MENSAGENS_POR_MINUTO,
          timeWindow: 60_000,
          hook: "preHandler",
          keyGenerator: (req) => `mensagens:${req.usuario.id}`,
        },
      },
      schema: {
        tags: ["conversas"],
        summary: "Envia uma mensagem",
        description: `Só quem é parte da conversa e ela não está somente leitura: par antigo (troca de treinador) ou conta desativada dão 409; o gestor lendo por supervisão não envia (403). Sem acesso à conversa, 404. \`texto\`: texto puro de 1 a ${TAMANHO_MAX_MENSAGEM} caracteres (sem HTML; o texto é guardado como veio e o front escapa). Limite de ${LIMITE_MENSAGENS_POR_MINUTO} mensagens por minuto por usuário (429 \`limite_excedido\`). Avisa o outro lado (\`mensagem_nova\`, \`referencia: { conversaId }\`), só se a pessoa ainda não tem aviso não lido desta conversa; na caixa compartilhada, avisa os gestores ativos. A auditoria guarda só ids e tipo, nunca o texto.`,
        security: seguranca,
        params: idConversa,
        body: z
          .object({
            texto: z
              .string("Escreva a mensagem.")
              .max(
                TAMANHO_MAX_MENSAGEM,
                `A mensagem pode ter no máximo ${TAMANHO_MAX_MENSAGEM} caracteres.`,
              )
              .refine((t) => t.trim().length >= 1, "Escreva a mensagem."),
          })
          .strict(),
        response: {
          201: esquemaMensagem,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
          429: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const agora = app.agora();
      const nova = await app.db.transacao(async (tx) => {
        const conversa = await buscarConversaAcessivel(tx, usuario, req.params.id, agora, {
          travar: true,
        });
        if (!conversa) throw naoEncontrado("Conversa não encontrada.");
        if (conversa.somente_leitura) {
          if (usuario.papel === "gestor" && conversa.tipo === "treinador_atleta") {
            throw semAcesso("Na supervisão o gestor só lê a conversa.");
          }
          throw conflito("Esta conversa está somente leitura.");
        }
        const id = await inserirMensagem(tx, conversa.id, usuario.id, body.texto, agora);
        await auditar(tx, usuario.id, "enviar_mensagem", conversa.id, {
          mensagemId: id,
          tipo: conversa.tipo,
        });
        await avisarMensagemNova(
          tx,
          {
            id: conversa.id,
            tipo: conversa.tipo,
            atleta_id: conversa.atleta_id,
            treinador_id: conversa.treinador_id,
          },
          usuario,
          agora,
        );
        return id;
      });
      return reply.code(201).send({
        id: nova,
        autor: { nome: usuario.nome, papel: usuario.papel },
        propria: true,
        texto: body.texto,
        enviadaEm: agora.toISOString(),
      });
    },
  );

  r.put(
    "/conversas/:id/lidas",
    {
      preHandler: [app.autenticar, quemConversa()],
      schema: {
        tags: ["conversas"],
        summary: "Marca a conversa como lida, até agora, para quem chama",
        description:
          "Vale só para quem chama (na caixa compartilhada, cada gestor tem a sua marca). Também marca como lidos os avisos `mensagem_nova` desta conversa. O gestor em supervisão não grava marca (204 sem efeito). Não gera auditoria (dado de interface).",
        security: seguranca,
        params: idConversa,
        response: {
          204: z.null(),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario } = req;
      const agora = app.agora();
      const conversa = await buscarConversaAcessivel(app.db, usuario, req.params.id, agora);
      if (!conversa) throw naoEncontrado("Conversa não encontrada.");
      if (!(usuario.papel === "gestor" && conversa.tipo === "treinador_atleta")) {
        await marcarConversaLida(app.db, usuario.id, conversa.id, agora);
      }
      return reply.code(204).send(null);
    },
  );

  r.post(
    "/conversas/:id/acesso-supervisao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["conversas"],
        summary: "Gestor pede acesso de leitura a uma conversa entre treinador e atleta",
        description: `Só o gestor, só conversas \`treinador_atleta\` (as outras dão 400; conversa inexistente, 404). \`motivo\` obrigatório, de 5 a 500 caracteres (ex.: denúncia). Libera a leitura daquela conversa, para aquele gestor, por ${HORAS_SUPERVISAO} horas (GET /conversas/{id}/mensagens); durante a supervisão ele só lê, não envia. Pedir de novo renova o prazo e registra outro acesso. Cada pedido vai para a auditoria (\`acessar_conversa_supervisao\`) com o motivo e sem o conteúdo das mensagens. Os participantes veem na tela que a conversa pode ser lida pelo gestor em caso de denúncia.`,
        security: seguranca,
        params: idConversa,
        body: z
          .object({
            motivo: z
              .string("Informe o motivo do acesso.")
              .trim()
              .min(5, "O motivo precisa ter ao menos 5 caracteres.")
              .max(500, "O motivo pode ter no máximo 500 caracteres."),
          })
          .strict(),
        response: {
          201: z.object({
            conversaId: z.uuid(),
            expiraEm: z.string().describe("Instante ISO: fim da leitura liberada"),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const tipo = await tipoDaConversa(app.db, req.params.id);
      if (!tipo) throw naoEncontrado("Conversa não encontrada.");
      if (tipo !== "treinador_atleta") {
        throw requisicaoInvalida(
          "Só as conversas entre treinador e atleta pedem acesso de supervisão.",
        );
      }
      const agora = app.agora();
      const expiraEm = new Date(agora.getTime() + HORAS_SUPERVISAO * 3_600_000);
      await app.db.transacao(async (tx) => {
        await tx.query(
          `insert into acessos_supervisao (conversa_id, gestor_id, motivo, em, expira_em)
           values ($1::uuid, $2::uuid, $3, $4::timestamptz, $5::timestamptz)`,
          [req.params.id, usuario.id, body.motivo, agora, expiraEm],
        );
        await auditar(tx, usuario.id, "acessar_conversa_supervisao", req.params.id, {
          motivo: body.motivo,
          expiraEm: expiraEm.toISOString(),
        });
      });
      return reply.code(201).send({ conversaId: req.params.id, expiraEm: expiraEm.toISOString() });
    },
  );
}

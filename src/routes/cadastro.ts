import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { idadeEm, normalizarWsId, wsIdValido } from "../domain/index.js";
import { ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { ContaJaExiste } from "../integracoes/supabase-admin.js";
import { erroAtletaAnonimizado, recusarAtletaAnonimizado } from "../repositories/anonimizado.js";
import { listarAtletasGestao } from "../repositories/atletas.js";
import { buscarTermoVigente, termoAceitavel, termoSql } from "../repositories/termo.js";
import { ArquivoRejeitado, importarCsv } from "../importacao/index.js";

const IDADE_MINIMA_PILOTO = 18;
const CODIGO_VELAID = /^[A-Z]{2}-[A-Z0-9]{2,10}$/;

const MENSAGEM_WS_ID_INVALIDO =
  "ID World Sailing inválido. Use 3 letras do país seguidas de 2 a 12 letras ou números, por exemplo BRARB51.";
const MENSAGEM_WS_ID_DUPLICADO = "Já existe um atleta com este ID World Sailing.";

const requisicaoInvalida = (m: string) => new ErroApi(400, "requisicao_invalida", m);
/** Conflito de estado (já cadastrado, já aceito). Usa o código `requisicao_invalida` com status 409. */
const conflito = (m: string) => new ErroApi(409, "requisicao_invalida", m);

function normalizarCodigo(texto: string): string {
  const codigo = texto.trim().toUpperCase();
  if (!CODIGO_VELAID.test(codigo)) {
    throw requisicaoInvalida("Código VelaID inválido. Use o formato UF-XXXX, por exemplo MG-T15.");
  }
  return codigo;
}

function motivoMenor(nome: string, idade: number): string {
  return `Cadastro bloqueado: ${nome} tem ${idade} anos. O piloto aceita só 18+; a versão para menores, com responsável, está em desenho.`;
}

interface LinhaVelaId {
  codigo: string;
  nome: string;
  genero: "F" | "M";
  data_nascimento: string;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  ws_id: string | null;
  email: string | null;
}

const COLUNAS_VELAID_SQL =
  "codigo, nome, genero, data_nascimento::text as data_nascimento, clube, cidade, uf, ws_id, email";

const esquemaBusca = z.object({
  codigo: z
    .string()
    .max(40)
    .describe("Código VelaID (ex.: MG-T15); espaços e minúsculas são normalizados"),
});

const esquemaRespostaBusca = z.object({
  codigo: z.string(),
  nome: z.string(),
  genero: z.enum(["F", "M"]),
  dataNascimento: z.string().describe("AAAA-MM-DD"),
  idade: z.number().int(),
  clube: z.string().nullable(),
  cidade: z.string().nullable(),
  uf: z.string().nullable(),
  wsId: z.string().nullable(),
  jaNoPiloto: z.boolean(),
  elegivel: z.boolean(),
  motivo: z.string().nullable().describe("Por que não é elegível; nulo quando elegível"),
});

const esquemaCadastro = z.object({
  wsId: z
    .string()
    .max(40)
    .describe(
      "ID World Sailing (ex.: BRARB51). Vira maiúsculas e sem espaços; formato ^[A-Z]{3}[A-Z0-9]{2,12}$",
    ),
  email: z.email().max(254).describe("E-mail do atleta: conta de login, convite e termo"),
  classeId: z.string().min(1).max(40),
  treinadorId: z.uuid(),
  velaid: z
    .string()
    .max(40)
    .optional()
    .describe(
      "Código VelaID, opcional. Se existir em velaid_registros, os dados de lá viram sugestão para o atleta confirmar no primeiro acesso",
    ),
  confirmaMaioridade: z.literal(true, {
    error: "Confirme que o atleta tem 18 anos ou mais.",
  }),
  criarConta: z
    .boolean()
    .default(true)
    .describe("Cria a conta do atleta (papel atleta) e envia o convite"),
});

const esquemaImportacao = z.object({
  tipo: z.enum(["velaid", "ranking_cbvela"]),
  arquivoNome: z.string().max(200).optional(),
  conteudo: z
    .string()
    .min(1)
    .max(512 * 1024)
    .describe("CSV em texto (UTF-8), até 512 KB"),
});

const esquemaRespostaImportacao = z.object({
  id: z.number().int(),
  linhasOk: z.number().int(),
  linhasErro: z.number().int(),
  erros: z
    .array(z.object({ linha: z.number().int(), mensagem: z.string() }))
    .describe("Até 200 erros; linhasErro traz a contagem total"),
});

export async function rotasCadastro(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const soGestor = [app.autenticar, exigirPapel("gestor")];
  const seguranca = [{ bearerAuth: [] }];

  r.post(
    "/velaid/busca",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Busca um atleta no VelaID pelo código",
        description:
          "Não devolve e-mail. Menor de 18 anos e atleta já cadastrado vêm com elegivel=false e o motivo.",
        security: seguranca,
        body: esquemaBusca,
        response: {
          200: esquemaRespostaBusca,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const codigo = normalizarCodigo(req.body.codigo);
      const { rows } = await app.db.query<LinhaVelaId>(
        `select ${COLUNAS_VELAID_SQL} from velaid_registros where codigo = $1`,
        [codigo],
      );
      const v = rows[0];
      if (!v) throw naoEncontrado(`Nenhum atleta com o código ${codigo} no VelaID.`);

      const idade = idadeEm(v.data_nascimento, app.agora());
      const existente = await app.db.query("select 1 from atletas where velaid_codigo = $1", [
        codigo,
      ]);
      const jaNoPiloto = existente.rows.length > 0;
      let motivo: string | null = null;
      if (jaNoPiloto) motivo = `O código ${codigo} já está no piloto.`;
      else if (idade < IDADE_MINIMA_PILOTO) motivo = motivoMenor(v.nome, idade);

      return {
        codigo: v.codigo,
        nome: v.nome,
        genero: v.genero,
        dataNascimento: v.data_nascimento,
        idade,
        clube: v.clube,
        cidade: v.cidade,
        uf: v.uf,
        wsId: v.ws_id,
        jaNoPiloto,
        elegivel: motivo === null,
        motivo,
      };
    },
  );

  r.get(
    "/treinadores",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Treinadores ativos (para escolher o responsável no cadastro)",
        security: seguranca,
        response: {
          200: z.array(z.object({ id: z.string(), nome: z.string() })),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async () => {
      const { rows } = await app.db.query<{ id: string; nome: string }>(
        "select id, nome from usuarios where papel = 'treinador' and ativo order by nome",
      );
      return rows;
    },
  );

  r.post(
    "/atletas",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Cadastra o atleta pelo ID World Sailing e registra o envio do termo",
        description:
          "O atleta nasce com cadastro incompleto (sem nome, gênero e data de nascimento): ele os informa no primeiro acesso, em PUT /me/cadastro. Até lá fica fora do ranking, do score, das pendências, do fechamento de ciclo e do investimento. wsId duplicado ou velaid já usado dão 409. confirmaMaioridade deve ser true. Se o velaid vier e existir no VelaID, o vínculo é guardado e os dados de lá ficam como sugestão para o atleta; velaid de menor de 18 anos é recusado. Código fora do VelaID importado é aceito, sem sugestão. Revalida classe ativa e treinador válido.",
        security: seguranca,
        body: esquemaCadastro,
        response: {
          201: z.object({
            id: z.string(),
            wsId: z.string(),
            velaid: z.string().nullable(),
            cadastroCompleto: z.literal(false),
            termo: z.object({ status: z.literal("aguardando_aceite"), versao: z.string() }),
            conta: z
              .enum(["convite_enviado", "sem_email", "indisponivel"])
              .describe(
                "convite_enviado: conta criada e convite enviado. sem_email: nenhuma conta criada (e-mail já em uso ou criarConta=false). indisponivel: conta criada, mas o convite não foi enviado (use POST /usuarios/:id/convite).",
              ),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const wsId = normalizarWsId(req.body.wsId);
      if (!wsIdValido(wsId)) throw requisicaoInvalida(MENSAGEM_WS_ID_INVALIDO);
      const velaidInformado = req.body.velaid?.trim() ? normalizarCodigo(req.body.velaid) : null;
      const { classeId, treinadorId, criarConta } = req.body;
      const email = req.body.email.trim().toLowerCase();
      const usuarioId = req.usuario.id;
      const referencia = app.agora();
      const termo = await buscarTermoVigente(app.db, referencia);

      const criado = await app.db
        .transacao(async (tx) => {
          let v: LinhaVelaId | undefined;
          if (velaidInformado) {
            v = (
              await tx.query<LinhaVelaId>(
                `select ${COLUNAS_VELAID_SQL} from velaid_registros where codigo = $1`,
                [velaidInformado],
              )
            ).rows[0];
            if (v) {
              const idade = idadeEm(v.data_nascimento, referencia);
              if (idade < IDADE_MINIMA_PILOTO) throw requisicaoInvalida(motivoMenor(v.nome, idade));
            }
            if (
              (await tx.query("select 1 from atletas where velaid_codigo = $1", [velaidInformado]))
                .rows.length > 0
            ) {
              throw conflito(`O código ${velaidInformado} já está no piloto.`);
            }
          }
          if ((await tx.query("select 1 from atletas where ws_id = $1", [wsId])).rows.length > 0) {
            throw conflito(MENSAGEM_WS_ID_DUPLICADO);
          }
          if (
            (await tx.query("select 1 from classes where id = $1 and ativa", [classeId])).rows
              .length === 0
          ) {
            throw requisicaoInvalida("Classe inválida ou inativa.");
          }
          const trein = await tx.query(
            "select 1 from usuarios where id = $1 and papel = 'treinador' and ativo",
            [treinadorId],
          );
          if (trein.rows.length === 0) throw requisicaoInvalida("Treinador inválido ou inativo.");

          const ins = await tx.query<{ id: string }>(
            `insert into atletas (ws_id, velaid_codigo, classe_id, clube, cidade, uf,
                                  treinador_id, email_contato, criado_por)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
            [
              wsId,
              velaidInformado,
              classeId,
              v?.clube ?? null,
              v?.cidade ?? null,
              v?.uf ?? null,
              treinadorId,
              email,
              usuarioId,
            ],
          );
          const id = ins.rows[0]!.id;
          // Sem WS ID nem VelaID: o entidade_id já identifica o atleta, e a anonimização não pode
          // deixar o código original na trilha de auditoria.
          const detalhes = JSON.stringify({
            classeId,
            versaoTermo: termo.versao,
            comVelaid: velaidInformado !== null,
          });
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
             values ($1, 'cadastrar_atleta', 'atletas', $2, $3::jsonb, $4), ($1, 'enviar_termo', 'atletas', $2, $3::jsonb, $4)`,
            [usuarioId, id, detalhes, app.agora()],
          );

          // Conta do atleta (papel atleta), amarrada ao e-mail informado. E-mail já em uso: não cria.
          // O nome da conta é provisório (parte local do e-mail) até o atleta completar o cadastro.
          let contaUsuarioId: string | null = null;
          if (criarConta) {
            const emUso = await tx.query("select 1 from usuarios where lower(email) = $1", [email]);
            if (emUso.rows.length === 0) {
              const u = await tx.query<{ id: string }>(
                "insert into usuarios (email, nome, papel, atleta_id) values ($1, $2, 'atleta', $3) returning id",
                [email, email.split("@")[0]!.slice(0, 120) || "Atleta", id],
              );
              contaUsuarioId = u.rows[0]!.id;
              await tx.query(
                `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
                 values ($1, 'criar_usuario', 'usuarios', $2, $3::jsonb, $4)`,
                [
                  usuarioId,
                  contaUsuarioId,
                  JSON.stringify({ papel: "atleta", atletaId: id }),
                  app.agora(),
                ],
              );
            }
          }
          return { id, email, contaUsuarioId };
        })
        .catch((e: unknown) => {
          // Cadastro simultâneo do mesmo WS ID ou VelaID: a restrição única do banco decide.
          const f = e as { code?: string; constraint?: string };
          if (f.code === "23505") {
            throw conflito(
              f.constraint?.includes("velaid")
                ? `O código ${velaidInformado ?? "VelaID"} já está no piloto.`
                : MENSAGEM_WS_ID_DUPLICADO,
            );
          }
          throw e;
        });

      const front = app.config.FRONT_URL.replace(/\/+$/, "");
      let conta: "convite_enviado" | "sem_email" | "indisponivel" = "sem_email";
      if (criado.contaUsuarioId) {
        conta = "indisponivel";
        if (app.adminAuth) {
          try {
            const { authUserId } = await app.adminAuth.convidar(
              criado.email,
              `${front}/redefinir-senha`,
            );
            await app.db.transacao(async (tx) => {
              await tx.query(
                "update usuarios set auth_user_id = coalesce(auth_user_id, $2), convidado_em = $3 where id = $1",
                [criado.contaUsuarioId, authUserId, app.agora()],
              );
              await tx.query(
                `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
                 values ($1, 'convidar_usuario', 'usuarios', $2, '{}'::jsonb, $3)`,
                [usuarioId, criado.contaUsuarioId, app.agora()],
              );
            });
            conta = "convite_enviado";
          } catch (e) {
            if (!(e instanceof ContaJaExiste)) {
              req.log.error(
                {
                  evento: "convite_falhou",
                  usuarioId: criado.contaUsuarioId,
                  err: e instanceof Error ? e.message : "erro",
                },
                "falha ao convidar",
              );
            }
          }
        }
      }

      // E-mail do termo: falha de envio não desfaz o cadastro (o gestor pode registrar o aceite depois).
      try {
        await app.email.enviar({
          para: criado.email,
          assunto: "Scout Vela: complete seu cadastro e aceite o termo de consentimento",
          texto: [
            "Olá,",
            "Você foi cadastrado no piloto do Scout Vela (CBVela). No primeiro acesso, complete seu cadastro (nome, gênero e data de nascimento) e leia e aceite o termo de consentimento " +
              `(${termo.versao}) em ${front}`,
            "O compartilhamento com o IBVAR é uma autorização separada, que você controla depois do aceite.",
          ].join("\n\n"),
        });
      } catch (e) {
        req.log.error(
          {
            evento: "email_termo_falhou",
            atletaId: criado.id,
            err: e instanceof Error ? e.message : "erro",
          },
          "falha ao enviar o termo",
        );
      }

      req.log.info(
        { evento: "termo_enviado", atletaId: criado.id, versao: termo.versao },
        "termo do piloto enviado",
      );
      return reply.code(201).send({
        id: criado.id,
        wsId,
        velaid: velaidInformado,
        cadastroCompleto: false as const,
        termo: { status: "aguardando_aceite" as const, versao: termo.versao },
        conta,
      });
    },
  );

  // Rota estática: o Fastify a prefere a GET /atletas/:id (em atletas.ts) para o texto "pendentes".
  r.get(
    "/atletas",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Todos os atletas do piloto, para gestão do cadastro",
        description:
          "Inclui inativos e quem não aceitou o termo. Sem dado sensível nem e-mail. termoAceito segue a regra do ranking (TERMO_EXIGE_REACEITE). contaVinculada: já existe conta de atleta ligada a ele. busca procura no nome, no ID World Sailing e no código VelaID. cadastroCompleto: o atleta já informou nome, gênero e data de nascimento; incompleto aparece com nome nulo. cadastroRecusado: o atleta informou menos de 18 anos no primeiro acesso (inativado; o gestor remove o cadastro pela anonimização).",
        security: seguranca,
        querystring: z.object({
          ativo: z.enum(["true", "false"]).optional(),
          termoAceito: z.enum(["true", "false"]).optional(),
          classeId: z.string().min(1).max(40).optional(),
          treinadorId: z.uuid().optional(),
          cadastroCompleto: z.enum(["true", "false"]).optional(),
          busca: z
            .string()
            .trim()
            .max(80)
            .optional()
            .describe("Parte do nome, do ID World Sailing ou do VelaID"),
        }),
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              nome: z.string().nullable().describe("Nulo enquanto o cadastro está incompleto"),
              wsId: z.string(),
              velaid: z.string().nullable(),
              classe: z.object({ id: z.string(), nome: z.string() }),
              treinador: z.object({ id: z.string(), nome: z.string() }).nullable(),
              numeroVela: z.string().nullable(),
              idade: z
                .number()
                .int()
                .nullable()
                .describe(
                  "Calculada no servidor; nula com o cadastro incompleto. A data de nascimento não sai na lista",
                ),
              ativo: z.boolean(),
              termoAceito: z.boolean(),
              cadastroCompleto: z.boolean(),
              cadastroRecusado: z
                .boolean()
                .describe("Menor de 18 anos no primeiro acesso: inativado, aguarda anonimização"),
              contaVinculada: z.boolean(),
            }),
          ),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req) => {
      const q = req.query;
      const comoBool = (v: "true" | "false" | undefined) =>
        v === undefined ? undefined : v === "true";
      return listarAtletasGestao(app.db, {
        agora: app.agora(),
        ativo: comoBool(q.ativo),
        termoAceito: comoBool(q.termoAceito),
        cadastroCompleto: comoBool(q.cadastroCompleto),
        classeId: q.classeId,
        treinadorId: q.treinadorId,
        busca: q.busca,
      });
    },
  );

  r.get(
    "/atletas/pendentes",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Atletas com aceite do termo do piloto pendente",
        description:
          "Quem nunca aceitou (termoAceitoVersao nulo) e quem aceitou só uma versão anterior à vigente (termoAceitoVersao preenchido).",
        security: seguranca,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              nome: z.string().nullable().describe("Nulo enquanto o cadastro está incompleto"),
              wsId: z.string(),
              velaid: z.string().nullable(),
              classe: z.object({ id: z.string(), nome: z.string() }),
              criadoEm: z.string().describe("Instante ISO"),
              termoAceitoVersao: z
                .string()
                .nullable()
                .describe("Última versão aceita; nulo = nunca aceitou"),
            }),
          ),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async () => {
      const agora = app.agora();
      const { rows } = await app.db.query<{
        id: string;
        nome: string | null;
        ws_id: string;
        velaid: string | null;
        classe_id: string;
        classe_nome: string;
        criado_em: Date;
        termo_aceito_versao: string | null;
      }>(
        `select a.id, a.nome, a.ws_id, a.velaid_codigo as velaid, c.id as classe_id, c.nome as classe_nome, a.criado_em,
                (select ct.versao_termo from consentimento_atual ct
                  where ct.atleta_id = a.id and ct.tipo = 'termo_piloto' and ct.concedido) as termo_aceito_versao
           from atletas a join classes c on c.id = a.classe_id
          where a.ativo and not ${termoSql.aceitoVigente("a.id", "$1")}
          order by a.criado_em, a.nome`,
        [agora],
      );
      return rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        wsId: l.ws_id,
        velaid: l.velaid,
        classe: { id: l.classe_id, nome: l.classe_nome },
        criadoEm: new Date(l.criado_em).toISOString(),
        termoAceitoVersao: l.termo_aceito_versao,
      }));
    },
  );

  r.post(
    "/atletas/:id/termo",
    {
      preHandler: [...soGestor, recusarAtletaAnonimizado(app)],
      schema: {
        tags: ["cadastro"],
        summary: "Registra o aceite do termo do piloto recebido do atleta",
        description:
          "Aceita a versão vigente ou a próxima publicada (aceite antecipado, como em POST /termo/aceite). Não concede o compartilhamento com o IBVAR: essa decisão é do atleta (consentimento explícito). Depois do aceite o atleta entra no ranking.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z.object({ versao: z.string().min(1).max(100) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      const usuarioId = req.usuario.id;
      await app.db.transacao(async (tx) => {
        const agora = app.agora();
        const alvo = await termoAceitavel(tx, agora, req.body.versao);
        if (!alvo)
          throw requisicaoInvalida("A versão do termo não é a vigente nem a próxima publicada.");
        const a = await tx.query<{ ativo: boolean; anonimizado_em: Date | null }>(
          "select ativo, anonimizado_em from atletas where id = $1 for update",
          [id],
        );
        if (a.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
        if (a.rows[0]!.anonimizado_em) throw erroAtletaAnonimizado();
        if (!a.rows[0]!.ativo) throw naoEncontrado("Atleta não encontrado.");
        const aceito = await tx.query<{ ok: boolean }>(
          `select ${termoSql.aceitoVersao("$1::uuid", "$2")} as ok`,
          [id, alvo.versao],
        );
        if (aceito.rows[0]?.ok)
          throw conflito("Esta versão do termo já foi aceita por este atleta.");
        await tx.query(
          `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
           values ($1, 'termo_piloto', true, $2, $3, $4)`,
          [id, alvo.versao, agora, usuarioId],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'registrar_aceite_termo', 'atletas', $2, $3::jsonb, $4)`,
          [usuarioId, id, JSON.stringify({ versaoTermo: req.body.versao }), agora],
        );
      });
      return { ok: true as const };
    },
  );

  r.post(
    "/importacoes",
    {
      preHandler: soGestor,
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        tags: ["cadastro"],
        summary: "Importa CSV do VelaID ou do Ranking CBVela",
        description:
          "JSON com o CSV em texto. Separador ; ou , (detectado no cabeçalho). VelaID: codigo;nome;genero;data_nascimento;clube;cidade;uf;ws_id;email. " +
          "Ranking CBVela: velaid;nivel;evento;data;posicao;tamanho_frota;pontos (nível brasileiro, estadual ou regional). " +
          "Colunas cpf, rg, documento, endereço e renda rejeitam o arquivo inteiro. Linha inválida vira erro da linha.",
        security: seguranca,
        body: esquemaImportacao,
        response: {
          201: esquemaRespostaImportacao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { tipo, conteudo } = req.body;
      if (Buffer.byteLength(conteudo, "utf8") > 512 * 1024) {
        throw requisicaoInvalida("O arquivo passa de 512 KB.");
      }
      const arquivoNome =
        req.body.arquivoNome
          // eslint-disable-next-line no-control-regex -- remove caracteres de controle do nome do arquivo
          ?.replace(/[\u0000-\u001f\u007f]/g, "")
          .trim() || null;
      try {
        const res = await importarCsv(app.db, {
          tipo,
          arquivoNome,
          conteudo,
          usuarioId: req.usuario.id,
          agora: app.agora(),
        });
        return reply.code(201).send(res);
      } catch (e) {
        if (e instanceof ArquivoRejeitado) throw requisicaoInvalida(e.message);
        throw e;
      }
    },
  );
}

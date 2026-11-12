import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import {
  conflito,
  esquemaErro,
  naoEncontrado,
  requisicaoInvalida,
  servicoIndisponivel,
} from "../erros.js";
import { ContaJaExiste } from "../integracoes/supabase-admin.js";

const PAPEIS_CONVIDAVEIS = ["gestor", "treinador", "ibvar", "atleta"] as const;
const LIMITE_CONVITES = { rateLimit: { max: 20, timeWindow: 60_000 } };

const esquemaUsuario = z.object({
  id: z.string(),
  nome: z.string(),
  email: z.string(),
  papel: z.enum(["gestor", "treinador", "atleta", "ibvar", "responsavel"]),
  ativo: z.boolean(),
  atleta: z.object({ id: z.string(), nome: z.string() }).nullable(),
  contaVinculada: z.boolean().describe("Já existe login amarrado a este cadastro (auth_user_id)"),
  convidadoEm: z
    .string()
    .nullable()
    .describe("Instante ISO do último convite; nulo se nunca enviado"),
});

interface LinhaUsuario {
  id: string;
  nome: string;
  email: string;
  papel: "gestor" | "treinador" | "atleta" | "ibvar" | "responsavel";
  ativo: boolean;
  atleta_id: string | null;
  atleta_nome: string | null;
  auth_user_id: string | null;
  convidado_em: Date | null;
}

const SELECT_USUARIO = `select u.id, u.nome, u.email, u.papel, u.ativo, u.atleta_id, a.nome as atleta_nome, u.auth_user_id, u.convidado_em
  from usuarios u left join atletas a on a.id = u.atleta_id`;

function paraResposta(l: LinhaUsuario) {
  return {
    id: l.id,
    nome: l.nome,
    email: l.email,
    papel: l.papel,
    ativo: l.ativo,
    atleta: l.atleta_id && l.atleta_nome ? { id: l.atleta_id, nome: l.atleta_nome } : null,
    contaVinculada: l.auth_user_id !== null,
    convidadoEm: l.convidado_em ? new Date(l.convidado_em).toISOString() : null,
  };
}

async function buscarUsuario(db: Db, id: string): Promise<LinhaUsuario | null> {
  return (await db.query<LinhaUsuario>(`${SELECT_USUARIO} where u.id = $1`, [id])).rows[0] ?? null;
}

const MSG_EMAIL_EM_USO = "Já existe um usuário com este e-mail.";

export async function rotasUsuarios(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const soGestor = [app.autenticar, exigirPapel("gestor")];
  const seguranca = [{ bearerAuth: [] }];
  const redirectConvite = () => `${app.config.FRONT_URL.replace(/\/+$/, "")}/redefinir-senha`;

  async function registrarConvite(
    usuarioId: string,
    authUserId: string,
    porId: string,
  ): Promise<void> {
    await app.db.transacao(async (tx) => {
      await tx.query(
        "update usuarios set auth_user_id = coalesce(auth_user_id, $2), convidado_em = $3 where id = $1",
        [usuarioId, authUserId, app.agora()],
      );
      await tx.query(
        `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
         values ($1, 'convidar_usuario', 'usuarios', $2, '{}'::jsonb)`,
        [porId, usuarioId],
      );
    });
  }

  /** Convida no Supabase Auth e grava o vínculo. Devolve 'enviado' ou 'indisponivel'; não lança por falha do Auth. */
  async function convidarConta(
    usuarioId: string,
    email: string,
    porId: string,
    log: FastifyInstance["log"],
  ): Promise<"enviado" | "indisponivel"> {
    if (!app.adminAuth) return "indisponivel";
    try {
      const { authUserId } = await app.adminAuth.convidar(email, redirectConvite());
      await registrarConvite(usuarioId, authUserId, porId);
      return "enviado";
    } catch (e) {
      if (!(e instanceof ContaJaExiste)) {
        log.error(
          { evento: "convite_falhou", usuarioId, err: e instanceof Error ? e.message : "erro" },
          "falha ao convidar",
        );
      }
      return "indisponivel";
    }
  }

  r.get(
    "/usuarios",
    {
      preHandler: soGestor,
      schema: {
        tags: ["usuarios"],
        summary: "Lista as contas do sistema",
        security: seguranca,
        response: { 200: z.array(esquemaUsuario), 401: esquemaErro, 403: esquemaErro },
      },
    },
    async () => {
      const { rows } = await app.db.query<LinhaUsuario>(
        `${SELECT_USUARIO} order by u.nome, u.email`,
      );
      return rows.map(paraResposta);
    },
  );

  r.post(
    "/usuarios",
    {
      preHandler: soGestor,
      config: LIMITE_CONVITES,
      schema: {
        tags: ["usuarios"],
        summary: "Cria uma conta e envia o convite por e-mail",
        description:
          "Papel atleta exige atletaId de um atleta ativo ainda sem usuário. O papel responsavel é recusado (fluxo de menores desligado). " +
          "convite=indisponivel: o usuário foi criado, mas o e-mail não foi enviado (convite não configurado, falha do Auth ou e-mail que já tem conta); use POST /usuarios/:id/convite ou 'Esqueci a senha'.",
        security: seguranca,
        body: z.object({
          nome: z.string().trim().min(1).max(120),
          email: z.string().trim().toLowerCase().pipe(z.email().max(200)),
          papel: z.enum([...PAPEIS_CONVIDAVEIS, "responsavel"]),
          atletaId: z.uuid().optional(),
        }),
        response: {
          201: z.object({ usuario: esquemaUsuario, convite: z.enum(["enviado", "indisponivel"]) }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { nome, email, papel, atletaId } = req.body;
      if (papel === "responsavel") {
        throw requisicaoInvalida(
          "O papel de responsável está desligado no piloto 18+ (fluxo de menores em desenho).",
        );
      }
      if (papel === "atleta" && !atletaId)
        throw requisicaoInvalida("Informe o atleta que esta conta representa.");
      if (papel !== "atleta" && atletaId)
        throw requisicaoInvalida("Só a conta de atleta é vinculada a um atleta.");
      const porId = req.usuario.id;

      const id = await app.db
        .transacao(async (tx) => {
          if (atletaId) {
            const a = await tx.query("select 1 from atletas where id = $1 and ativo for update", [
              atletaId,
            ]);
            if (a.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
            const jaTem = await tx.query("select 1 from usuarios where atleta_id = $1", [atletaId]);
            if (jaTem.rows.length > 0) throw conflito("Este atleta já tem uma conta.");
          }
          if (
            (await tx.query("select 1 from usuarios where lower(email) = $1", [email])).rows
              .length > 0
          ) {
            throw conflito(MSG_EMAIL_EM_USO);
          }
          const ins = await tx.query<{ id: string }>(
            "insert into usuarios (email, nome, papel, atleta_id) values ($1, $2, $3, $4) returning id",
            [email, nome, papel, atletaId ?? null],
          );
          const novo = ins.rows[0]!.id;
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             values ($1, 'criar_usuario', 'usuarios', $2, $3::jsonb)`,
            [porId, novo, JSON.stringify({ papel, atletaId: atletaId ?? null })],
          );
          return novo;
        })
        .catch((e: unknown) => {
          if ((e as { code?: string }).code === "23505") throw conflito(MSG_EMAIL_EM_USO);
          throw e;
        });

      const convite = await convidarConta(id, email, porId, req.log);
      const usuario = paraResposta((await buscarUsuario(app.db, id))!);
      return reply.code(201).send({ usuario, convite });
    },
  );

  r.put(
    "/usuarios/:id",
    {
      preHandler: soGestor,
      schema: {
        tags: ["usuarios"],
        summary: "Edita nome ou ativa/desativa uma conta",
        description:
          "O gestor não desativa a própria conta. Conta inativa perde o acesso na próxima requisição.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            nome: z.string().trim().min(1).max(120).optional(),
            ativo: z.boolean().optional(),
          })
          .refine((b) => b.nome !== undefined || b.ativo !== undefined, {
            message: "Informe nome ou ativo.",
          }),
        response: {
          200: esquemaUsuario,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { nome, ativo } = req.body;
      if (id === req.usuario.id && ativo === false)
        throw requisicaoInvalida("Você não pode desativar a própria conta.");
      const campos = [
        ...(nome !== undefined ? ["nome"] : []),
        ...(ativo !== undefined ? ["ativo"] : []),
      ];
      await app.db.transacao(async (tx) => {
        const u = await tx.query(
          "update usuarios set nome = coalesce($2, nome), ativo = coalesce($3, ativo) where id = $1 returning id",
          [id, nome ?? null, ativo ?? null],
        );
        if (u.rows.length === 0) throw naoEncontrado("Usuário não encontrado.");
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           values ($1, 'editar_usuario', 'usuarios', $2, $3::jsonb)`,
          [req.usuario.id, id, JSON.stringify({ campos })],
        );
      });
      return paraResposta((await buscarUsuario(app.db, id))!);
    },
  );

  r.post(
    "/usuarios/:id/convite",
    {
      preHandler: soGestor,
      config: LIMITE_CONVITES,
      schema: {
        tags: ["usuarios"],
        summary: "Reenvia o convite de conta",
        description:
          "409 quando o e-mail já tem conta ativa: a pessoa deve usar 'Esqueci a senha'. 503 quando o convite não está configurado.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ convite: z.literal("enviado") }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req) => {
      const u = await buscarUsuario(app.db, req.params.id);
      if (!u) throw naoEncontrado("Usuário não encontrado.");
      if (!u.ativo) throw requisicaoInvalida("A conta está inativa. Reative-a antes de convidar.");
      if (u.papel === "responsavel")
        throw requisicaoInvalida("O papel de responsável está desligado no piloto 18+.");
      if (!app.adminAuth)
        throw servicoIndisponivel("O envio de convites não está configurado neste ambiente.");
      try {
        const { authUserId } = await app.adminAuth.convidar(u.email, redirectConvite());
        await registrarConvite(u.id, authUserId, req.usuario.id);
      } catch (e) {
        if (e instanceof ContaJaExiste) {
          throw conflito(
            'Este e-mail já tem conta. Peça à pessoa para usar "Esqueci a senha" na tela de entrada.',
          );
        }
        req.log.error(
          {
            evento: "convite_falhou",
            usuarioId: u.id,
            err: e instanceof Error ? e.message : "erro",
          },
          "falha ao convidar",
        );
        throw servicoIndisponivel(
          "Não foi possível enviar o convite agora. Tente novamente em instantes.",
        );
      }
      return { convite: "enviado" as const };
    },
  );

  r.put(
    "/atletas/:id",
    {
      preHandler: soGestor,
      schema: {
        tags: ["usuarios"],
        summary: "Edita classe, treinador, número de vela ou situação do atleta",
        description: "Valida classe ativa e treinador ativo. numeroVela vazio limpa o campo.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            classeId: z.string().min(1).max(40).optional(),
            treinadorId: z.uuid().optional(),
            numeroVela: z.string().trim().max(20).optional(),
            ativo: z.boolean().optional(),
          })
          .refine((b) => Object.values(b).some((v) => v !== undefined), {
            message: "Informe ao menos um campo.",
          }),
        response: {
          200: z.object({
            id: z.string(),
            classeId: z.string(),
            treinadorId: z.string().nullable(),
            numeroVela: z.string().nullable(),
            ativo: z.boolean(),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { id } = req.params;
      const { classeId, treinadorId, numeroVela, ativo } = req.body;
      const campos = (
        [
          ["classeId", classeId],
          ["treinadorId", treinadorId],
          ["numeroVela", numeroVela],
          ["ativo", ativo],
        ] as const
      )
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k);
      return app.db.transacao(async (tx) => {
        if (
          (await tx.query("select 1 from atletas where id = $1 for update", [id])).rows.length === 0
        ) {
          throw naoEncontrado("Atleta não encontrado.");
        }
        if (
          classeId !== undefined &&
          (await tx.query("select 1 from classes where id = $1 and ativa", [classeId])).rows
            .length === 0
        ) {
          throw requisicaoInvalida("Classe inválida ou inativa.");
        }
        if (
          treinadorId !== undefined &&
          (
            await tx.query(
              "select 1 from usuarios where id = $1 and papel = 'treinador' and ativo",
              [treinadorId],
            )
          ).rows.length === 0
        ) {
          throw requisicaoInvalida("Treinador inválido ou inativo.");
        }
        const res = await tx.query<{
          id: string;
          classe_id: string;
          treinador_id: string | null;
          numero_vela: string | null;
          ativo: boolean;
        }>(
          `update atletas set
             classe_id = coalesce($2, classe_id),
             treinador_id = coalesce($3, treinador_id),
             numero_vela = case when $4::text is null then numero_vela else nullif($4::text, '') end,
             ativo = coalesce($5, ativo)
           where id = $1
           returning id, classe_id, treinador_id, numero_vela, ativo`,
          [id, classeId ?? null, treinadorId ?? null, numeroVela ?? null, ativo ?? null],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           values ($1, 'editar_atleta', 'atletas', $2, $3::jsonb)`,
          [req.usuario.id, id, JSON.stringify({ campos })],
        );
        const l = res.rows[0]!;
        return {
          id: l.id,
          classeId: l.classe_id,
          treinadorId: l.treinador_id,
          numeroVela: l.numero_vela,
          ativo: l.ativo,
        };
      });
    },
  );
}

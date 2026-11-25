import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import { recusarAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import {
  TIPOS_AVISO,
  avisarContasDoAtleta,
  contarAvisosNaoLidos,
  listarAvisos,
  marcarAvisoLido,
  marcarTodosAvisosLidos,
} from "../repositories/avisos.js";

const esquemaAviso = z.object({
  id: z.string(),
  tipo: z.enum(TIPOS_AVISO),
  criadoEm: z.string().describe("Instante ISO"),
  lidoEm: z.string().nullable().describe("Instante ISO; nulo = não lido"),
  atleta: z.object({ id: z.string(), nome: z.string() }).nullable(),
  referencia: z
    .record(z.string(), z.unknown())
    .describe(
      "Só ids e nomes de campo: `{ indicadorId }`, `{ anexoId, categoria }`, `{ campos }`, `{ pedidoAjusteId }`, `{ sugestaoId, status }`, `{ quantidade }` (atleta_autoavaliou), `{ pesagemId }` (pesagens)",
    ),
  criadoPor: z.object({ nome: z.string(), papel: z.string() }).nullable(),
  mensagem: z
    .string()
    .nullable()
    .describe("Texto puro do pedido de ajuste (tipo `pedido_ajuste`); nulo nos demais tipos"),
  indicador: z
    .object({ id: z.string(), nome: z.string() })
    .nullable()
    .describe("Indicador do pedido de ajuste ou da resposta (`referencia.indicadorId`)"),
});

const esquemaListaAvisos = z.object({
  itens: z.array(esquemaAviso),
  proximoAntesDe: z
    .string()
    .nullable()
    .describe("Passe em `antesDe` para a próxima página; nulo = não há mais"),
  naoLidos: z.number().int().min(0).describe("Total de não lidos do usuário (não só da página)"),
});

const esquemaPedidoAjuste = z.object({
  id: z.string(),
  avisoEnviado: z
    .boolean()
    .describe("Falso quando o atleta ainda não tem conta de login (o pedido fica gravado)"),
});

export async function rotasAvisos(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];
  const idAviso = z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") });
  const quemRecebe = () => [app.autenticar, exigirPapel("gestor", "treinador", "atleta")];

  r.get(
    "/me/avisos",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["avisos"],
        summary: "Meus avisos (sino), do mais recente para o mais antigo",
        description:
          "Avisos do próprio usuário (gestor, treinador e atleta). IBVAR não recebe avisos: lista vazia. Paginação por data: `antesDe` é o `proximoAntesDe` da página anterior (instante ISO; só vêm avisos criados antes dele). `limite` de 1 a 100 (padrão 20). Aviso que cita um atleta só aparece enquanto o usuário pode ver esse atleta. Para `pedido_ajuste` o item traz `mensagem` e `indicador` (o destinatário é o próprio atleta); o front monta a frase dos demais tipos.",
        security: seguranca,
        querystring: z.object({
          apenasNaoLidos: z.enum(["true", "false"]).optional(),
          limite: z.coerce.number().int().min(1).max(100).default(20),
          antesDe: z.iso.datetime({ offset: true, error: "Data inválida." }).optional(),
        }),
        response: { 200: esquemaListaAvisos, 400: esquemaErro, 401: esquemaErro },
      },
    },
    async (req) => {
      const { apenasNaoLidos, limite, antesDe } = req.query;
      const linhas = await listarAvisos(app.db, req.usuario, {
        apenasNaoLidos: apenasNaoLidos === "true",
        limite,
        ...(antesDe ? { antesDe: new Date(antesDe) } : {}),
      });
      return {
        itens: linhas.map((l) => ({
          id: l.id,
          tipo: l.tipo,
          criadoEm: new Date(l.criado_em).toISOString(),
          lidoEm: l.lido_em ? new Date(l.lido_em).toISOString() : null,
          atleta: l.atleta_id && l.atleta_nome ? { id: l.atleta_id, nome: l.atleta_nome } : null,
          referencia: l.referencia,
          criadoPor: l.autor_nome ? { nome: l.autor_nome, papel: l.autor_papel ?? "" } : null,
          mensagem: l.mensagem,
          indicador: l.indicador_id
            ? { id: l.indicador_id, nome: l.indicador_nome ?? l.indicador_id }
            : null,
        })),
        proximoAntesDe:
          linhas.length === limite
            ? new Date(linhas[linhas.length - 1]!.criado_em).toISOString()
            : null,
        naoLidos: await contarAvisosNaoLidos(app.db, req.usuario),
      };
    },
  );

  r.put(
    "/me/avisos/lidos",
    {
      preHandler: quemRecebe(),
      schema: {
        tags: ["avisos"],
        summary: "Marca todos os meus avisos como lidos",
        description:
          "Gestor, treinador e atleta. IBVAR: 403. Não gera auditoria (dado de interface).",
        security: seguranca,
        response: {
          200: z.object({ marcados: z.number().int().min(0) }),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req) => ({
      marcados: await marcarTodosAvisosLidos(app.db, req.usuario.id, app.agora()),
    }),
  );

  r.put(
    "/me/avisos/:id/lido",
    {
      preHandler: quemRecebe(),
      schema: {
        tags: ["avisos"],
        summary: "Marca um aviso meu como lido",
        description:
          "Só o dono do aviso (o de outra pessoa responde 404). Repetir é aceito e mantém a primeira data. Gestor, treinador e atleta; IBVAR: 403. Não gera auditoria (dado de interface).",
        security: seguranca,
        params: idAviso,
        response: { 204: z.null(), 401: esquemaErro, 403: esquemaErro, 404: esquemaErro },
      },
    },
    async (req, reply) => {
      const ok = await marcarAvisoLido(app.db, req.usuario.id, req.params.id, app.agora());
      if (!ok) throw naoEncontrado("Aviso não encontrado.");
      return reply.code(204).send(null);
    },
  );

  r.post(
    "/atletas/:id/pedidos-ajuste",
    {
      preHandler: [
        app.autenticar,
        exigirPapel("gestor", "treinador"),
        recusarAtletaAnonimizado(app),
      ],
      schema: {
        tags: ["avisos"],
        summary: "Pede ao atleta que revise algo (indicador ou perfil)",
        description:
          "Gestor, ou o treinador do atleta (o de outro atleta recebe 404). Atleta e IBVAR: 403. `indicadorId` é opcional: sem ele o pedido é sobre o perfil ou algo geral. `mensagem` é texto puro de 1 a 300 caracteres (o front não interpreta HTML). Grava o pedido (só inserção) e cria o aviso `pedido_ajuste` na conta do atleta; se o atleta ainda não tem conta de login, grava o pedido e responde `avisoEnviado: false`. A auditoria guarda só ids (nunca a mensagem).",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            mensagem: z
              .string("Informe a mensagem.")
              .trim()
              .min(1, "Informe a mensagem.")
              .max(300, "A mensagem pode ter no máximo 300 caracteres."),
            indicadorId: z.string().min(1).max(64).optional(),
          })
          .strict(),
        response: {
          201: esquemaPedidoAjuste,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      if (body.indicadorId) {
        const ind = await app.db.query(`select 1 from indicadores where id = $1`, [
          body.indicadorId,
        ]);
        if (ind.rows.length === 0) {
          throw requisicaoInvalidaCampos([
            { campo: "indicadorId", mensagem: "Indicador inexistente." },
          ]);
        }
      }
      const em = app.agora();
      const resultado = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id);
        const ins = await tx.query<{ id: string }>(
          `insert into pedidos_ajuste (atleta_id, indicador_id, mensagem, criado_por, criado_em)
           values ($1::uuid, $2, $3, $4::uuid, $5) returning id::text as id`,
          [base.id, body.indicadorId ?? null, body.mensagem, usuario.id, em],
        );
        const pedidoAjusteId = ins.rows[0]!.id;
        const avisados = await avisarContasDoAtleta(tx, base.id, {
          tipo: "pedido_ajuste",
          referencia: { pedidoAjusteId },
          autorId: usuario.id,
          em,
        });
        // Só ids: a mensagem é texto do treinador sobre o atleta e fica só na tabela do pedido.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1::uuid, 'pedir_ajuste', 'atletas', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({ pedidoAjusteId, indicadorId: body.indicadorId ?? null, avisados }),
            em,
          ],
        );
        return { id: pedidoAjusteId, avisoEnviado: avisados > 0 };
      });
      return reply.code(201).send(resultado);
    },
  );
}

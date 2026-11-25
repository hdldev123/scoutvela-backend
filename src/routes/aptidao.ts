import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro, naoEncontrado } from "../erros.js";
import { recusarAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";

/** Aptidão conferida (D15), como a ficha e o perfil devolvem. */
export const esquemaAptidao = z.object({
  apto: z.boolean(),
  conferidoEm: z.string().describe("Instante ISO em que o gestor conferiu"),
  conferidoPor: z.object({ nome: z.string() }),
});

export async function rotasAptidao(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().post(
    "/atletas/:id/aptidao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor"), recusarAtletaAnonimizado(app)],
      schema: {
        tags: ["atletas"],
        summary: "Registra a aptidão para a prática esportiva conferida pelo gestor",
        description:
          "Só o gestor, depois de conferir o atestado FORA do sistema: grava apenas `apto`, quem conferiu e quando (sem texto livre e sem arquivo). Cada registro é novo (só inserção); vale o mais recente. Dado de saúde: a auditoria guarda só os ids.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        body: z.object({ apto: z.boolean() }).strict(),
        response: {
          201: esquemaAptidao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const usuario = req.usuario;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const em = app.agora();
      await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id);
        const r = await tx.query<{ id: string }>(
          `insert into aptidoes (atleta_id, apto, conferido_por, conferido_em)
           values ($1::uuid, $2, $3::uuid, $4) returning id::text as id`,
          [base.id, req.body.apto, usuario.id, em],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1::uuid, 'registrar_aptidao', 'atletas', $2, $3::jsonb, $4)`,
          [usuario.id, base.id, JSON.stringify({ aptidaoId: r.rows[0]!.id }), em],
        );
      });
      return reply.code(201).send({
        apto: req.body.apto,
        conferidoEm: em.toISOString(),
        conferidoPor: { nome: usuario.nome },
      });
    },
  );
}

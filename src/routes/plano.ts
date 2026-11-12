import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro, naoEncontrado } from "../erros.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import { buscarPlanoAtual } from "../repositories/plano.js";

const texto = z.string().trim().min(1).max(1000);

export const esquemaTextosPlano = z.object({
  forcas: z.string(),
  lacunas: z.string(),
  meta12m: z.string(),
  meta24m: z.string(),
  recomendacao: z.string(),
});

export const esquemaPlanoRegistrado = esquemaTextosPlano.extend({
  registradoPor: z.object({ id: z.string(), nome: z.string() }),
  registradoEm: z.string().describe("Instante ISO"),
});

export async function rotasPlano(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().put(
    "/atletas/:id/plano",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["atletas"],
        summary: "Registra uma nova versão do plano individual (série histórica: só insere)",
        description:
          "Gestor, ou treinador dos próprios atletas. A ficha traz a sugestão calculada; quem registra é uma pessoa. 201 no primeiro plano do atleta, 200 nas versões seguintes.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            forcas: texto,
            lacunas: texto,
            meta12m: texto,
            meta24m: texto,
            recomendacao: texto,
          })
          .strict(),
        response: {
          200: esquemaPlanoRegistrado,
          201: esquemaPlanoRegistrado,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      const { primeiro, plano } = await app.db.transacao(async (tx) => {
        const anterior = await buscarPlanoAtual(tx, base.id);
        await tx.query(
          `insert into plano_individual (atleta_id, forcas, lacunas, meta_12m, meta_24m, recomendacao, registrado_por, registrado_em)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            base.id,
            body.forcas,
            body.lacunas,
            body.meta12m,
            body.meta24m,
            body.recomendacao,
            usuario.id,
            referencia,
          ],
        );
        // Auditoria sem o texto do plano: só quais campos mudaram.
        const campos = (
          ["forcas", "lacunas", "meta12m", "meta24m", "recomendacao"] as const
        ).filter((c) => !anterior || anterior[c] !== body[c]);
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'registrar_plano', 'atleta', $2, $3::jsonb, $4)`,
          [usuario.id, base.id, JSON.stringify({ campos, primeiraVersao: !anterior }), referencia],
        );
        return { primeiro: !anterior, plano: await buscarPlanoAtual(tx, base.id) };
      });
      if (!plano) throw naoEncontrado("Plano não encontrado.");
      return reply.code(primeiro ? 201 : 200).send(plano);
    },
  );
}

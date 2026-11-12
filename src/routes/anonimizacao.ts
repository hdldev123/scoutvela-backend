import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro } from "../erros.js";
import { anonimizarAtleta } from "../servicos/anonimizacao.js";

export async function rotasAnonimizacao(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();

  rota.post(
    "/atletas/:id/anonimizar",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["titular"],
        summary: "Anonimiza o atleta a pedido de exclusão (LGPD, art. 18)",
        description:
          "Só o gestor, com o pedido de exclusão do próprio atleta (aberto) e a confirmação `ANONIMIZAR`. Numa transação: tira nome, contato, clube, cidade, número de vela, ID World Sailing e código VelaID (vira `ANON-xxxxxxxx`), apaga a linha do VelaID, anonimiza a conta de login, revoga os consentimentos, marca as evidências como removidas, responde o pedido e audita. A série histórica (notas, respostas, medidas, gates, financeiro, plano) é mantida, sem identificação direta. Depois do commit remove os arquivos do Storage e a conta do Supabase Auth: se algo falhar, a anonimização vale e a resposta traz `pendencias`. Repetir a chamada com o mesmo pedido só tenta de novo essas pendências. Atleta já anonimizado por outro pedido, ou pedido já respondido, devolve 409.",
        security: [{ bearerAuth: [] }],
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            pedidoTitularId: z.string().regex(/^\d{1,18}$/, "Identificador inválido."),
            confirmacao: z.literal("ANONIMIZAR"),
          })
          .strict(),
        response: {
          200: z.object({
            atletaId: z.string(),
            anonimizadoEm: z.string().describe("Instante ISO"),
            evidenciasRemovidas: z.number().int(),
            pendencias: z.object({
              arquivos: z.number().int().describe("Arquivos que ainda não saíram do Storage"),
              conta: z.boolean().describe("A conta no Supabase Auth ainda não foi apagada"),
            }),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) =>
      anonimizarAtleta(
        {
          db: app.db,
          armazenamento: app.armazenamento,
          adminAuth: app.adminAuth,
          agora: app.agora,
          log: req.log,
        },
        {
          atletaId: req.params.id,
          pedidoTitularId: req.body.pedidoTitularId,
          gestorId: req.usuario.id,
        },
      ),
  );
}

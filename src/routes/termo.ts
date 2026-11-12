import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { conflito, esquemaErro, requisicaoInvalida, semAcesso } from "../erros.js";
import { buscarTermoVigente } from "../repositories/termo.js";

export async function rotasTermo(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  r.get(
    "/termo",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["termo"],
        summary: "Termo de consentimento vigente",
        description:
          "Texto da versão vigente (a de maior vigente_desde). Qualquer usuário autenticado lê.",
        security: seguranca,
        response: {
          200: z.object({
            versao: z.string(),
            titulo: z.string(),
            texto: z.string(),
            vigenteDesde: z.string().describe("Instante ISO"),
          }),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async () => buscarTermoVigente(app.db),
  );

  r.post(
    "/termo/aceite",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["termo"],
        summary: "O atleta aceita o termo vigente",
        description:
          "A versão enviada precisa ser a vigente. Não concede o compartilhamento com o IBVAR (consentimento separado, em PUT /consentimento).",
        security: seguranca,
        body: z.object({ versao: z.string().min(1).max(100) }),
        response: {
          200: z.object({ ok: z.literal(true) }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const atletaId = req.usuario.atletaId;
      if (!atletaId) throw semAcesso();
      const usuarioId = req.usuario.id;
      const agora = app.agora();
      await app.db.transacao(async (tx) => {
        const vigente = await buscarTermoVigente(tx);
        if (req.body.versao !== vigente.versao) {
          throw requisicaoInvalida(
            "A versão do termo não é a vigente. Recarregue a página e leia o termo atual.",
          );
        }
        await tx.query("select 1 from atletas where id = $1 for update", [atletaId]);
        const aceito = await tx.query(
          "select 1 from consentimento_atual where atleta_id = $1 and tipo = 'termo_piloto' and concedido and versao_termo = $2",
          [atletaId, vigente.versao],
        );
        if (aceito.rows.length > 0) throw conflito("Você já aceitou esta versão do termo.");
        await tx.query(
          `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
           values ($1, 'termo_piloto', true, $2, $3, $4)`,
          [atletaId, vigente.versao, agora, usuarioId],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           values ($1, 'aceitar_termo', 'atletas', $2, $3::jsonb)`,
          [usuarioId, atletaId, JSON.stringify({ versaoTermo: vigente.versao })],
        );
      });
      return { ok: true as const };
    },
  );
}

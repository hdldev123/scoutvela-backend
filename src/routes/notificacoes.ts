import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ErroApi, esquemaErro } from "../erros.js";
import {
  CHAVES_NOTIFICACAO,
  CHAVES_VISTAS_POR_PAPEL,
  contarNotificacoes,
  marcarVista,
} from "../repositories/notificacoes.js";

export async function rotasNotificacoes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  r.get(
    "/me/notificacoes",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["sessao"],
        summary: "Contagens dos balões do menu lateral (itens que pedem atenção)",
        description:
          "Só as chaves do papel, sempre presentes (0 quando nada pede atenção). Gestor: `revisoes` (pedidos de revisão e do titular abertos), `cadastro` (atletas ativos sem aceite da versão vigente do termo), `investimento` e `avisos` (avisos não lidos, D8). Treinador: `revisoes` (pedidos de revisão abertos dos próprios atletas), `avaliar` (próprios atletas com indicadores pendentes no ciclo aberto; 0 sem ciclo aberto) e `avisos`. Atleta: `avisos` e `painel` (perguntas ainda sem resposta, hoje contadas só com ciclo aberto, + 1 se o termo vigente está pendente + respostas a pedidos de revisão e do titular dadas depois da última marcação de visto). IBVAR: só `investimento`. `investimento` (gestor e IBVAR) vale 1 quando há ciclo fechado depois da última vez que a pessoa marcou a tela como vista (PUT /me/notificacoes/vistas com chave `investimento`), senão 0. `total` é a soma. Feito para consulta a cada 60 s.",
        security: seguranca,
        response: {
          200: z.object({
            contagens: z.record(z.string(), z.number().int().min(0)),
            total: z.number().int().min(0),
          }),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req) => {
      const contagens = await contarNotificacoes(app.db, req.usuario, app.agora());
      return { contagens, total: Object.values(contagens).reduce((t, n) => t + n, 0) };
    },
  );

  r.put(
    "/me/notificacoes/vistas",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["sessao"],
        summary: "Marca uma tela como vista (zera as respostas novas do balão)",
        description:
          "Grava o instante atual como última visita à tela. O atleta marca `painel`; gestor e IBVAR marcam `investimento` (zera o aviso de ciclo fechado); qualquer outra combinação de papel e chave responde 400. Não gera auditoria: é dado de interface, não de decisão.",
        security: seguranca,
        body: z.object({ chave: z.enum(CHAVES_NOTIFICACAO) }),
        response: { 204: z.null(), 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req, reply) => {
      const { chave } = req.body;
      if (!CHAVES_VISTAS_POR_PAPEL[req.usuario.papel]?.includes(chave)) {
        throw new ErroApi(400, "requisicao_invalida", "Esta tela não tem marcação de visto.");
      }
      // Sem auditoria de propósito: guarda só quando a pessoa abriu a tela.
      await marcarVista(app.db, req.usuario.id, chave, app.agora());
      return reply.code(204).send(null);
    },
  );
}

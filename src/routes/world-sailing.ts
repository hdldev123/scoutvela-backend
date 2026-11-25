import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { linkPerfilWorldSailing } from "../domain/world-sailing.js";
import { ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { recusarAtletaAnonimizado } from "../repositories/anonimizado.js";
import {
  buscarAtletaParaWorldSailing,
  listarRankingWorldSailing,
  ultimaImportacaoWorldSailing,
} from "../repositories/world-sailing.js";
import { importarSemLancar } from "../servicos/importacao-world-sailing.js";
import { esquemaResumoWorldSailing } from "./esquemas-world-sailing.js";

/** Intervalo mínimo entre duas buscas do mesmo atleta. */
const INTERVALO_MINIMO_MS = 60_000;

export async function rotasWorldSailing(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];
  const params = z.object({ id: z.uuid() });
  // Atletas com busca em andamento: dois cliques seguidos não disparam duas buscas.
  const emAndamento = new Set<string>();

  rota.get(
    "/atletas/:id/world-sailing",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["world-sailing"],
        summary:
          "Seção World Sailing da ficha: link do perfil, última busca e histórico de ranking",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403; outro atleta ou treinador: 404). `perfilUrl` leva ao perfil público do atleta na World Sailing. `ultimaImportacao`: quando e como terminou a última busca (nulo se nunca houve). `importacaoAtiva`: falso com a integração desligada (o front esconde o botão de atualizar). `ranking`: o histórico de ranking importado (só informação, não entra na nota), do mais recente para o mais antigo. Os resultados de regata importados ficam em GET /atletas/:id/resultados (`fonte: world_sailing`).",
        security: seguranca,
        params,
        response: {
          200: z.object({
            perfilUrl: z.string().describe("https://www.sailing.org/sailor/?ref=<ID>"),
            importacaoAtiva: z.boolean(),
            ultimaImportacao: z
              .object({
                em: z.string().describe("Instante ISO"),
                status: z.enum(["ok", "nao_encontrado", "falhou"]),
              })
              .nullable(),
            ranking: z.array(
              z.object({
                data: z.string().describe("AAAA-MM-DD"),
                classe: z.string(),
                tipo: z.string().nullable().describe("Ex.: Senior, Youth"),
                posicao: z.number().int(),
                pontos: z.number().nullable(),
              }),
            ),
          }),
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const atleta = await buscarAtletaParaWorldSailing(app.db, req.usuario, req.params.id);
      if (!atleta) throw naoEncontrado("Atleta não encontrado.");
      const [ultima, ranking] = await Promise.all([
        ultimaImportacaoWorldSailing(app.db, req.usuario, atleta.id),
        listarRankingWorldSailing(app.db, req.usuario, atleta.id),
      ]);
      return {
        perfilUrl: linkPerfilWorldSailing(atleta.wsId),
        importacaoAtiva: app.worldSailing.fonte !== null,
        ultimaImportacao: ultima
          ? { em: new Date(ultima.em).toISOString(), status: ultima.status }
          : null,
        ranking,
      };
    },
  );

  rota.post(
    "/atletas/:id/world-sailing",
    {
      preHandler: [
        app.autenticar,
        exigirPapel("gestor", "treinador"),
        recusarAtletaAnonimizado(app),
      ],
      schema: {
        tags: ["world-sailing"],
        summary: "Busca de novo o perfil do atleta na World Sailing",
        description:
          "Gestor, ou treinador dos próprios atletas (outro treinador e atleta inexistente: 404; atleta e IBVAR: 403; atleta anonimizado: 409). Importa só o que é novo (resultados com `fonte: world_sailing`, que valem direto na nota P12 e nos gates, e o histórico de ranking) e renova a sugestão de cadastro, foto e bio; repetir a busca não duplica nada. No máximo uma busca por atleta a cada 60 segundos (429 `limite_excedido`). Com a integração desligada responde `status: desligado`. Atleta não encontrado na World Sailing ou falha da World Sailing não são erro da API: respondem 200 com `status` `nao_encontrado` ou `falhou`. Auditoria `importar_world_sailing` só com o modo, o status e as contagens.",
        security: seguranca,
        params,
        response: {
          200: esquemaResumoWorldSailing,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
          429: esquemaErro,
        },
      },
    },
    async (req) => {
      const atleta = await buscarAtletaParaWorldSailing(app.db, req.usuario, req.params.id);
      if (!atleta) throw naoEncontrado("Atleta não encontrado.");
      if (app.worldSailing.fonte === null) {
        return { status: "desligado" as const, resultadosNovos: 0, rankingNovos: 0 };
      }
      const agora = app.agora();
      const ultima = await app.db.query<{ executada_em: Date }>(
        `select executada_em from world_sailing_importacoes
          where atleta_id = $1::uuid order by executada_em desc, id desc limit 1`,
        [atleta.id],
      );
      const anterior = ultima.rows[0]?.executada_em;
      const espera = anterior
        ? INTERVALO_MINIMO_MS - (agora.getTime() - new Date(anterior).getTime())
        : 0;
      if (espera > 0 || emAndamento.has(atleta.id)) {
        const segundos = Math.max(1, Math.ceil(Math.max(espera, 0) / 1000));
        throw new ErroApi(
          429,
          "limite_excedido",
          `A World Sailing já foi consultada para este atleta há pouco. Tente de novo em ${segundos} s.`,
        );
      }
      emAndamento.add(atleta.id);
      try {
        return await importarSemLancar(
          app.db,
          app.worldSailing,
          atleta.id,
          req.usuario.id,
          agora,
          req.log,
        );
      } finally {
        emAndamento.delete(atleta.id);
      }
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { linkPerfilWorldSailing } from "../domain/world-sailing.js";
import { conflito, ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { recusarAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import {
  buscarAtletaParaWorldSailing,
  buscarMedidaSugerida,
  travarMedidaSugerida,
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
  const esquemaMedidaSugerida = z.object({
    pesoKg: z.number().nullable().describe("Peso autodeclarado no perfil (30 a 160 kg)"),
    alturaCm: z.number().nullable().describe("Altura autodeclarada no perfil (120 a 230 cm)"),
    informadoEm: z
      .string()
      .nullable()
      .describe("AAAA-MM-DD: quando o velejador atualizou o perfil na World Sailing"),
    podeDecidir: z.boolean().describe("Gestor e treinador do atleta: true; atleta: false"),
  });

  rota.get(
    "/atletas/:id/world-sailing",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["world-sailing"],
        summary:
          "Seção World Sailing da ficha: link do perfil, última busca e histórico de ranking",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403; outro atleta ou treinador: 404). `perfilUrl` leva ao perfil público do atleta na World Sailing. `ultimaImportacao`: quando e como terminou a última busca (nulo se nunca houve). `importacaoAtiva`: falso com a integração desligada (o front esconde o botão de atualizar). `ranking`: o histórico de ranking importado (só informação, não entra na nota), do mais recente para o mais antigo. Os resultados de regata importados ficam em GET /atletas/:id/resultados (`fonte: world_sailing`). `medidaSugerida` (D20): peso e altura autodeclarados no perfil, oferecidos como sugestão de medida enquanto não houver decisão (ou se o velejador atualizou o perfil depois dela); nulo sem pendência. `podeDecidir` é verdadeiro para o gestor e o treinador do atleta, e falso para o atleta (ele vê, mas não decide). É dado sensível: o IBVAR recebe 403 na rota inteira. Quem decide usa POST /atletas/:id/world-sailing/medida.",
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
            medidaSugerida: esquemaMedidaSugerida.nullable(),
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
      const [ultima, ranking, sugerida] = await Promise.all([
        ultimaImportacaoWorldSailing(app.db, req.usuario, atleta.id),
        listarRankingWorldSailing(app.db, req.usuario, atleta.id),
        buscarMedidaSugerida(app.db, atleta.id),
      ]);
      return {
        perfilUrl: linkPerfilWorldSailing(atleta.wsId),
        importacaoAtiva: app.worldSailing.fonte !== null,
        ultimaImportacao: ultima
          ? { em: new Date(ultima.em).toISOString(), status: ultima.status }
          : null,
        ranking,
        medidaSugerida: sugerida
          ? { ...sugerida, podeDecidir: req.usuario.papel !== "atleta" }
          : null,
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

  rota.post(
    "/atletas/:id/world-sailing/medida",
    {
      preHandler: [
        app.autenticar,
        exigirPapel("gestor", "treinador"),
        recusarAtletaAnonimizado(app),
      ],
      schema: {
        tags: ["world-sailing"],
        summary: "Usa ou dispensa o peso e a altura do perfil World Sailing como medida",
        description:
          'Gestor, ou treinador dos próprios atletas (outro treinador e atleta inexistente: 404; atleta e IBVAR: 403; atleta anonimizado: 409). Decide sobre a `medidaSugerida` de GET /atletas/:id/world-sailing; sem sugestão pendente: 409. `usar` grava o peso e a altura que existirem em `medidas_corporais` como medida validada (`medido_em` = data de atualização do perfil às 12:00 UTC, ou agora se não houver; evidência "Perfil World Sailing (autodeclarado), atualizado em DD/MM/AAAA"; `registrado_por` = quem decidiu) na mesma transação: a partir daí vale no Class Fit, no G1 e na altura da ficha, pela ordem de `medido_em` como qualquer outra medida. `dispensar` só registra a decisão. Se o velejador atualizar o perfil depois (data diferente), a sugestão é oferecida de novo. Auditoria `usar_medida_world_sailing` ou `dispensar_medida_world_sailing`, só com ids e a decisão (nunca peso nem altura).',
        security: seguranca,
        params,
        body: z
          .object({
            decisao: z.enum(["usar", "dispensar"], { error: "Informe usar ou dispensar." }),
          })
          .strict(),
        response: {
          200: z.object({
            decisao: z.enum(["usar", "dispensar"]),
            medidaId: z
              .number()
              .int()
              .nullable()
              .describe("Identificador da medida criada; nulo ao dispensar"),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario, body } = req;
      const atleta = await buscarAtletaParaWorldSailing(app.db, usuario, req.params.id);
      if (!atleta) throw naoEncontrado("Atleta não encontrado.");
      const agora = app.agora();
      const usar = body.decisao === "usar";

      const medidaId = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, atleta.id, { exigirAtivo: true });
        const s = await travarMedidaSugerida(tx, atleta.id);
        if (!s) {
          throw conflito(
            "Não há medida sugerida pela World Sailing para decidir. Ela pode já ter sido decidida.",
          );
        }
        let criada: number | null = null;
        if (usar) {
          const partes = s.informadoEm ? s.informadoEm.split("-") : null;
          const evidencia = partes
            ? `Perfil World Sailing (autodeclarado), atualizado em ${partes[2]}/${partes[1]}/${partes[0]}`
            : "Perfil World Sailing (autodeclarado)";
          const medidoEm = s.informadoEm ? new Date(`${s.informadoEm}T12:00:00Z`) : agora;
          const ins = await tx.query<{ id: string }>(
            `insert into medidas_corporais (atleta_id, peso_kg, altura_cm, medido_em, evidencia, registrado_por)
             values ($1::uuid, $2, $3, $4, $5, $6::uuid) returning id::text as id`,
            [atleta.id, s.pesoKg, s.alturaCm, medidoEm, evidencia, usuario.id],
          );
          criada = Number(ins.rows[0]!.id);
        }
        await tx.query(
          `update world_sailing_perfis
              set medida_decidida_em = $2, medida_decidida_ref = perfil_atualizado_em, medida_id = $3::bigint
            where atleta_id = $1::uuid`,
          [atleta.id, agora, criada],
        );
        // Auditoria sem o peso nem a altura: só ids e a decisão.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, $2, 'atleta', $3, $4::jsonb, $5)`,
          [
            usuario.id,
            usar ? "usar_medida_world_sailing" : "dispensar_medida_world_sailing",
            atleta.id,
            JSON.stringify({ decisao: body.decisao, medidaId: criada }),
            agora,
          ],
        );
        return criada;
      });
      return { decisao: body.decisao, medidaId };
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { dataIso } from "../domain/datas.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalida } from "../erros.js";
import { buscarAtletaVisivel, carregarDadosAtletas } from "../repositories/atletas.js";

const esquemaFinanceiro = z.object({
  perfilSuporte: z.enum(["A", "B", "C", "D"]),
  mesesAssegurados: z.number().int().nullable(),
  patrocinioPrivado: z.enum(["sim", "em_negociacao", "nao"]).nullable(),
  componentes: z.array(
    z.object({ id: z.string(), nome: z.string(), autonomia: z.string(), apoioCbvela: z.string() }),
  ),
});

const esquemaResultado = z.object({
  data: z.string(),
  nivel: z.string(),
  evento: z.string(),
  posicao: z.number().int(),
  tamanhoFrota: z.number().int(),
  internacional: z.boolean(),
  pontosCbvela: z.number().nullable(),
  fonte: z.enum(["ranking_cbvela", "manual"]),
  linkOficial: z.string().nullable(),
});

const esquemaCorpoResultado = z
  .object({
    nivel: z.enum(["mundial", "sul_americano", "continental", "internacional_aberto"]),
    evento: z.string().trim().min(3).max(200),
    data: z.iso.date().describe("AAAA-MM-DD, não futura"),
    posicao: z.number().int().positive(),
    tamanhoFrota: z.number().int().positive(),
    linkOficial: z
      .url()
      .max(500)
      .refine((u) => u.toLowerCase().startsWith("https://"), {
        message: "O link deve começar com https://.",
      }),
  })
  .strict();

export async function rotasCampanha(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });
  const seguranca = [{ bearerAuth: [] }];

  rota.put(
    "/atletas/:id/financeiro",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["campanha"],
        summary:
          "Informa o financeiro da campanha e o perfil de suporte (série histórica: só insere)",
        description:
          "Regra provisória P8: o perfil de suporte A a D é informado pelo gestor. Não entra no score; alimenta o gate G4 e o painel de investimento.",
        security: seguranca,
        params,
        body: z
          .object({
            perfilSuporte: z.enum(["A", "B", "C", "D"]),
            mesesAssegurados: z.number().int().min(0).max(120).nullable(),
            patrocinioPrivado: z.enum(["sim", "em_negociacao", "nao"]).nullable(),
            componentes: z
              .array(
                z
                  .object({
                    componenteId: z.string().min(1).max(64),
                    autonomia: z.enum(["alta", "parcial", "baixa"]),
                    apoioCbvela: z.enum(["baixa", "media", "alta"]),
                  })
                  .strict(),
              )
              .max(30),
          })
          .strict(),
        response: {
          200: esquemaFinanceiro,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario, body } = req;
      const agora = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      const ids = body.componentes.map((c) => c.componenteId);
      if (new Set(ids).size !== ids.length)
        throw requisicaoInvalida("Componente repetido no envio.");
      const validos = await app.db.query<{ id: string }>(
        `select id from componentes_custo where id = any($1::text[])`,
        [ids],
      );
      const conhecidos = new Set(validos.rows.map((r) => r.id));
      const desconhecido = ids.find((i) => !conhecidos.has(i));
      if (desconhecido)
        throw requisicaoInvalida(`Componente de custo inexistente: ${desconhecido}.`);

      return app.db.transacao(async (tx) => {
        // informado_em usa o relógio do banco (como o seed): o último lançamento é o atual.
        const r = await tx.query<{ id: string }>(
          `insert into financeiro_campanha (atleta_id, perfil_suporte, meses_assegurados, patrocinio_privado, informado_por)
           values ($1, $2, $3, $4, $5) returning id`,
          [base.id, body.perfilSuporte, body.mesesAssegurados, body.patrocinioPrivado, usuario.id],
        );
        const finId = r.rows[0]!.id;
        for (const c of body.componentes) {
          await tx.query(
            `insert into financeiro_componentes (financeiro_id, componente_id, autonomia, apoio_cbvela)
             values ($1, $2, $3, $4)`,
            [finId, c.componenteId, c.autonomia, c.apoioCbvela],
          );
        }
        // Sem valores na auditoria: só o id do lançamento e os componentes tocados.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'informar_financeiro', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({ financeiroId: String(finId), componentes: ids }),
            agora,
          ],
        );
        const dados = (
          await carregarDadosAtletas(tx, [base.id], { componentesFinanceiro: true })
        ).get(base.id);
        const fin = dados?.financeiro;
        if (!fin) throw naoEncontrado("Financeiro não encontrado.");
        return fin;
      });
    },
  );

  rota.post(
    "/atletas/:id/resultados",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["campanha"],
        summary: "Lança à mão um resultado internacional, com o link do resultado oficial",
        description:
          "Grava como internacional, fonte manual e sem pontos do Ranking CBVela. Os gates G2 e G3 são recalculados na leitura. Treinador só lança para os próprios atletas.",
        security: seguranca,
        params,
        body: esquemaCorpoResultado,
        response: {
          201: esquemaResultado,
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
      const agora = app.agora();
      if (body.posicao > body.tamanhoFrota)
        throw requisicaoInvalida("A posição não pode passar do tamanho da frota.");
      if (body.data > dataIso(agora))
        throw requisicaoInvalida("A data do resultado não pode ser futura.");
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      const resultado = await app.db.transacao(async (tx) => {
        const repetido = await tx.query(
          `select 1 from resultados_regata where atleta_id = $1 and data = $2 and lower(evento) = lower($3)`,
          [base.id, body.data, body.evento],
        );
        if (repetido.rows.length > 0)
          throw conflito("Este resultado já foi lançado para o atleta (mesmo evento e data).");
        const r = await tx.query<{ id: string }>(
          `insert into resultados_regata
             (atleta_id, nivel, evento, data, posicao, tamanho_frota, internacional, pontos_cbvela, fonte, link_oficial, registrado_por)
           values ($1, $2, $3, $4, $5, $6, true, null, 'manual', $7, $8) returning id`,
          [
            base.id,
            body.nivel,
            body.evento,
            body.data,
            body.posicao,
            body.tamanhoFrota,
            body.linkOficial,
            usuario.id,
          ],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'lancar_resultado', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({
              resultadoId: String(r.rows[0]!.id),
              campos: ["nivel", "evento", "data", "posicao", "tamanhoFrota", "linkOficial"],
            }),
            agora,
          ],
        );
        return {
          data: body.data,
          nivel: body.nivel,
          evento: body.evento,
          posicao: body.posicao,
          tamanhoFrota: body.tamanhoFrota,
          internacional: true,
          pontosCbvela: null,
          fonte: "manual" as const,
          linkOficial: body.linkOficial,
        };
      });
      return reply.code(201).send(resultado);
    },
  );
}

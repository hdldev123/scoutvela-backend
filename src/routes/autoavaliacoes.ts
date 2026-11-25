import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import type { CampoInvalido } from "../validacao.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import type { NotaDoTreinador, SugestaoDoAtleta } from "../repositories/autoavaliacao.js";
import {
  cicloParaAutoavaliacao,
  notasDoTreinadorNoCiclo,
  sugestoesDoCiclo,
} from "../repositories/autoavaliacao.js";
import { avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import { carregarParametros, carregarRubricas } from "../repositories/parametros.js";
import { esquemaNota } from "./avaliacoes.js";

const duasCasas = (v: number) => Math.round(v * 100) / 100;

const esquemaSugestao = z.object({
  valor: z.number().int().describe("Nota sugerida pelo atleta, de 0 a 5"),
  evidencia: z.string().nullable(),
  link: z.string().nullable().describe("Link https de vídeo ou outro conteúdo externo"),
  anexo: z.object({ id: z.string(), nomeArquivo: z.string() }).nullable(),
  em: z.string().describe("Instante ISO"),
});

const esquemaNotaTreinador = z.object({
  valor: z.number().int().describe("Nota do treinador (ou do gestor), de 0 a 5"),
  origem: z
    .enum(["avaliacao", "resposta_confirmada", "autoavaliacao_aprovada"])
    .describe("autoavaliacao_aprovada: o treinador manteve a nota sugerida pelo atleta"),
  justificativa: z.string().nullable().describe("Obrigatória quando a nota difere da sugestão"),
  avaliador: z.object({ nome: z.string() }).nullable(),
  em: z.string().describe("Instante ISO"),
});

const esquemaComparacao = z.object({
  ciclo: z
    .object({ id: z.string(), nome: z.string(), status: z.enum(["aberto", "fechado"]) })
    .nullable(),
  indicadores: z.array(
    z.object({
      indicadorId: z.string(),
      nome: z.string(),
      pilarId: z.string(),
      evidencia: z
        .enum(["obrigatoria", "opcional"])
        .describe("Se a nota do indicador exige texto de evidência (regra do gestor)"),
      orientacao: z
        .string()
        .nullable()
        .describe("Texto de ajuda do indicador, editável pelo gestor; nulo se não há"),
      sugestao: esquemaSugestao.nullable().describe("Última sugestão do atleta no ciclo"),
      treinador: esquemaNotaTreinador.nullable().describe("Última nota do treinador no ciclo"),
      diferenca: z
        .number()
        .int()
        .nullable()
        .describe("Nota do treinador menos a do atleta; nulo se falta uma das duas"),
    }),
  ),
  rubricas: z
    .array(
      z.object({
        pilarId: z.string().nullable().describe("Nulo = escala geral de 0 a 5"),
        notas: z.array(z.object({ nota: z.number().int(), descricao: z.string() })),
      }),
    )
    .describe(
      "Escala de 0 a 5: a geral (pilarId nulo) e a de cada pilar com rubrica própria. O atleta não lê GET /parametros, por isso a escala vem aqui",
    ),
  resumoPorPilar: z
    .array(
      z.object({
        pilarId: z.string(),
        nomeCurto: z.string(),
        diferencaMedia: z
          .number()
          .nullable()
          .describe(
            "Média de (treinador − atleta) nos indicadores com as duas notas; nulo se não há",
          ),
      }),
    )
    .nullable()
    .describe("Só para o gestor (nulo para treinador e atleta)"),
});

export async function rotasAutoavaliacoes(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  rota.post(
    "/autoavaliacoes",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["autoavaliacao"],
        summary: "O atleta sugere a nota de seus indicadores (autoavaliação)",
        description:
          "Só o atleta, no próprio cadastro, com ciclo aberto (sem ciclo aberto: 409). Só indicadores com `autoavaliacao: true` em GET /parametros (outro: 400 em `notas.N.indicadorId`). A evidência segue a regra do indicador (`evidencia`; obrigatória ausente: 400 em `notas.N.evidencia`); `link` só https://; `anexoId` só de anexo do próprio atleta (400 em `notas.N.anexoId`). Grava em `avaliacoes` com origem `autoavaliacao`, sem avaliador. Pode reenviar: a sugestão mais recente do ciclo vale (a série só recebe inserções). A sugestão NUNCA entra no score, nos gates, no ranking nem no investimento: só a nota do treinador conta. Avisa o treinador (`atleta_autoavaliou`, `referencia: { quantidade }`). Auditoria `enviar_autoavaliacao` só com ids de indicador e contagens.",
        security: seguranca,
        body: z
          .object({ notas: z.array(esquemaNota).min(1, "Informe ao menos uma nota.").max(60) })
          .strict(),
        response: {
          201: z.object({
            cicloId: z.string(),
            enviadas: z.number().int().describe("Quantidade de indicadores enviados"),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario } = req;
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, usuario.atletaId, referencia);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      const indicadores = new Map(
        parametros.pilares.flatMap((p) => p.indicadores).map((i) => [i.id, i]),
      );

      // Texto e link vazios valem como ausentes (o formulário pode mandar "" num campo opcional).
      const notas = req.body.notas.map(({ evidencia, link, ...resto }) => ({
        ...resto,
        evidencia: evidencia || null,
        link: link || null,
      }));

      const invalidos: CampoInvalido[] = [];
      const vistos = new Set<string>();
      for (const [i, n] of notas.entries()) {
        const ind = indicadores.get(n.indicadorId);
        if (!ind || !ind.autoavaliacao || ind.calculado || ind.tipo === "R") {
          invalidos.push({
            campo: `notas.${i}.indicadorId`,
            mensagem: "Este indicador não aceita autoavaliação.",
          });
          continue;
        }
        if (vistos.has(n.indicadorId)) {
          invalidos.push({
            campo: `notas.${i}.indicadorId`,
            mensagem: "Indicador repetido no envio.",
          });
          continue;
        }
        vistos.add(n.indicadorId);
        if (ind.evidencia === "obrigatoria" && !n.evidencia) {
          invalidos.push({
            campo: `notas.${i}.evidencia`,
            mensagem: "Informe a evidência da nota: este indicador a exige.",
          });
        }
      }
      if (invalidos.length > 0) {
        throw requisicaoInvalidaCampos(invalidos, "Há notas inválidas na autoavaliação.");
      }

      const anexoIds = [...new Set(notas.flatMap((n) => (n.anexoId ? [n.anexoId] : [])))];

      const cicloId = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id);
        const ciclo = await tx.query<{ id: string }>(
          `select id from ciclos_avaliacao where status = 'aberto' limit 1 for share`,
        );
        const id = ciclo.rows[0]?.id;
        if (!id) throw conflito("Não há ciclo de avaliação aberto.");

        if (anexoIds.length > 0) {
          // `for share`: uma remoção do anexo em andamento termina antes; anexo removido não liga.
          const ok = await tx.query<{ id: string }>(
            `select id from evidencias_anexos
              where atleta_id = $1::uuid and id = any($2::uuid[]) and removido_em is null
                and categoria <> 'balanca' for share`,
            [base.id, anexoIds],
          );
          const validos = new Set(ok.rows.map((r) => r.id));
          const sem = notas.flatMap((n, i) =>
            n.anexoId && !validos.has(n.anexoId)
              ? [
                  {
                    campo: `notas.${i}.anexoId`,
                    mensagem: "Anexo inexistente, removido ou de outro atleta.",
                  },
                ]
              : [],
          );
          if (sem.length > 0) throw requisicaoInvalidaCampos(sem, "Anexo inválido.");
        }

        for (const n of notas) {
          await tx.query(
            `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, link, origem, avaliador_id, lancado_em, anexo_id)
             values ($1, $2, $3, $4, $5, $6, 'autoavaliacao', null, $7, $8)`,
            [
              base.id,
              n.indicadorId,
              id,
              n.valor,
              n.evidencia,
              n.link,
              referencia,
              n.anexoId ?? null,
            ],
          );
        }
        // Auditoria sem nota nem texto de evidência: só ids de indicador e contagens.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'enviar_autoavaliacao', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({
              indicadores: notas.map((n) => n.indicadorId),
              comAnexo: notas.filter((n) => n.anexoId).length,
              comLink: notas.filter((n) => n.link).length,
              cicloId: id,
            }),
            referencia,
          ],
        );
        await avisarTreinadorDoAtleta(tx, base.id, {
          tipo: "atleta_autoavaliou",
          referencia: { quantidade: notas.length },
          autorId: usuario.id,
          em: referencia,
        });
        return id;
      });

      return reply.code(201).send({ cicloId, enviadas: notas.length });
    },
  );

  rota.get(
    "/atletas/:id/autoavaliacao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["autoavaliacao"],
        summary: "Atleta × treinador: a sugestão do atleta e a nota do treinador por indicador",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403; outro atleta ou treinador: 404). `?ciclo=<id>`; sem ele, o ciclo aberto ou, não havendo, o último fechado. Traz os indicadores com autoavaliação ligada e os que já têm sugestão no ciclo. `diferenca` = nota do treinador − nota do atleta. `resumoPorPilar` (diferença média por pilar) só vem para o gestor. Cada indicador traz `evidencia` (obrigatoria|opcional) e `orientacao`, e a resposta traz `rubricas` (escala geral com `pilarId` nulo e a de cada pilar com rubrica própria), porque o atleta não lê GET /parametros.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ ciclo: z.uuid().optional() }),
        response: {
          200: esquemaComparacao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const ciclo = await cicloParaAutoavaliacao(app.db, req.query.ciclo);
      if (!ciclo && req.query.ciclo) throw naoEncontrado("Ciclo não encontrado.");
      const parametros = await carregarParametros(app.db);

      const [sugestoes, notas] = ciclo
        ? await Promise.all([
            sugestoesDoCiclo(app.db, base.id, ciclo.id),
            notasDoTreinadorNoCiclo(app.db, base.id, ciclo.id),
          ])
        : [new Map<string, SugestaoDoAtleta>(), new Map<string, NotaDoTreinador>()];

      const indicadores = parametros.pilares.flatMap((p) =>
        p.indicadores
          .filter((i) => !i.calculado && i.tipo !== "R" && (i.autoavaliacao || sugestoes.has(i.id)))
          .map((i) => {
            const sugestao = sugestoes.get(i.id) ?? null;
            const treinador = notas.get(i.id) ?? null;
            return {
              indicadorId: i.id,
              nome: i.nome,
              pilarId: p.id,
              evidencia: i.evidencia,
              orientacao: i.orientacao,
              sugestao,
              treinador,
              diferenca: sugestao && treinador ? treinador.valor - sugestao.valor : null,
            };
          }),
      );

      const resumoPorPilar =
        usuario.papel === "gestor"
          ? parametros.pilares
              .filter((p) => indicadores.some((i) => i.pilarId === p.id))
              .map((p) => {
                const difs = indicadores
                  .filter((i) => i.pilarId === p.id && i.diferenca !== null)
                  .map((i) => i.diferenca as number);
                return {
                  pilarId: p.id,
                  nomeCurto: p.nomeCurto,
                  diferencaMedia: difs.length
                    ? duasCasas(difs.reduce((a, b) => a + b, 0) / difs.length)
                    : null,
                };
              })
          : null;

      const rubricas: z.infer<typeof esquemaComparacao>["rubricas"] = [];
      for (const r of await carregarRubricas(app.db)) {
        let grupo = rubricas.find((g) => g.pilarId === r.pilarId);
        if (!grupo) {
          grupo = { pilarId: r.pilarId, notas: [] };
          rubricas.push(grupo);
        }
        grupo.notas.push({ nota: r.nota, descricao: r.descricao });
      }

      return { ciclo, indicadores, rubricas, resumoPorPilar };
    },
  );
}

import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import type { Parametros, ResultadoCalculo, StatusGate } from "../domain/index.js";
import { ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import type { AtletaBase, DadosAtleta } from "../repositories/atletas.js";
import { carregarParametros } from "../repositories/parametros.js";
import { avaliarAtletas, carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const NOMES_GATES: Record<number, string> = {
  1: "Class Fit",
  2: "Evidência competitiva",
  3: "Alto rendimento",
  4: "Campanha",
};

const statusGate = z.enum(["apto", "condicional", "alerta"]);
const statusFinal = z.enum(["apto", "condicional", "nao_prioritario"]);
const faixa = z.object({ id: z.string(), nome: z.string(), nomeCurto: z.string() });

const esquemaNota = z
  .object({
    indicadorId: z.string().min(1).max(64),
    valor: z.number().int().min(0).max(5),
    evidencia: z.string().trim().min(3).max(500),
    /** Evidência anexada antes (POST /atletas/:id/evidencias), do mesmo atleta. A prévia ignora. */
    anexoId: z.uuid().optional(),
  })
  .strict();

const esquemaMedida = z
  .object({
    pesoKg: z.number().min(30).max(160).optional(),
    alturaCm: z.number().min(120).max(230).optional(),
    evidencia: z.string().trim().min(3).max(200).optional(),
  })
  .strict()
  .refine((m) => m.pesoKg !== undefined || m.alturaCm !== undefined, {
    message: "Informe o peso ou a altura.",
  });

const esquemaCorpo = z
  .object({
    notas: z.array(esquemaNota).max(60).default([]),
    medida: esquemaMedida.optional(),
  })
  .strict()
  .refine((c) => c.notas.length > 0 || c.medida !== undefined, {
    message: "Informe ao menos uma nota ou uma medida.",
  });
type Corpo = z.infer<typeof esquemaCorpo>;

const esquemaGates = z.object({
  statusFinal,
  itens: z.array(
    z.object({
      gate: z.number().int(),
      nome: z.string(),
      status: statusGate,
      motivo: z.string(),
      sugestaoAutomatica: statusGate,
      ajustadoPeloGestor: z.boolean(),
    }),
  ),
});

const esquemaParams = z.object({ id: z.uuid() });

const requisicaoInvalida = (m: string) => new ErroApi(400, "requisicao_invalida", m);

const fmtDecimal = (v: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/** Rejeita indicador inexistente, calculado, tipo R ou repetido. */
function validarNotas(parametros: Parametros, corpo: Corpo): void {
  const indicadores = new Map(
    parametros.pilares.flatMap((p) => p.indicadores).map((i) => [i.id, i]),
  );
  const vistos = new Set<string>();
  for (const n of corpo.notas) {
    const ind = indicadores.get(n.indicadorId);
    if (!ind) throw requisicaoInvalida(`Indicador inexistente: ${n.indicadorId}.`);
    if (ind.calculado) {
      throw requisicaoInvalida(
        `O indicador ${n.indicadorId} é calculado pelo sistema: informe o peso na medida.`,
      );
    }
    if (ind.tipo === "R") {
      throw requisicaoInvalida(`O indicador ${n.indicadorId} é só registro e não recebe nota.`);
    }
    if (vistos.has(n.indicadorId))
      throw requisicaoInvalida(`Indicador repetido no envio: ${n.indicadorId}.`);
    vistos.add(n.indicadorId);
  }
}

/** Dados do atleta como ficariam depois do lançamento (sem gravar). */
function aplicarProposta(dados: DadosAtleta, corpo: Corpo, agora: Date): DadosAtleta {
  const notas = new Map(dados.notas.map((n) => [n.indicadorId, n]));
  for (const n of corpo.notas) {
    notas.set(n.indicadorId, {
      indicadorId: n.indicadorId,
      valor: n.valor,
      evidencia: n.evidencia,
      origem: dados.respostas[n.indicadorId] ? "resposta_confirmada" : "avaliacao",
      avaliador: null,
      lancadoEm: agora.toISOString(),
      anexo: null,
    });
  }
  const medida = { ...dados.medida };
  if (corpo.medida?.pesoKg !== undefined) medida.pesoKg = corpo.medida.pesoKg;
  if (corpo.medida?.alturaCm !== undefined) medida.alturaCm = corpo.medida.alturaCm;
  return { ...dados, notas: [...notas.values()], medida };
}

const resumo = (c: ResultadoCalculo) => ({
  score: c.score,
  faixa: { id: c.faixa.id, nome: c.faixa.nome, nomeCurto: c.faixa.nomeCurto },
});

const itensGates = (c: ResultadoCalculo) => ({
  statusFinal: c.statusFinal,
  itens: c.gates.map((g) => ({
    gate: g.gate,
    nome: NOMES_GATES[g.gate] ?? `G${g.gate}`,
    status: g.status,
    motivo: g.motivo,
    sugestaoAutomatica: g.sugestaoAutomatica,
    ajustadoPeloGestor: g.ajustadoPeloGestor,
  })),
});

async function avaliarUm(db: Db, parametros: Parametros, atleta: AtletaBase, referencia: Date) {
  const [avaliado] = await carregarEAvaliarAtletas(db, parametros, [atleta], referencia);
  if (!avaliado) throw naoEncontrado("Atleta não encontrado.");
  return avaliado;
}

export async function rotasAvaliacoes(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const acessoAvaliador = [app.autenticar, exigirPapel("gestor", "treinador")];

  rota.post(
    "/atletas/:id/avaliacoes/previa",
    {
      preHandler: acessoAvaliador,
      schema: {
        tags: ["avaliacoes"],
        summary: "Prévia do lançamento: score antes e depois, sem gravar",
        security: [{ bearerAuth: [] }],
        params: esquemaParams,
        body: esquemaCorpo,
        response: {
          200: z.object({
            antes: z.object({
              score: z.number(),
              faixa,
              pilares: z.array(z.object({ id: z.string(), nota: z.number().nullable() })),
            }),
            depois: z.object({
              score: z.number(),
              faixa,
              pilares: z.array(z.object({ id: z.string(), nota: z.number().nullable() })),
              statusGates: statusFinal,
            }),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, req.usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      validarNotas(parametros, req.body);

      const antes = await avaliarUm(app.db, parametros, base, referencia);
      const [depois] = avaliarAtletas(
        parametros,
        [base],
        new Map([[base.id, aplicarProposta(antes.dados, req.body, referencia)]]),
        referencia,
      );
      if (!depois) throw naoEncontrado("Atleta não encontrado.");
      const pilares = (c: ResultadoCalculo) =>
        c.pilares.map((p) => ({ id: p.pilarId, nota: p.nota }));
      return {
        antes: { ...resumo(antes.calculo), pilares: pilares(antes.calculo) },
        depois: {
          ...resumo(depois.calculo),
          pilares: pilares(depois.calculo),
          statusGates: depois.calculo.statusFinal,
        },
      };
    },
  );

  rota.post(
    "/atletas/:id/avaliacoes",
    {
      preHandler: acessoAvaliador,
      schema: {
        tags: ["avaliacoes"],
        summary: "Lança notas e/ou medida do atleta (série histórica: só insere)",
        description:
          "Origem da nota: resposta_confirmada se o atleta respondeu à pergunta do indicador, senão avaliacao. Indicador calculado (peso) ou tipo R é recusado.",
        security: [{ bearerAuth: [] }],
        params: esquemaParams,
        body: esquemaCorpo,
        response: {
          201: z.object({
            antes: z.object({ score: z.number(), faixa }),
            depois: z.object({ score: z.number(), faixa, statusGates: statusFinal }),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const referencia = app.agora();
      const { usuario, body } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      validarNotas(parametros, body);

      const anexoIds = [...new Set(body.notas.flatMap((n) => (n.anexoId ? [n.anexoId] : [])))];
      if (anexoIds.length > 0) {
        const ok = await app.db.query<{ id: string }>(
          `select id from evidencias_anexos where atleta_id = $1::uuid and id = any($2::uuid[])`,
          [base.id, anexoIds],
        );
        if (ok.rows.length !== anexoIds.length)
          throw requisicaoInvalida("Anexo inexistente ou de outro atleta.");
      }

      const resultado = await app.db.transacao(async (tx) => {
        const antes = await avaliarUm(tx, parametros, base, referencia);
        const ciclo = await tx.query<{ id: string }>(
          `select id from ciclos_avaliacao where status = 'aberto' limit 1`,
        );
        const cicloId = ciclo.rows[0]?.id ?? null;

        for (const n of body.notas) {
          await tx.query(
            `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em, anexo_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              base.id,
              n.indicadorId,
              cicloId,
              n.valor,
              n.evidencia,
              antes.dados.respostas[n.indicadorId] ? "resposta_confirmada" : "avaliacao",
              usuario.id,
              referencia,
              n.anexoId ?? null,
            ],
          );
        }

        const m = body.medida;
        if (m) {
          const evidencia =
            m.evidencia ??
            (m.pesoKg !== undefined
              ? `Pesagem: ${fmtDecimal(m.pesoKg)} kg`
              : `Altura: ${fmtDecimal(m.alturaCm ?? 0)} cm`);
          await tx.query(
            `insert into medidas_corporais (atleta_id, peso_kg, altura_cm, medido_em, evidencia, registrado_por)
             values ($1, $2, $3, $4, $5, $6)`,
            [base.id, m.pesoKg ?? null, m.alturaCm ?? null, referencia, evidencia, usuario.id],
          );
        }

        // Auditoria sem valores: só ids de indicador e nomes de campo.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'lancar_avaliacao', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({
              indicadores: body.notas.map((n) => n.indicadorId),
              comAnexo: body.notas.some((n) => n.anexoId),
              medida: m
                ? [
                    m.pesoKg !== undefined ? "pesoKg" : null,
                    m.alturaCm !== undefined ? "alturaCm" : null,
                  ].filter(Boolean)
                : [],
              cicloId,
            }),
            referencia,
          ],
        );

        const depois = await avaliarUm(tx, parametros, base, referencia);
        return { antes: antes.calculo, depois: depois.calculo };
      });

      return reply.code(201).send({
        antes: resumo(resultado.antes),
        depois: { ...resumo(resultado.depois), statusGates: resultado.depois.statusFinal },
      });
    },
  );

  rota.put(
    "/atletas/:id/gates",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["avaliacoes"],
        summary: "Decisão do gestor sobre um gate (nulo ou igual à sugestão volta ao automático)",
        security: [{ bearerAuth: [] }],
        params: esquemaParams,
        body: z
          .object({
            gate: z.number().int().min(1).max(4),
            status: statusGate.nullable(),
            justificativa: z.string().trim().max(500).optional(),
          })
          .strict(),
        response: {
          200: esquemaGates,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const referencia = app.agora();
      const { usuario, body } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);

      const calculo = await app.db.transacao(async (tx) => {
        const atual = await avaliarUm(tx, parametros, base, referencia);
        const sugestao = atual.calculo.gates[body.gate - 1]?.sugestaoAutomatica;
        if (!sugestao) throw requisicaoInvalida("Gate inexistente.");
        const status: StatusGate | null = body.status === sugestao ? null : body.status;

        await tx.query(
          `insert into gates_decisoes (atleta_id, gate, status, justificativa, decidido_por, decidido_em)
           values ($1, $2, $3, $4, $5, $6)`,
          [base.id, body.gate, status, body.justificativa || null, usuario.id, referencia],
        );
        // Sem o texto da justificativa nem o status na auditoria.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'decidir_gate', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({
              gate: body.gate,
              voltouAoAutomatico: status === null,
              comJustificativa: !!body.justificativa,
            }),
            referencia,
          ],
        );
        return (await avaliarUm(tx, parametros, base, referencia)).calculo;
      });
      return itensGates(calculo);
    },
  );
}

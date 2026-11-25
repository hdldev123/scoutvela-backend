import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { NIVEIS_DE_NOTA, INDICADOR_DO_NIVEL } from "../domain/index.js";
import type { Parametros, ResultadoCalculo, StatusGate } from "../domain/index.js";
import { ErroApi, esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import { esquemaLinkHttps } from "../validacao.js";
import { recusarAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import type { AtletaBase, DadosAtleta } from "../repositories/atletas.js";
import { sugestoesDoCicloAberto } from "../repositories/autoavaliacao.js";
import type { SugestaoDoAtleta } from "../repositories/autoavaliacao.js";
import { avisarContasDoAtleta } from "../repositories/avisos.js";
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

export const esquemaNota = z
  .object({
    indicadorId: z.string().min(1, "Informe o indicador.").max(64),
    valor: z
      .number("Informe a nota (0 a 5).")
      .int("A nota deve ser um número inteiro.")
      .min(0, "A nota mínima é 0.")
      .max(5, "A nota máxima é 5."),
    evidencia: z
      .string("A evidência deve ser um texto.")
      .trim()
      .max(500, "A evidência pode ter no máximo 500 caracteres.")
      .refine((v) => v === "" || v.length >= 3, "A evidência precisa ter ao menos 3 caracteres.")
      .optional()
      .describe(
        "Texto da evidência. Obrigatório nos indicadores com evidência `obrigatoria` (GET /parametros); opcional nos demais. Vazio vale como ausente",
      ),
    link: esquemaLinkHttps
      .optional()
      .describe(
        "Link de vídeo ou outro conteúdo externo da nota: só https://, até 500 caracteres. A API não acessa o endereço. Vazio vale como ausente",
      ),
    /** Evidência anexada antes (POST /atletas/:id/evidencias), do mesmo atleta. A prévia ignora. */
    anexoId: z.uuid().optional(),
  })
  .strict();

/** Nota do treinador: a nota comum mais a justificativa (obrigatória só ao corrigir a sugestão do atleta). */
const esquemaNotaAvaliador = esquemaNota.extend({
  justificativa: z
    .string("A justificativa deve ser um texto.")
    .trim()
    .max(500, "A justificativa pode ter no máximo 500 caracteres.")
    .optional()
    .describe(
      "Obrigatória quando o atleta sugeriu (autoavaliação) outra nota para o indicador no ciclo aberto; opcional nos demais. Vazio vale como ausente",
    ),
});

const esquemaMedida = z
  .object({
    pesoKg: z
      .number("Informe o peso em kg.")
      .min(30, "O peso deve ficar entre 30 e 160 kg.")
      .max(160, "O peso deve ficar entre 30 e 160 kg.")
      .optional(),
    alturaCm: z
      .number("Informe a altura em cm.")
      .min(120, "A altura deve ficar entre 120 e 230 cm.")
      .max(230, "A altura deve ficar entre 120 e 230 cm.")
      .optional(),
    evidencia: z
      .string()
      .trim()
      .min(3, "A evidência da medida precisa ter ao menos 3 caracteres.")
      .max(200, "A evidência da medida pode ter no máximo 200 caracteres.")
      .optional(),
  })
  .strict()
  .refine((m) => m.pesoKg !== undefined || m.alturaCm !== undefined, {
    message: "Informe o peso ou a altura.",
  });

const esquemaCorpo = z
  .object({
    notas: z.array(esquemaNotaAvaliador).max(60).default([]),
    medida: esquemaMedida.optional(),
  })
  .strict()
  .refine((c) => c.notas.length > 0 || c.medida !== undefined, {
    message: "Informe ao menos uma nota ou uma medida.",
  });
type Corpo = z.infer<typeof esquemaCorpo>;

/** Texto e link vazios valem como ausentes (o formulário pode mandar "" num campo opcional). */
function semVazios(corpo: Corpo): Corpo {
  return {
    ...corpo,
    notas: corpo.notas.map(({ evidencia, link, justificativa, ...resto }) => ({
      ...resto,
      ...(evidencia ? { evidencia } : {}),
      ...(link ? { link } : {}),
      ...(justificativa ? { justificativa } : {}),
    })),
  };
}

type OrigemLancada = "avaliacao" | "resposta_confirmada" | "autoavaliacao_aprovada";

interface DecisaoDaNota {
  origem: OrigemLancada;
  /** A nota difere da sugestão do atleta (o atleta é avisado). */
  corrigiu: boolean;
}

/**
 * Origem de cada nota e a regra da justificativa. Com sugestão do atleta (autoavaliação) no ciclo
 * aberto: nota igual aprova (`autoavaliacao_aprovada`); nota diferente corrige e exige justificativa
 * (400 em `notas.N.justificativa`). Sem sugestão, segue como sempre (`avaliacao` ou `resposta_confirmada`).
 */
function decidirNotas(
  corpo: Corpo,
  sugestoes: Map<string, SugestaoDoAtleta>,
  respostas: Record<string, string>,
): DecisaoDaNota[] {
  const semJustificativa: { campo: string; mensagem: string }[] = [];
  const decisoes = corpo.notas.map((n, i): DecisaoDaNota => {
    const sug = sugestoes.get(n.indicadorId);
    const comum = respostas[n.indicadorId] ? "resposta_confirmada" : "avaliacao";
    if (!sug) return { origem: comum, corrigiu: false };
    if (sug.valor === n.valor) return { origem: "autoavaliacao_aprovada", corrigiu: false };
    if (!n.justificativa) {
      semJustificativa.push({
        campo: `notas.${i}.justificativa`,
        mensagem: "Informe a justificativa: a nota difere da sugestão do atleta.",
      });
    }
    return { origem: comum, corrigiu: true };
  });
  if (semJustificativa.length > 0) {
    throw requisicaoInvalidaCampos(
      semJustificativa,
      "Há nota diferente da sugestão do atleta sem justificativa.",
    );
  }
  return decisoes;
}

const esquemaSugestaoAtleta = z.object({
  indicadorId: z.string(),
  valor: z.number().int().describe("Nota sugerida pelo atleta, de 0 a 5"),
  evidencia: z.string().nullable(),
  link: z.string().nullable(),
  anexo: z.object({ id: z.string(), nomeArquivo: z.string() }).nullable(),
  em: z.string().describe("Instante ISO"),
});

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
  const semEvidencia: { campo: string; mensagem: string }[] = [];
  for (const [i, n] of corpo.notas.entries()) {
    const ind = indicadores.get(n.indicadorId);
    if (!ind) throw requisicaoInvalida(`Indicador inexistente: ${n.indicadorId}.`);
    if (ind.calculado) {
      const deResultado = NIVEIS_DE_NOTA.some((nivel) => INDICADOR_DO_NIVEL[nivel] === ind.id);
      throw requisicaoInvalida(
        deResultado
          ? `O indicador ${n.indicadorId} é calculado pelo sistema a partir dos resultados validados do atleta.`
          : `O indicador ${n.indicadorId} é calculado pelo sistema: informe o peso na medida.`,
      );
    }
    if (ind.tipo === "R") {
      throw requisicaoInvalida(`O indicador ${n.indicadorId} é só registro e não recebe nota.`);
    }
    if (vistos.has(n.indicadorId))
      throw requisicaoInvalida(`Indicador repetido no envio: ${n.indicadorId}.`);
    vistos.add(n.indicadorId);
    if (ind.evidencia === "obrigatoria" && !n.evidencia) {
      semEvidencia.push({
        campo: `notas.${i}.evidencia`,
        mensagem: "Informe a evidência da nota: este indicador a exige.",
      });
    }
  }
  if (semEvidencia.length > 0) {
    throw requisicaoInvalidaCampos(semEvidencia, "Há nota sem a evidência exigida pelo indicador.");
  }
}

const umaCasa = (v: number) => Math.round(v * 10) / 10;

/** Peso e altura são `numeric(5,1)` no banco: a prévia e a gravação usam o valor já com 1 casa. */
function arredondarMedida(corpo: Corpo): Corpo {
  const m = corpo.medida;
  if (!m) return corpo;
  return {
    ...corpo,
    medida: {
      ...m,
      ...(m.pesoKg !== undefined ? { pesoKg: umaCasa(m.pesoKg) } : {}),
      ...(m.alturaCm !== undefined ? { alturaCm: umaCasa(m.alturaCm) } : {}),
    },
  };
}

/** Dados do atleta como ficariam depois do lançamento (sem gravar). */
function aplicarProposta(
  dados: DadosAtleta,
  corpo: Corpo,
  decisoes: DecisaoDaNota[],
  agora: Date,
): DadosAtleta {
  const notas = new Map(dados.notas.map((n) => [n.indicadorId, n]));
  for (const [i, n] of corpo.notas.entries()) {
    notas.set(n.indicadorId, {
      indicadorId: n.indicadorId,
      valor: n.valor,
      evidencia: n.evidencia ?? null,
      link: n.link ?? null,
      origem: decisoes[i]!.origem,
      justificativa: n.justificativa ?? null,
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
            sugestoesAtleta: z
              .array(esquemaSugestaoAtleta)
              .describe(
                "Sugestões do atleta (autoavaliação) no ciclo aberto, uma por indicador, para a tela mostrar ao lado da nota. Vazio sem sugestão ou sem ciclo aberto",
              ),
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
      const base = await buscarAtletaVisivel(app.db, req.usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      const corpo = semVazios(arredondarMedida(req.body));
      validarNotas(parametros, corpo);

      const antes = await avaliarUm(app.db, parametros, base, referencia);
      const aberto = await sugestoesDoCicloAberto(app.db, base.id);
      const sugestoes = aberto?.sugestoes ?? new Map<string, SugestaoDoAtleta>();
      const decisoes = decidirNotas(corpo, sugestoes, antes.dados.respostas);
      const [depois] = avaliarAtletas(
        parametros,
        [base],
        new Map([[base.id, aplicarProposta(antes.dados, corpo, decisoes, referencia)]]),
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
        sugestoesAtleta: [...sugestoes].map(([indicadorId, s]) => ({ indicadorId, ...s })),
      };
    },
  );

  rota.post(
    "/atletas/:id/avaliacoes",
    {
      preHandler: [...acessoAvaliador, recusarAtletaAnonimizado(app)],
      schema: {
        tags: ["avaliacoes"],
        summary: "Lança notas e/ou medida do atleta (série histórica: só insere)",
        description:
          "Origem da nota: se o atleta sugeriu a nota (autoavaliação) no ciclo aberto, nota igual grava `autoavaliacao_aprovada` e nota diferente grava a correção, com `justificativa` obrigatória (400 em `notas.N.justificativa`) e aviso `autoavaliacao_corrigida` ao atleta. Sem sugestão: resposta_confirmada se o atleta respondeu à pergunta do indicador, senão avaliacao (justificativa opcional). Indicador calculado (o peso e os de resultado: perf_mundial, perf_continental, perf_nacional) ou tipo R é recusado (400).",
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
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const referencia = app.agora();
      const { usuario } = req;
      const body = semVazios(arredondarMedida(req.body));
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);
      validarNotas(parametros, body);

      const anexoIds = [...new Set(body.notas.flatMap((n) => (n.anexoId ? [n.anexoId] : [])))];

      const resultado = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id);
        if (anexoIds.length > 0) {
          // `for share`: uma remoção do anexo em andamento termina antes; anexo removido não liga.
          const ok = await tx.query<{ id: string }>(
            `select id from evidencias_anexos
              where atleta_id = $1::uuid and id = any($2::uuid[]) and removido_em is null for share`,
            [base.id, anexoIds],
          );
          if (ok.rows.length !== anexoIds.length)
            throw requisicaoInvalida("Anexo inexistente, removido ou de outro atleta.");
        }
        const antes = await avaliarUm(tx, parametros, base, referencia);
        const ciclo = await tx.query<{ id: string }>(
          `select id from ciclos_avaliacao where status = 'aberto' limit 1 for share`,
        );
        const cicloId = ciclo.rows[0]?.id ?? null;
        const aberto = await sugestoesDoCicloAberto(tx, base.id);
        const decisoes = decidirNotas(
          body,
          aberto?.sugestoes ?? new Map<string, SugestaoDoAtleta>(),
          antes.dados.respostas,
        );

        for (const [i, n] of body.notas.entries()) {
          await tx.query(
            `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, link, origem, avaliador_id, lancado_em, anexo_id, justificativa)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              base.id,
              n.indicadorId,
              cicloId,
              n.valor,
              n.evidencia ?? null,
              n.link ?? null,
              decisoes[i]!.origem,
              usuario.id,
              referencia,
              n.anexoId ?? null,
              n.justificativa ?? null,
            ],
          );
          if (decisoes[i]!.corrigiu) {
            await avisarContasDoAtleta(tx, base.id, {
              tipo: "autoavaliacao_corrigida",
              referencia: { indicadorId: n.indicadorId },
              autorId: usuario.id,
              em: referencia,
            });
          }
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
              comLink: body.notas.some((n) => n.link),
              aprovouSugestao: decisoes.some((d) => d.origem === "autoavaliacao_aprovada"),
              corrigiuSugestao: decisoes.some((d) => d.corrigiu),
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
      preHandler: [app.autenticar, exigirPapel("gestor"), recusarAtletaAnonimizado(app)],
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
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const referencia = app.agora();
      const { usuario, body } = req;
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const parametros = await carregarParametros(app.db);

      const calculo = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id);
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

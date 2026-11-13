import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalida } from "../erros.js";
import { listarAtletasVisiveis } from "../repositories/atletas.js";
import { carregarParametros } from "../repositories/parametros.js";
import { diasParaPrazo, pendenciasDoCiclo } from "../repositories/pendencias.js";
import { carregarEAvaliarAtletas } from "../servicos/avaliacao-atletas.js";

const dataIso = z.iso.date().describe("AAAA-MM-DD");

const esquemaCiclo = z.object({
  id: z.uuid(),
  nome: z.string(),
  inicio: z.string().describe("AAAA-MM-DD"),
  prazo: z.string().describe("AAAA-MM-DD"),
  status: z.enum(["aberto", "fechado"]),
  atletasComScore: z.number().int().describe("Atletas com score congelado neste ciclo"),
  fechadoEm: z.string().nullable().describe("Instante ISO do fechamento; nulo se aberto"),
});
type Ciclo = z.infer<typeof esquemaCiclo>;

interface LinhaCiclo {
  id: string;
  nome: string;
  inicio: string;
  prazo: string;
  status: "aberto" | "fechado";
  atletas_com_score: string;
  fechado_em: Date | null;
}

const SQL_CICLO = `select c.id, c.nome, c.inicio::text as inicio, c.prazo::text as prazo, c.status,
                          (select count(*)::text from scores_ciclo s where s.ciclo_id = c.id) as atletas_com_score,
                          (select max(s.calculado_em) from scores_ciclo s where s.ciclo_id = c.id) as fechado_em
                     from ciclos_avaliacao c`;

const paraCiclo = (l: LinhaCiclo): Ciclo => ({
  id: l.id,
  nome: l.nome,
  inicio: l.inicio,
  prazo: l.prazo,
  status: l.status,
  atletasComScore: Number(l.atletas_com_score),
  fechadoEm: l.status === "aberto" || !l.fechado_em ? null : new Date(l.fechado_em).toISOString(),
});

async function buscarCiclo(db: Db, id: string, bloquear = false): Promise<Ciclo | null> {
  if (bloquear) await db.query(`select id from ciclos_avaliacao where id = $1 for update`, [id]);
  const r = await db.query<LinhaCiclo>(`${SQL_CICLO} where c.id = $1`, [id]);
  return r.rows[0] ? paraCiclo(r.rows[0]) : null;
}

const ehViolacaoUnica = (e: unknown) => (e as { code?: string })?.code === "23505";

export async function rotasCiclos(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const acesso = [app.autenticar, exigirPapel("gestor")];
  const seguranca = [{ bearerAuth: [] }];
  const params = z.object({ id: z.uuid() });
  const erros = { 400: esquemaErro, 401: esquemaErro, 403: esquemaErro };

  rota.get(
    "/ciclos",
    {
      preHandler: acesso,
      schema: {
        tags: ["ciclos"],
        summary: "Lista os ciclos de avaliação, do mais recente ao mais antigo",
        security: seguranca,
        response: { 200: z.object({ itens: z.array(esquemaCiclo) }), ...erros },
      },
    },
    async () => {
      const r = await app.db.query<LinhaCiclo>(`${SQL_CICLO} order by c.inicio desc, c.id`);
      return { itens: r.rows.map(paraCiclo) };
    },
  );

  rota.post(
    "/ciclos",
    {
      preHandler: acesso,
      schema: {
        tags: ["ciclos"],
        summary: "Abre um ciclo de avaliação (só um aberto por vez)",
        security: seguranca,
        body: z
          .object({ nome: z.string().trim().min(3).max(60), inicio: dataIso, prazo: dataIso })
          .strict(),
        response: { 201: esquemaCiclo, ...erros, 409: esquemaErro },
      },
    },
    async (req, reply) => {
      const { nome, inicio, prazo } = req.body;
      if (prazo < inicio) throw requisicaoInvalida("O prazo não pode ser anterior ao início.");
      const agora = app.agora();
      try {
        const ciclo = await app.db.transacao(async (tx) => {
          const aberto = await tx.query(`select 1 from ciclos_avaliacao where status = 'aberto'`);
          if (aberto.rows.length > 0)
            throw conflito("Já existe um ciclo aberto. Feche-o antes de abrir outro.");
          const repetido = await tx.query(
            `select 1 from ciclos_avaliacao where lower(nome) = lower($1)`,
            [nome],
          );
          if (repetido.rows.length > 0) throw conflito("Já existe um ciclo com este nome.");
          const r = await tx.query<{ id: string }>(
            `insert into ciclos_avaliacao (nome, inicio, prazo, status) values ($1, $2, $3, 'aberto') returning id`,
            [nome, inicio, prazo],
          );
          const id = r.rows[0]!.id;
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
             values ($1, 'abrir_ciclo', 'ciclo', $2, $3::jsonb, $4)`,
            [req.usuario.id, id, JSON.stringify({ campos: ["nome", "inicio", "prazo"] }), agora],
          );
          return (await buscarCiclo(tx, id))!;
        });
        return reply.code(201).send(ciclo);
      } catch (e) {
        if (ehViolacaoUnica(e)) throw conflito("Já existe um ciclo aberto ou com este nome.");
        throw e;
      }
    },
  );

  rota.put(
    "/ciclos/:id",
    {
      preHandler: acesso,
      schema: {
        tags: ["ciclos"],
        summary: "Prorroga ou ajusta o prazo de um ciclo aberto",
        security: seguranca,
        params,
        body: z.object({ prazo: dataIso }).strict(),
        response: { 200: esquemaCiclo, ...erros, 404: esquemaErro, 409: esquemaErro },
      },
    },
    async (req) => {
      const agora = app.agora();
      return app.db.transacao(async (tx) => {
        const atual = await buscarCiclo(tx, req.params.id, true);
        if (!atual) throw naoEncontrado("Ciclo não encontrado.");
        if (atual.status !== "aberto")
          throw conflito("Só é possível alterar o prazo de um ciclo aberto.");
        if (req.body.prazo < atual.inicio)
          throw requisicaoInvalida("O prazo não pode ser anterior ao início.");
        await tx.query(`update ciclos_avaliacao set prazo = $2 where id = $1`, [
          atual.id,
          req.body.prazo,
        ]);
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'ajustar_prazo_ciclo', 'ciclo', $2, $3::jsonb, $4)`,
          [req.usuario.id, atual.id, JSON.stringify({ campos: ["prazo"] }), agora],
        );
        return (await buscarCiclo(tx, atual.id))!;
      });
    },
  );

  rota.post(
    "/ciclos/:id/fechar",
    {
      preHandler: acesso,
      schema: {
        tags: ["ciclos"],
        summary: "Fecha o ciclo e congela o score e a faixa dos atletas do piloto",
        description:
          "Calcula score e faixa de todos os atletas ativos com o termo do piloto aceito, grava em scores_ciclo e marca o ciclo como fechado, numa transação. Alimenta o histórico de score da ficha.",
        security: seguranca,
        params,
        response: {
          200: z.object({ ciclo: esquemaCiclo, atletas: z.number().int() }),
          ...erros,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const agora = app.agora();
      const gestor = { id: req.usuario.id, papel: "gestor" as const, atletaId: null };
      const parametros = await carregarParametros(app.db);
      return app.db.transacao(async (tx) => {
        const atual = await buscarCiclo(tx, req.params.id, true);
        if (!atual) throw naoEncontrado("Ciclo não encontrado.");
        if (atual.status !== "aberto") throw conflito("Este ciclo já está fechado.");

        const atletas = await listarAtletasVisiveis(tx, gestor, {
          somenteTermoAceito: true,
          agora,
        });
        const avaliados = await carregarEAvaliarAtletas(tx, parametros, atletas, agora);
        for (const x of avaliados) {
          await tx.query(
            `insert into scores_ciclo (atleta_id, ciclo_id, score, faixa_id, calculado_em) values ($1, $2, $3, $4, $5)`,
            [x.atleta.id, atual.id, x.calculo.score, x.calculo.faixa.id, agora],
          );
        }
        await tx.query(`update ciclos_avaliacao set status = 'fechado' where id = $1`, [atual.id]);
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'fechar_ciclo', 'ciclo', $2, $3::jsonb, $4)`,
          [req.usuario.id, atual.id, JSON.stringify({ atletas: avaliados.length }), agora],
        );
        return { ciclo: (await buscarCiclo(tx, atual.id))!, atletas: avaliados.length };
      });
    },
  );

  rota.get(
    "/ciclos/:id/pendencias",
    {
      preHandler: acesso,
      schema: {
        tags: ["ciclos"],
        summary: "Quem está atrasado no ciclo aberto: treinadores e atletas com pendência",
        description:
          "Mesma regra do job de lembretes. Só atletas ativos com o termo do piloto aceito. Treinador: atletas sem nota no ciclo em algum indicador T (faltam = indicadores sem nota). Atleta: perguntas do questionário sem resposta. diasParaPrazo é negativo depois do prazo. Ciclo fechado: 409.",
        security: seguranca,
        params,
        response: {
          200: z.object({
            treinadores: z.array(
              z.object({
                id: z.string(),
                nome: z.string(),
                atletasPendentes: z.array(
                  z.object({ id: z.string(), nome: z.string(), faltam: z.number().int() }),
                ),
              }),
            ),
            atletas: z.array(
              z.object({
                id: z.string(),
                nome: z.string(),
                perguntasSemResposta: z.number().int(),
              }),
            ),
            totais: z.object({
              treinadoresComPendencia: z.number().int(),
              atletasComPendencia: z.number().int(),
              diasParaPrazo: z.number().int(),
            }),
          }),
          ...erros,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const agora = app.agora();
      const ciclo = await buscarCiclo(app.db, req.params.id);
      if (!ciclo) throw naoEncontrado("Ciclo não encontrado.");
      if (ciclo.status !== "aberto") {
        throw conflito("O ciclo está fechado: as pendências só valem para o ciclo aberto.");
      }
      const p = await pendenciasDoCiclo(app.db, ciclo.id, agora);
      // Sem e-mail na resposta: a tela só precisa de quem e quanto falta.
      return {
        treinadores: p.treinadores.map((t) => ({
          id: t.id,
          nome: t.nome,
          atletasPendentes: t.atletasPendentes,
        })),
        atletas: p.atletas.map((a) => ({
          id: a.id,
          nome: a.nome,
          perguntasSemResposta: a.perguntasSemResposta,
        })),
        totais: {
          treinadoresComPendencia: p.treinadores.length,
          atletasComPendencia: p.atletas.length,
          diasParaPrazo: diasParaPrazo(ciclo.prazo, agora),
        },
      };
    },
  );
}

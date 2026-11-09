import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro } from "../erros.js";

const dataIso = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a data no formato AAAA-MM-DD.")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
  }, "Data inválida.");

const esquemaConsulta = z.object({
  entidade: z.string().min(1).max(60).optional(),
  acao: z.string().min(1).max(60).optional(),
  usuarioId: z.uuid("usuarioId inválido.").optional(),
  atletaId: z.string().min(1).max(64).optional().describe("Identificador da entidade afetada (entidade_id), em geral o atleta"),
  desde: dataIso.optional().describe("AAAA-MM-DD, a partir das 00:00 de Brasília"),
  ate: dataIso.optional().describe("AAAA-MM-DD, até o fim do dia em Brasília"),
  limite: z.coerce.number().int().min(1).max(200).default(50),
  antesDe: z.string().regex(/^\d{1,18}$/, "Cursor inválido.").optional().describe("id do último item da página anterior"),
});

const esquemaResposta = z.object({
  itens: z.array(
    z.object({
      id: z.string(),
      em: z.string().describe("Instante ISO"),
      usuario: z.object({ id: z.string(), nome: z.string(), papel: z.string() }).nullable(),
      acao: z.string(),
      entidade: z.string(),
      entidadeId: z.string().nullable(),
      detalhes: z.unknown(),
    }),
  ),
  proximo: z.string().nullable().describe("Passe em antesDe para a página seguinte; nulo = fim"),
});

interface LinhaAuditoria {
  id: string;
  em: Date;
  usuario_id: string | null;
  usuario_nome: string | null;
  usuario_papel: string | null;
  acao: string;
  entidade: string;
  entidade_id: string | null;
  detalhes: unknown;
}

const FUSO = "America/Sao_Paulo";

export async function rotasAuditoria(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.get(
    "/auditoria",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["auditoria"],
        summary: "Trilha de auditoria (só gestor), do mais novo para o mais antigo",
        description: "Filtros opcionais combinados com E. Paginação por cursor: use `proximo` em `antesDe`.",
        security: [{ bearerAuth: [] }],
        querystring: esquemaConsulta,
        response: { 200: esquemaResposta, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const q = req.query;
      const params: unknown[] = [];
      const condicoes: string[] = [];
      const add = (valor: unknown, sql: (n: string) => string) => {
        params.push(valor);
        condicoes.push(sql(`$${params.length}`));
      };
      if (q.entidade) add(q.entidade, (n) => `a.entidade = ${n}`);
      if (q.acao) add(q.acao, (n) => `a.acao = ${n}`);
      if (q.usuarioId) add(q.usuarioId, (n) => `a.usuario_id = ${n}::uuid`);
      if (q.atletaId) add(q.atletaId, (n) => `a.entidade_id = ${n}`);
      if (q.desde) add(q.desde, (n) => `a.em >= (${n}::date)::timestamp at time zone '${FUSO}'`);
      if (q.ate) add(q.ate, (n) => `a.em < ((${n}::date + 1)::timestamp at time zone '${FUSO}')`);
      if (q.antesDe) add(q.antesDe, (n) => `a.id < ${n}::bigint`);
      params.push(q.limite + 1);

      const res = await app.db.query<LinhaAuditoria>(
        `select a.id::text as id, a.em, a.usuario_id, u.nome as usuario_nome, u.papel as usuario_papel,
                a.acao, a.entidade, a.entidade_id, a.detalhes
           from auditoria a
           left join usuarios u on u.id = a.usuario_id
          ${condicoes.length ? `where ${condicoes.join(" and ")}` : ""}
          order by a.id desc
          limit $${params.length}`,
        params,
      );
      const pagina = res.rows.slice(0, q.limite);
      return {
        itens: pagina.map((l) => ({
          id: l.id,
          em: new Date(l.em).toISOString(),
          usuario: l.usuario_id ? { id: l.usuario_id, nome: l.usuario_nome ?? "", papel: l.usuario_papel ?? "" } : null,
          acao: l.acao,
          entidade: l.entidade,
          entidadeId: l.entidade_id,
          detalhes: l.detalhes ?? null,
        })),
        proximo: res.rows.length > q.limite ? (pagina[pagina.length - 1]?.id ?? null) : null,
      };
    },
  );
}

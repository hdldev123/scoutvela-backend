import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { conflito, esquemaErro, requisicaoInvalida, semAcesso } from "../erros.js";
import { buscarTermoVigente, listarTermos } from "../repositories/termo.js";

const esquemaItemTermo = z.object({
  versao: z.string(),
  titulo: z.string(),
  vigenteDesde: z.string().describe("Instante ISO"),
  criadoEm: z.string().describe("Instante ISO"),
  vigente: z.boolean().describe("É a versão vigente agora"),
  futura: z.boolean().describe("Ainda não começou a valer"),
  aceites: z.number().int().describe("Atletas distintos com aceite concedido desta versão"),
});

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
          "Texto da versão vigente (a de maior vigente_desde que já começou). Qualquer usuário autenticado lê.",
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
    async () => buscarTermoVigente(app.db, app.agora()),
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
        const vigente = await buscarTermoVigente(tx, agora);
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

  r.get(
    "/termos",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["termo"],
        summary: "Versões do termo de consentimento (gestor)",
        description:
          "Da mais nova para a mais antiga, com a quantidade de aceites de cada uma. Sem o texto (o vigente vem em GET /termo).",
        security: seguranca,
        response: { 200: z.array(esquemaItemTermo), 401: esquemaErro, 403: esquemaErro },
      },
    },
    async () => listarTermos(app.db, app.agora()),
  );

  r.post(
    "/termos",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["termo"],
        summary: "Publica uma nova versão do termo (gestor)",
        description:
          "A versão passa a valer em vigenteDesde, que não pode estar no passado nem ser anterior ou igual à vigência de outra versão (inclusive futura). Quem aceitou só a anterior fica com aceite pendente; se o ranking os exclui depende da regra TERMO_EXIGE_REACEITE. A auditoria não guarda o texto.",
        security: seguranca,
        body: z
          .object({
            versao: z.string().trim().min(1).max(100),
            titulo: z.string().trim().min(3).max(200),
            texto: z.string().min(50).max(50000),
            vigenteDesde: z.iso.datetime({ offset: true }),
          })
          .strict(),
        response: {
          201: esquemaItemTermo,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { versao, titulo, texto } = req.body;
      const vigenteDesde = new Date(req.body.vigenteDesde);
      const agora = app.agora();
      if (vigenteDesde.getTime() < agora.getTime()) {
        throw requisicaoInvalida("A vigência não pode estar no passado.");
      }
      await app.db.transacao(async (tx) => {
        await tx.query("lock table termos_consentimento in share row exclusive mode");
        const igual = await tx.query("select 1 from termos_consentimento where versao = $1", [
          versao,
        ]);
        if (igual.rows.length > 0) throw requisicaoInvalida("Já existe um termo com esta versão.");
        const ultima = await tx.query<{ vigente_desde: Date }>(
          "select max(vigente_desde) as vigente_desde from termos_consentimento",
        );
        const maior = ultima.rows[0]?.vigente_desde;
        if (maior && vigenteDesde.getTime() <= new Date(maior).getTime()) {
          throw requisicaoInvalida(
            "A vigência precisa ser posterior à da versão mais recente (inclusive as futuras).",
          );
        }
        await tx.query(
          `insert into termos_consentimento (versao, titulo, texto, vigente_desde, criado_em)
           values ($1, $2, $3, $4, $5)`,
          [versao, titulo, texto, vigenteDesde, agora],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           values ($1, 'publicar_termo', 'termos_consentimento', null, $2::jsonb)`,
          [req.usuario.id, JSON.stringify({ versao, vigenteDesde: vigenteDesde.toISOString() })],
        );
      });
      const item = (await listarTermos(app.db, agora)).find((t) => t.versao === versao);
      if (!item) throw new Error("Termo publicado não encontrado.");
      return reply.code(201).send(item);
    },
  );
}

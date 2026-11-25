import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { dataIso } from "../domain/index.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel, carregarDadosAtletas } from "../repositories/atletas.js";
import { avisarContasDoAtleta, avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import {
  conquistasAutomaticas,
  lerConquista,
  listarConquistasManuais,
} from "../repositories/conquistas.js";

export const esquemaConquistaFicha = z.object({
  tipo: z
    .enum(["resultado", "manual"])
    .describe(
      "resultado: pódio de um resultado validado (calculado); manual: informada pelo atleta, com anexo, e validada",
    ),
  titulo: z.string(),
  ano: z.number().int().describe("Ano da edição (resultado) ou da conquista (manual)"),
  evento: z.string().optional().describe("Só nas conquistas de resultado"),
  nivel: z.string().optional().describe("Só nas conquistas de resultado"),
  posicao: z.number().int().optional().describe("Só nas conquistas de resultado (1 a 3)"),
});

const esquemaConquistaManual = z.object({
  id: z.uuid().describe("Identificador da conquista (PUT /conquistas/:id/validacao)"),
  titulo: z.string(),
  ano: z.number().int(),
  status: z.enum(["pendente", "validada", "recusada"]),
  motivo: z.string().nullable().describe("Motivo da recusa; nulo nas demais"),
  anexoId: z.uuid().describe("Prova anexada (GET /evidencias/:id/link)"),
  criadoEm: z.string().describe("Instante ISO"),
  decididoPor: z
    .object({ id: z.string(), nome: z.string() })
    .nullable()
    .describe("Quem validou ou recusou"),
  decididoEm: z.string().nullable().describe("Instante ISO"),
});

export async function rotasConquistas(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  rota.post(
    "/me/conquistas",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["conquistas"],
        summary: "O atleta informa uma conquista, com o anexo que a prova",
        description:
          "Só o atleta, no próprio cadastro completo. `anexoId` é o anexo do próprio atleta com categoria `evidencia` (POST /atletas/:id/evidencias), obrigatório, ainda não ligado a outra conquista: inexistente, removido, de outro atleta, de outra categoria ou já usado dá 400 em `anexoId`. `ano` de 1950 ao ano atual. Nasce `pendente`: só aparece na ficha depois da validação do treinador ou do gestor (PUT /conquistas/:id/validacao). Os pódios dos resultados validados entram sozinhos, sem esta rota. O anexo fica ligado e não pode mais ser removido. Avisa o treinador (`atleta_registrou_conquista`, `referencia: { conquistaId }`). Auditoria `registrar_conquista` só com ids e nomes de campo (sem o título).",
        security: seguranca,
        body: z
          .object({
            titulo: z
              .string("Informe o título da conquista.")
              .trim()
              .min(2, "O título precisa ter ao menos 2 caracteres.")
              .max(120, "O título pode ter no máximo 120 caracteres."),
            ano: z
              .number("Informe o ano.")
              .int("O ano deve ser um número inteiro.")
              .min(1950, "O ano deve ser a partir de 1950."),
            anexoId: z.uuid("Informe o anexo que comprova a conquista."),
          })
          .strict(),
        response: {
          201: esquemaConquistaManual,
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
      if (!usuario.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const agora = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, usuario.atletaId, agora);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const anoAtual = Number(dataIso(agora).slice(0, 4));
      if (body.ano > anoAtual) {
        throw requisicaoInvalidaCampos(
          [{ campo: "ano", mensagem: `O ano não pode passar de ${anoAtual}.` }],
          "Ano inválido.",
        );
      }

      const anexoInvalido = () =>
        requisicaoInvalidaCampos(
          [
            {
              campo: "anexoId",
              mensagem:
                "Anexo inexistente, removido, de outro atleta ou já usado em outra conquista. Envie o arquivo com a categoria evidencia.",
            },
          ],
          "Anexo inválido.",
        );
      const id = await app.db
        .transacao(async (tx) => {
          await travarAtletaEditavel(tx, base.id, { exigirAtivo: true });
          // `for share`: uma remoção do anexo em andamento termina antes; anexo removido não liga.
          const anexo = await tx.query(
            `select 1 from evidencias_anexos ea
            where ea.id = $1::uuid and ea.atleta_id = $2::uuid and ea.categoria = 'evidencia'
              and ea.removido_em is null
              and not exists (select 1 from conquistas_atleta c where c.anexo_id = ea.id)
              for share of ea`,
            [body.anexoId, base.id],
          );
          if (anexo.rows.length === 0) throw anexoInvalido();
          const ins = await tx.query<{ id: string }>(
            `insert into conquistas_atleta (atleta_id, titulo, ano, anexo_id, criado_em)
           values ($1::uuid, $2, $3, $4::uuid, $5) returning id::text as id`,
            [base.id, body.titulo, body.ano, body.anexoId, agora],
          );
          const novoId = ins.rows[0]!.id;
          // Sem o título: só ids e nomes de campo.
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'registrar_conquista', 'atleta', $2, $3::jsonb, $4)`,
            [
              usuario.id,
              base.id,
              JSON.stringify({
                conquistaId: novoId,
                anexoId: body.anexoId,
                campos: ["titulo", "ano", "anexoId"],
              }),
              agora,
            ],
          );
          await avisarTreinadorDoAtleta(tx, base.id, {
            tipo: "atleta_registrou_conquista",
            referencia: { conquistaId: novoId },
            autorId: usuario.id,
            em: agora,
          });
          return novoId;
        })
        .catch((e) => {
          // Dois envios com o mesmo anexo ao mesmo tempo: o índice único recusa o segundo.
          if ((e as { code?: string })?.code === "23505") throw anexoInvalido();
          throw e;
        });

      return reply.code(201).send(await lerConquista(app.db, id));
    },
  );

  rota.put(
    "/conquistas/:id/validacao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["conquistas"],
        summary: "Valida ou recusa uma conquista informada pelo atleta",
        description:
          "Gestor ou treinador do atleta (outro treinador e conquista inexistente: 404; atleta e IBVAR: 403). `recusar` exige `motivo` (até 300 caracteres; 400 em `motivo`). A decisão é definitiva: conquista já decidida dá 409 (o atleta informa outra). Só a validada aparece na ficha. Avisa o atleta (`conquista_validada` ou `conquista_recusada`, `referencia: { conquistaId }`). Auditoria `decidir_conquista` sem o título nem o motivo.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z
          .object({
            decisao: z.enum(["validar", "recusar"], { error: "Informe validar ou recusar." }),
            motivo: z
              .string("O motivo deve ser um texto.")
              .trim()
              .max(300, "O motivo pode ter no máximo 300 caracteres.")
              .optional(),
          })
          .strict(),
        response: {
          200: esquemaConquistaManual,
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
      const agora = app.agora();
      const validar = body.decisao === "validar";
      if (!validar && !body.motivo) {
        throw requisicaoInvalidaCampos(
          [{ campo: "motivo", mensagem: "Informe o motivo da recusa." }],
          "Informe o motivo da recusa.",
        );
      }

      // Acesso no SQL: gestor vê qualquer conquista; treinador só a de atleta dele.
      const alvo = await app.db.query<{ atleta_id: string }>(
        `select c.atleta_id::text as atleta_id
           from conquistas_atleta c join atletas a on a.id = c.atleta_id
          where c.id = $1::uuid and ($2::text = 'gestor' or a.treinador_id = $3::uuid)`,
        [req.params.id, usuario.papel, usuario.id],
      );
      const atletaId = alvo.rows[0]?.atleta_id;
      if (!atletaId) throw naoEncontrado("Conquista não encontrada.");

      await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, atletaId);
        const atual = await tx.query<{ status: string }>(
          `select status from conquistas_atleta where id = $1::uuid for update`,
          [req.params.id],
        );
        if (!atual.rows[0]) throw naoEncontrado("Conquista não encontrada.");
        if (atual.rows[0].status !== "pendente") throw conflito("Esta conquista já foi decidida.");
        await tx.query(
          `update conquistas_atleta
              set status = $2, motivo = $3, decidido_por = $4::uuid, decidido_em = $5
            where id = $1::uuid`,
          [
            req.params.id,
            validar ? "validada" : "recusada",
            validar ? null : body.motivo,
            usuario.id,
            agora,
          ],
        );
        // Auditoria sem o título nem o motivo: só ids e a decisão.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'decidir_conquista', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            atletaId,
            JSON.stringify({
              conquistaId: req.params.id,
              decisao: body.decisao,
              comMotivo: !validar,
            }),
            agora,
          ],
        );
        await avisarContasDoAtleta(tx, atletaId, {
          tipo: validar ? "conquista_validada" : "conquista_recusada",
          referencia: { conquistaId: req.params.id },
          autorId: usuario.id,
          em: agora,
        });
      });

      return lerConquista(app.db, req.params.id);
    },
  );

  rota.get(
    "/atletas/:id/conquistas",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["conquistas"],
        summary: "Conquistas do atleta: automáticas (pódios) e manuais, de qualquer situação",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403; outro atleta ou treinador: 404). `automaticas`: pódios (1º a 3º) dos resultados validados, calculados na leitura. `manuais`: as informadas pelo atleta, da mais nova para a mais antiga, com a situação, o motivo da recusa, quem decidiu e o anexo. A ficha (GET /atletas/:id) traz só as validadas.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({
            automaticas: z.array(esquemaConquistaFicha),
            manuais: z.array(esquemaConquistaManual),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async (req) => {
      const base = await buscarAtletaVisivel(app.db, req.usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const dados = (await carregarDadosAtletas(app.db, [base.id])).get(base.id);
      return {
        automaticas: conquistasAutomaticas(dados?.resultados ?? []),
        manuais: await listarConquistasManuais(app.db, base.id),
      };
    },
  );
}

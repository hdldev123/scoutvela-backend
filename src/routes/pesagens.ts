import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import { avisarContasDoAtleta, avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import { removerOuPendenciar } from "../servicos/arquivos-pendentes.js";

const EVIDENCIA_VALIDADA = "Pesagem informada pelo atleta e validada";

const umaCasa = (v: number) => Math.round(v * 10) / 10;

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

const statusPesagem = z.enum(["pendente", "validada", "recusada"]);

const esquemaPesagem = z.object({
  id: z.string(),
  pesoKg: z.number().describe("Peso informado pelo atleta (dado sensível: o IBVAR nunca recebe)"),
  status: statusPesagem,
  enviadoEm: z.string().describe("Instante ISO"),
  motivo: z.string().nullable().describe("Motivo da recusa; nulo nas demais"),
  decididoPor: z
    .object({ id: z.string(), nome: z.string() })
    .nullable()
    .describe("Quem validou ou recusou"),
  decididoEm: z.string().nullable().describe("Instante ISO"),
  anexoId: z
    .string()
    .nullable()
    .describe(
      "Foto do visor da balança, enquanto a pesagem está pendente (GET /evidencias/:id/link). Nula depois da decisão: a foto é removida",
    ),
});

interface LinhaPesagem {
  id: string;
  peso_kg: string;
  status: "pendente" | "validada" | "recusada";
  enviado_em: Date;
  motivo: string | null;
  decidido_por: string | null;
  decisor_nome: string | null;
  decidido_em: Date | null;
  anexo_id: string | null;
}

const COLUNAS = `p.id::text as id, p.peso_kg, p.status, p.enviado_em, p.motivo, p.decidido_por::text as decidido_por,
       u.nome as decisor_nome, p.decidido_em, case when ea.removido_em is null then p.anexo_id::text end as anexo_id`;
const ORIGEM = `pesagens_atleta p
  left join usuarios u on u.id = p.decidido_por
  join evidencias_anexos ea on ea.id = p.anexo_id`;

const paraPesagem = (l: LinhaPesagem) => ({
  id: l.id,
  pesoKg: Number(l.peso_kg),
  status: l.status,
  enviadoEm: iso(l.enviado_em),
  motivo: l.motivo,
  decididoPor: l.decidido_por ? { id: l.decidido_por, nome: l.decisor_nome ?? "" } : null,
  decididoEm: l.decidido_em ? iso(l.decidido_em) : null,
  anexoId: l.anexo_id,
});

async function lerPesagem(db: Db, id: string): Promise<LinhaPesagem> {
  const r = await db.query<LinhaPesagem>(
    `select ${COLUNAS} from ${ORIGEM} where p.id = $1::bigint`,
    [id],
  );
  return r.rows[0]!;
}

const ehViolacaoUnica = (e: unknown) => (e as { code?: string })?.code === "23505";

export async function rotasPesagens(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];
  const idPesagem = z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") });

  rota.post(
    "/me/pesagens",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["pesagens"],
        summary: "O atleta informa o peso com a foto do visor da balança",
        description:
          "Só o atleta, no próprio cadastro completo. `anexoId` é o anexo do próprio atleta com categoria `balanca` (POST /atletas/:id/evidencias): inexistente, removido, de outro atleta ou de outra categoria dá 400 em `anexoId`. Peso de 30 a 160 kg. Só uma pesagem pendente por atleta: nova com uma pendente dá 409. O peso só entra no Class Fit e no G1 depois que o treinador ou o gestor valida (PUT /pesagens/:id/validacao). Avisa o treinador (`atleta_enviou_pesagem`, `referencia: { pesagemId }`). Auditoria `enviar_pesagem` sem o peso.",
        security: seguranca,
        body: z
          .object({
            pesoKg: z
              .number("Informe o peso em kg.")
              .min(30, "O peso deve ficar entre 30 e 160 kg.")
              .max(160, "O peso deve ficar entre 30 e 160 kg."),
            anexoId: z.uuid("Informe a foto da balança."),
          })
          .strict(),
        response: {
          201: esquemaPesagem,
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
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, usuario.atletaId, referencia);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const pesoKg = umaCasa(body.pesoKg);

      const id = await app.db
        .transacao(async (tx) => {
          await travarAtletaEditavel(tx, base.id, { exigirAtivo: true });
          // `for share`: uma remoção do anexo em andamento termina antes; anexo removido não liga.
          const anexo = await tx.query(
            `select 1 from evidencias_anexos
              where id = $1::uuid and atleta_id = $2::uuid and categoria = 'balanca'
                and removido_em is null for share`,
            [body.anexoId, base.id],
          );
          if (anexo.rows.length === 0) {
            throw requisicaoInvalidaCampos(
              [
                {
                  campo: "anexoId",
                  mensagem:
                    "Foto inexistente, removida ou de outro atleta. Envie a foto do visor da balança (categoria balanca).",
                },
              ],
              "Foto da balança inválida.",
            );
          }
          const pendente = await tx.query(
            `select 1 from pesagens_atleta where atleta_id = $1::uuid and status = 'pendente'`,
            [base.id],
          );
          if (pendente.rows.length > 0) {
            throw conflito(
              "Já existe uma pesagem aguardando validação. Espere a decisão do treinador.",
            );
          }
          const ins = await tx.query<{ id: string }>(
            `insert into pesagens_atleta (atleta_id, peso_kg, anexo_id, enviado_em)
             values ($1::uuid, $2, $3::uuid, $4) returning id::text as id`,
            [base.id, pesoKg, body.anexoId, referencia],
          );
          const novoId = ins.rows[0]!.id;
          // Auditoria sem o peso: só ids.
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
             values ($1, 'enviar_pesagem', 'atleta', $2, $3::jsonb, $4)`,
            [
              usuario.id,
              base.id,
              JSON.stringify({ pesagemId: novoId, anexoId: body.anexoId }),
              referencia,
            ],
          );
          await avisarTreinadorDoAtleta(tx, base.id, {
            tipo: "atleta_enviou_pesagem",
            referencia: { pesagemId: novoId },
            autorId: usuario.id,
            em: referencia,
          });
          return novoId;
        })
        .catch((e: unknown) => {
          // Duas pesagens enviadas ao mesmo tempo: o índice parcial único recusa a segunda.
          if (ehViolacaoUnica(e)) {
            throw conflito(
              "Já existe uma pesagem aguardando validação. Espere a decisão do treinador.",
            );
          }
          throw e;
        });

      return reply.code(201).send(paraPesagem(await lerPesagem(app.db, id)));
    },
  );

  rota.put(
    "/pesagens/:id/validacao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["pesagens"],
        summary: "Valida ou recusa a pesagem informada pelo atleta",
        description:
          'Gestor ou treinador do atleta (outro treinador e pesagem inexistente: 404; atleta e IBVAR: 403). `validar` grava o peso em `medidas_corporais` (medido_em = envio, registrado_por = quem validou, evidência "Pesagem informada pelo atleta e validada") na mesma transação; a partir daí o peso entra no Class Fit e no G1. `recusar` exige `motivo` (até 300 caracteres; 400 em `motivo`). Pesagem já decidida: 409. Nos dois casos, depois da gravação, a foto sai do Storage e o anexo fica marcado como removido, e o atleta recebe o aviso `pesagem_validada` ou `pesagem_recusada` (`referencia: { pesagemId }`). Auditoria `decidir_pesagem` sem peso nem motivo.',
        security: seguranca,
        params: idPesagem,
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
          200: esquemaPesagem,
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
      const referencia = app.agora();
      const validar = body.decisao === "validar";
      if (!validar && !body.motivo) {
        throw requisicaoInvalidaCampos(
          [{ campo: "motivo", mensagem: "Informe o motivo da recusa." }],
          "Informe o motivo da recusa.",
        );
      }

      // Acesso no SQL: gestor vê qualquer pesagem; treinador só a de atleta dele.
      const alvo = await app.db.query<{ atleta_id: string }>(
        `select p.atleta_id::text as atleta_id
           from pesagens_atleta p join atletas a on a.id = p.atleta_id
          where p.id = $1::bigint and ($2::text = 'gestor' or a.treinador_id = $3::uuid)`,
        [req.params.id, usuario.papel, usuario.id],
      );
      const atletaId = alvo.rows[0]?.atleta_id;
      if (!atletaId) throw naoEncontrado("Pesagem não encontrada.");

      const caminho = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, atletaId);
        const atual = await tx.query<{
          status: string;
          peso_kg: string;
          enviado_em: Date;
          anexo_id: string;
          caminho: string;
        }>(
          `select p.status, p.peso_kg, p.enviado_em, p.anexo_id::text as anexo_id, ea.caminho
             from pesagens_atleta p join evidencias_anexos ea on ea.id = p.anexo_id
            where p.id = $1::bigint for update of p`,
          [req.params.id],
        );
        const p = atual.rows[0];
        if (!p) throw naoEncontrado("Pesagem não encontrada.");
        if (p.status !== "pendente") throw conflito("Esta pesagem já foi decidida.");

        let medidaId: string | null = null;
        if (validar) {
          const m = await tx.query<{ id: string }>(
            `insert into medidas_corporais (atleta_id, peso_kg, medido_em, evidencia, registrado_por)
             values ($1::uuid, $2, $3, $4, $5::uuid) returning id::text as id`,
            [atletaId, p.peso_kg, p.enviado_em, EVIDENCIA_VALIDADA, usuario.id],
          );
          medidaId = m.rows[0]!.id;
        }
        await tx.query(
          `update pesagens_atleta
              set status = $2, motivo = $3, decidido_por = $4::uuid, decidido_em = $5, medida_id = $6::bigint
            where id = $1::bigint`,
          [
            req.params.id,
            validar ? "validada" : "recusada",
            validar ? null : body.motivo,
            usuario.id,
            referencia,
            medidaId,
          ],
        );
        // Auditoria sem o peso nem o texto do motivo: só ids e a decisão.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'decidir_pesagem', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            atletaId,
            JSON.stringify({
              pesagemId: req.params.id,
              decisao: body.decisao,
              medidaId,
              comMotivo: !validar,
            }),
            referencia,
          ],
        );
        await avisarContasDoAtleta(tx, atletaId, {
          tipo: validar ? "pesagem_validada" : "pesagem_recusada",
          referencia: { pesagemId: req.params.id },
          autorId: usuario.id,
          em: referencia,
        });
        return { anexoId: p.anexo_id, caminho: p.caminho };
      });

      // Depois do commit: a foto da balança sai do Storage. Falha no Storage não desfaz a decisão: o
      // caminho vai para `arquivos_pendentes` e a anonimização limpa depois (só o motivo vai ao log).
      await removerOuPendenciar(
        { db: app.db, armazenamento: app.armazenamento, log: req.log, agora: app.agora },
        caminho.caminho,
        "pesagem_decidida",
      );
      try {
        const marcado = await app.db.query(
          `update evidencias_anexos
              set removido_em = greatest($2::timestamptz, enviado_em), nome_arquivo = 'removido'
            where id = $1::uuid and removido_em is null returning id`,
          [caminho.anexoId, referencia],
        );
        if (marcado.rows.length > 0) {
          await app.db.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
             values ($1, 'remover_anexo', 'atleta', $2, $3::jsonb, $4)`,
            [
              usuario.id,
              atletaId,
              JSON.stringify({ anexoId: caminho.anexoId, origem: "pesagem" }),
              referencia,
            ],
          );
        }
      } catch (e) {
        req.log.warn({ evento: "anexo_pesagem_nao_marcado", erro: (e as Error).name }, "anexo");
      }

      return paraPesagem(await lerPesagem(app.db, req.params.id));
    },
  );

  rota.get(
    "/atletas/:id/pesagens",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["pesagens"],
        summary: "Pesagens informadas pelo atleta, da mais nova para a mais antiga",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403, o peso é dado sensível; outro atleta ou treinador: 404). Cada item traz status, peso, datas, motivo da recusa e quem decidiu. Só a pesagem validada vira medida e entra no Class Fit.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        response: {
          200: z.object({ itens: z.array(esquemaPesagem) }),
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
      const r = await app.db.query<LinhaPesagem>(
        `select ${COLUNAS} from ${ORIGEM} where p.atleta_id = $1::uuid order by p.enviado_em desc, p.id desc`,
        [base.id],
      );
      return { itens: r.rows.map(paraPesagem) };
    },
  );
}

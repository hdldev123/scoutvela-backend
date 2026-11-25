import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalida, semAcesso } from "../erros.js";
import { erroAtletaAnonimizado } from "../repositories/anonimizado.js";
import {
  buscarTermoProximo,
  buscarTermoVigente,
  listarTermos,
  termoAceitavel,
  termoSql,
} from "../repositories/termo.js";

const esquemaItemTermo = z.object({
  versao: z.string(),
  titulo: z.string(),
  vigenteDesde: z.string().describe("Instante ISO"),
  criadoEm: z.string().describe("Instante ISO"),
  incluiFotoBio: z
    .boolean()
    .describe(
      "A versão cita foto e bio entre o que vai ao IBVAR: só quem aceitou uma versão assim e consentiu com o IBVAR tem foto e bio vistas por ele",
    ),
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
          "Texto da versão vigente (a de maior vigente_desde que já começou). Qualquer usuário autenticado lê. A próxima versão publicada, ainda sem vigência, vem em GET /termo/proxima.",
        security: seguranca,
        response: {
          200: z.object({
            versao: z.string(),
            titulo: z.string(),
            texto: z.string(),
            vigenteDesde: z.string().describe("Instante ISO"),
            incluiFotoBio: z
              .boolean()
              .describe("A versão cita foto e bio entre o que vai ao IBVAR"),
          }),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async () => buscarTermoVigente(app.db, app.agora()),
  );

  r.get(
    "/termo/proxima",
    {
      preHandler: [app.autenticar, exigirPapel("atleta", "gestor")],
      schema: {
        tags: ["termo"],
        summary: "Próxima versão do termo, já publicada e ainda sem vigência",
        description:
          "A de menor vigente_desde no futuro, com o texto, para o atleta ler e aceitar antes de ela valer (POST /termo/aceite). Só atleta e gestor. 404 quando não há versão futura publicada.",
        security: seguranca,
        response: {
          200: z.object({
            versao: z.string(),
            titulo: z.string(),
            texto: z.string(),
            vigenteDesde: z.string().describe("Instante ISO em que passa a valer"),
            incluiFotoBio: z
              .boolean()
              .describe("A versão cita foto e bio entre o que vai ao IBVAR"),
          }),
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
        },
      },
    },
    async () => {
      const proxima = await buscarTermoProximo(app.db, app.agora());
      if (!proxima) throw naoEncontrado("Não há nova versão do termo publicada.");
      return proxima;
    },
  );

  r.post(
    "/termo/aceite",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["termo"],
        summary: "O atleta aceita o termo vigente ou a próxima versão publicada",
        description:
          "A versão enviada precisa ser a vigente ou a próxima publicada (aceite antecipado: com TERMO_EXIGE_REACEITE ligada, quem aceitou a próxima versão não sai do ranking quando ela entra em vigor). Aceitar uma versão mais nova vale também para as anteriores. Não concede o compartilhamento com o IBVAR (consentimento separado, em PUT /consentimento).",
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
        const alvo = await termoAceitavel(tx, agora, req.body.versao);
        if (!alvo) {
          throw requisicaoInvalida(
            "A versão do termo não é a vigente nem a próxima publicada. Recarregue a página e leia o termo atual.",
          );
        }
        const atleta = await tx.query<{ anonimizado_em: Date | null }>(
          "select anonimizado_em from atletas where id = $1 for update",
          [atletaId],
        );
        if (atleta.rows[0]?.anonimizado_em) throw erroAtletaAnonimizado();
        const aceito = await tx.query<{ ok: boolean }>(
          `select ${termoSql.aceitoVersao("$1::uuid", "$2")} as ok`,
          [atletaId, alvo.versao],
        );
        if (aceito.rows[0]?.ok) throw conflito("Você já aceitou esta versão do termo.");
        await tx.query(
          `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
           values ($1, 'termo_piloto', true, $2, $3, $4)`,
          [atletaId, alvo.versao, agora, usuarioId],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'aceitar_termo', 'atletas', $2, $3::jsonb, $4)`,
          [usuarioId, atletaId, JSON.stringify({ versaoTermo: alvo.versao }), agora],
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
          "A versão passa a valer em vigenteDesde, que não pode estar no passado nem ser anterior ou igual à vigência de outra versão (inclusive futura). Quem aceitou só a anterior fica com aceite pendente; se o ranking os exclui depende da regra TERMO_EXIGE_REACEITE. `incluiFotoBio` (padrão falso): marque na versão cujo texto cita foto e bio entre o que vai ao IBVAR (decisão D). O IBVAR só recebe foto e bio de quem consentiu com ele e tem como aceite mais recente uma versão com essa marca; quem não aceitar a versão nova segue sem foto e sem bio para ele. A auditoria não guarda o texto.",
        security: seguranca,
        body: z
          .object({
            versao: z.string().trim().min(1, "Informe a versão.").max(100, "Versão longa demais."),
            titulo: z
              .string()
              .trim()
              .min(3, "O título precisa ter ao menos 3 caracteres.")
              .max(200, "O título pode ter no máximo 200 caracteres."),
            texto: z
              .string()
              .min(50, "O texto do termo precisa ter ao menos 50 caracteres.")
              .max(50000, "O texto do termo pode ter no máximo 50.000 caracteres."),
            incluiFotoBio: z.boolean("Informe true ou false.").optional().default(false),
            vigenteDesde: z.iso.datetime({
              offset: true,
              error: "Informe a vigência em formato ISO (ex.: 2026-12-01T00:00:00-03:00).",
            }),
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
      const { versao, titulo, texto, incluiFotoBio } = req.body;
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
          `insert into termos_consentimento (versao, titulo, texto, vigente_desde, inclui_foto_bio, criado_em)
           values ($1, $2, $3, $4, $5, $6)`,
          [versao, titulo, texto, vigenteDesde, incluiFotoBio, agora],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'publicar_termo', 'termos_consentimento', null, $2::jsonb, $3)`,
          [
            req.usuario.id,
            JSON.stringify({ versao, vigenteDesde: vigenteDesde.toISOString(), incluiFotoBio }),
            agora,
          ],
        );
      });
      const item = (await listarTermos(app.db, agora)).find((t) => t.versao === versao);
      if (!item) throw new Error("Termo publicado não encontrado.");
      return reply.code(201).send(item);
    },
  );
}

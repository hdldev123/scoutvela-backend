import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import {
  conflito,
  esquemaErro,
  naoEncontrado,
  requisicaoInvalidaCampos,
  semAcesso,
} from "../erros.js";
import { registrarAviso } from "../repositories/avisos.js";
import { MSG_ORDEM_PESO_CLASSE, umaCasa } from "../repositories/parametros.js";
import { pesoKg } from "./parametros.js";

/** Sugestões abertas por autor. O volume esperado é baixo. */
export const LIMITE_SUGESTOES_ABERTAS = 10;

const TIPOS = ["class_fit", "parametro", "sistema"] as const;
const STATUS = ["aberta", "aprovada", "recusada"] as const;

const faixaPeso = z.object({
  pesoMinKg: z.number(),
  pesoMedioKg: z.number(),
  pesoMaxKg: z.number(),
});

const esquemaSugestao = z.object({
  id: z.string(),
  tipo: z.enum(TIPOS),
  status: z.enum(STATUS),
  texto: z.string(),
  autor: z.object({ nome: z.string() }),
  classe: z.object({ id: z.string(), nome: z.string() }).nullable(),
  proposta: faixaPeso.nullable().describe("Só em `class_fit`: a faixa de peso proposta (kg)"),
  faixaAtual: faixaPeso
    .nullable()
    .describe("Só em `class_fit`: a faixa de peso vigente da classe, para o gestor comparar"),
  resposta: z.string().nullable(),
  respondidoPor: z.object({ nome: z.string() }).nullable(),
  respondidoEm: z.string().nullable().describe("Instante ISO"),
  criadoEm: z.string().describe("Instante ISO"),
});

interface LinhaSugestao {
  id: string;
  tipo: (typeof TIPOS)[number];
  status: (typeof STATUS)[number];
  texto: string;
  autor_nome: string;
  classe_id: string | null;
  classe_nome: string | null;
  proposta: { pesoMinKg: number; pesoMedioKg: number; pesoMaxKg: number } | null;
  peso_min_kg: string | null;
  peso_medio_kg: string | null;
  peso_max_kg: string | null;
  resposta: string | null;
  respondido_por_nome: string | null;
  respondido_em: Date | null;
  criado_em: Date;
}

const SELECT = `select s.id::text as id, s.tipo, s.status, s.texto, au.nome as autor_nome,
       s.classe_id, c.nome as classe_nome, s.proposta,
       c.peso_min_kg, c.peso_medio_kg, c.peso_max_kg,
       s.resposta, rp.nome as respondido_por_nome, s.respondido_em, s.criado_em
  from sugestoes s
  join usuarios au on au.id = s.autor_id
  left join usuarios rp on rp.id = s.respondido_por
  left join classes c on c.id = s.classe_id`;

function paraSugestao(l: LinhaSugestao): z.infer<typeof esquemaSugestao> {
  return {
    id: l.id,
    tipo: l.tipo,
    status: l.status,
    texto: l.texto,
    autor: { nome: l.autor_nome },
    classe: l.classe_id ? { id: l.classe_id, nome: l.classe_nome ?? l.classe_id } : null,
    proposta: l.proposta,
    faixaAtual:
      l.tipo === "class_fit" && l.peso_min_kg !== null
        ? {
            pesoMinKg: Number(l.peso_min_kg),
            pesoMedioKg: Number(l.peso_medio_kg),
            pesoMaxKg: Number(l.peso_max_kg),
          }
        : null,
    resposta: l.resposta,
    respondidoPor: l.respondido_por_nome ? { nome: l.respondido_por_nome } : null,
    respondidoEm: l.respondido_em ? new Date(l.respondido_em).toISOString() : null,
    criadoEm: new Date(l.criado_em).toISOString(),
  };
}

async function buscarSugestao(db: Db, id: string): Promise<LinhaSugestao | undefined> {
  const r = await db.query<LinhaSugestao>(`${SELECT} where s.id = $1::bigint`, [id]);
  return r.rows[0];
}

export async function rotasSugestoes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];

  r.post(
    "/sugestoes",
    {
      preHandler: [app.autenticar, exigirPapel("treinador")],
      schema: {
        tags: ["sugestoes"],
        summary: "O treinador sugere uma mudança ao gestor",
        description:
          "Só o treinador (gestor, atleta e IBVAR: 403). `tipo`: `class_fit` (exige `classeId` existente e `proposta` com `pesoMinKg` <= `pesoMedioKg` <= `pesoMaxKg`, de 0 a 400 kg, arredondados a 1 casa, as mesmas regras de PUT /parametros), `parametro` ou `sistema` (sem `classeId` nem `proposta`). `texto` de 1 a 1.000 caracteres, texto puro. Até 10 sugestões abertas por autor: acima disso, 409. Nada muda nos parâmetros: o gestor responde em PUT /sugestoes/{id}.",
        security: seguranca,
        body: z
          .object({
            tipo: z.enum(TIPOS, { error: "Escolha o tipo da sugestão." }),
            classeId: z.string().min(1).max(40).optional(),
            proposta: z
              .object({ pesoMinKg: pesoKg, pesoMedioKg: pesoKg, pesoMaxKg: pesoKg })
              .strict()
              .optional(),
            texto: z
              .string("Informe o texto da sugestão.")
              .trim()
              .min(1, "Informe o texto da sugestão.")
              .max(1000, "O texto pode ter no máximo 1.000 caracteres."),
          })
          .strict(),
        response: {
          201: esquemaSugestao,
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const campos: { campo: string; mensagem: string }[] = [];
      let proposta: { pesoMinKg: number; pesoMedioKg: number; pesoMaxKg: number } | null = null;
      if (body.tipo === "class_fit") {
        if (!body.classeId) {
          campos.push({ campo: "classeId", mensagem: "Informe a classe da sugestão." });
        } else {
          const c = await app.db.query(`select 1 from classes where id = $1`, [body.classeId]);
          if (c.rows.length === 0)
            campos.push({ campo: "classeId", mensagem: "Classe inexistente." });
        }
        if (!body.proposta) {
          campos.push({
            campo: "proposta",
            mensagem: "Informe a faixa de peso proposta (mínimo, médio e máximo).",
          });
        } else {
          proposta = {
            pesoMinKg: umaCasa(body.proposta.pesoMinKg),
            pesoMedioKg: umaCasa(body.proposta.pesoMedioKg),
            pesoMaxKg: umaCasa(body.proposta.pesoMaxKg),
          };
          if (!(
            proposta.pesoMinKg <= proposta.pesoMedioKg && proposta.pesoMedioKg <= proposta.pesoMaxKg
          )) {
            campos.push({ campo: "proposta", mensagem: MSG_ORDEM_PESO_CLASSE });
          }
        }
      } else {
        if (body.classeId)
          campos.push({
            campo: "classeId",
            mensagem: "A classe só vale para sugestões do tipo class_fit.",
          });
        if (body.proposta)
          campos.push({
            campo: "proposta",
            mensagem: "A proposta só vale para sugestões do tipo class_fit.",
          });
      }
      if (campos.length > 0) throw requisicaoInvalidaCampos(campos);

      const em = app.agora();
      const id = await app.db.transacao(async (tx) => {
        // Serializa as sugestões do mesmo autor: duas chamadas juntas não passam do limite.
        await tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
          `sugestoes:${usuario.id}`,
        ]);
        const abertas = await tx.query<{ n: string }>(
          `select count(*)::text as n from sugestoes where autor_id = $1::uuid and status = 'aberta'`,
          [usuario.id],
        );
        if (Number(abertas.rows[0]!.n) >= LIMITE_SUGESTOES_ABERTAS) {
          throw conflito(
            `Você já tem ${LIMITE_SUGESTOES_ABERTAS} sugestões abertas. Aguarde a resposta do gestor para enviar outra.`,
          );
        }
        const ins = await tx.query<{ id: string }>(
          `insert into sugestoes (autor_id, tipo, classe_id, proposta, texto, criado_em)
           values ($1::uuid, $2, $3, $4::jsonb, $5, $6) returning id::text as id`,
          [
            usuario.id,
            body.tipo,
            body.tipo === "class_fit" ? body.classeId : null,
            proposta ? JSON.stringify(proposta) : null,
            body.texto,
            em,
          ],
        );
        const novo = ins.rows[0]!.id;
        // Só ids: o texto da sugestão fica apenas na tabela.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1::uuid, 'sugerir', 'sugestoes', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            novo,
            JSON.stringify({
              sugestaoId: novo,
              tipo: body.tipo,
              classeId: body.tipo === "class_fit" ? body.classeId : null,
            }),
            em,
          ],
        );
        return novo;
      });
      return reply.code(201).send(paraSugestao((await buscarSugestao(app.db, id))!));
    },
  );

  r.get(
    "/sugestoes",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["sugestoes"],
        summary: "Sugestões ao gestor: todas (gestor) ou só as minhas (treinador)",
        description:
          "Gestor vê todas; treinador, só as próprias. Atleta e IBVAR: 403. Do mais recente para o mais antigo, no máximo 200. `faixaAtual` traz a faixa de peso vigente da classe, para o gestor comparar com a `proposta`.",
        security: seguranca,
        querystring: z.object({ status: z.enum(STATUS).optional() }),
        response: {
          200: z.object({ itens: z.array(esquemaSugestao) }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      if (usuario.papel !== "gestor" && usuario.papel !== "treinador") throw semAcesso();
      const params: unknown[] = [];
      const where: string[] = [];
      if (usuario.papel === "treinador") {
        params.push(usuario.id);
        where.push(`s.autor_id = $${params.length}::uuid`);
      }
      if (req.query.status) {
        params.push(req.query.status);
        where.push(`s.status = $${params.length}`);
      }
      const l = await app.db.query<LinhaSugestao>(
        `${SELECT} ${where.length ? `where ${where.join(" and ")}` : ""}
         order by s.criado_em desc, s.id desc limit 200`,
        params,
      );
      return { itens: l.rows.map(paraSugestao) };
    },
  );

  r.put(
    "/sugestoes/:id",
    {
      preHandler: [app.autenticar, exigirPapel("gestor")],
      schema: {
        tags: ["sugestoes"],
        summary: "O gestor aprova ou recusa uma sugestão",
        description:
          "Só o gestor. `resposta` é obrigatória ao recusar (até 1.000 caracteres) e opcional ao aprovar. Só sugestão aberta: já respondida dá 409. Aprovar NÃO muda o parâmetro: o front leva o gestor a Parâmetros com a proposta preenchida e a mudança segue por PUT /parametros, com a auditoria de sempre. Gera o aviso `sugestao_respondida` ao autor (`referencia`: `{ sugestaoId, status }`). Auditoria `responder_sugestao` só com ids e status.",
        security: seguranca,
        params: z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") }),
        body: z
          .object({
            status: z.enum(["aprovada", "recusada"], {
              error: "Informe se a sugestão foi aprovada ou recusada.",
            }),
            resposta: z
              .string()
              .trim()
              .max(1000, "A resposta pode ter no máximo 1.000 caracteres.")
              .optional(),
          })
          .strict(),
        response: {
          200: esquemaSugestao,
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
      const resposta = body.resposta ? body.resposta : null;
      if (body.status === "recusada" && !resposta) {
        throw requisicaoInvalidaCampos([
          { campo: "resposta", mensagem: "Explique o motivo ao recusar a sugestão." },
        ]);
      }
      const em = app.agora();
      await app.db.transacao(async (tx) => {
        const atual = await tx.query<{ autor_id: string; status: string }>(
          `select autor_id::text as autor_id, status from sugestoes where id = $1::bigint for update`,
          [req.params.id],
        );
        const s = atual.rows[0];
        if (!s) throw naoEncontrado("Sugestão não encontrada.");
        if (s.status !== "aberta") throw conflito("Esta sugestão já foi respondida.");
        await tx.query(
          `update sugestoes set status = $2, resposta = $3, respondido_por = $4::uuid, respondido_em = $5
            where id = $1::bigint`,
          [req.params.id, body.status, resposta, usuario.id, em],
        );
        await registrarAviso(tx, s.autor_id, {
          tipo: "sugestao_respondida",
          atletaId: null,
          referencia: { sugestaoId: req.params.id, status: body.status },
          autorId: usuario.id,
          em,
        });
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1::uuid, 'responder_sugestao', 'sugestoes', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            req.params.id,
            JSON.stringify({ sugestaoId: req.params.id, status: body.status }),
            em,
          ],
        );
      });
      return paraSugestao((await buscarSugestao(app.db, req.params.id))!);
    },
  );
}

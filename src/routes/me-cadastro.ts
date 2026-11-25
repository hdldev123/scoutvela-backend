import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { dataIso, idadeEm } from "../domain/index.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalida } from "../erros.js";
import { erroAtletaAnonimizado } from "../repositories/anonimizado.js";

const IDADE_MINIMA_PILOTO = 18;
const IDADE_MAXIMA_PLAUSIVEL = 100;

export const MENSAGEM_MENOR_NO_CADASTRO =
  "O piloto do Scout Vela aceita só atletas com 18 anos ou mais, e a data informada não atende a essa regra. Seu cadastro foi encerrado e a CBVela foi avisada. A versão para menores, com responsável, está em desenho.";

const DESCRICAO_PEDIDO_MENOR =
  "Cadastro encerrado: o atleta informou ter menos de 18 anos no primeiro acesso (pedido aberto pelo sistema para a anonimização).";

export async function rotasMeCadastro(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().put(
    "/me/cadastro",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["sessao"],
        summary: "O atleta completa o cadastro: nome, gênero e data de nascimento (uma vez)",
        description:
          "Só o atleta, e só uma vez: depois de completo, a segunda chamada devolve 409 (a correção é pelo pedido do titular). Os dados sugeridos do VelaID vêm em GET /me (cadastroPendente.sugestao). Menor de 18 anos: a API recusa com 400 sem gravar a data, o nome nem o gênero, inativa o atleta e a conta, abre um pedido de exclusão para o gestor anonimizar e soma no balão `cadastro` do gestor; a auditoria não guarda a data. Data futura ou de mais de 100 anos: 400. Ao completar, o atleta passa a entrar no ranking depois do aceite do termo.",
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            nome: z
              .string()
              .trim()
              .min(2, "O nome precisa ter ao menos 2 caracteres.")
              .max(120, "O nome pode ter no máximo 120 caracteres."),
            genero: z.enum(["F", "M"]),
            dataNascimento: z.iso.date().describe("AAAA-MM-DD"),
          })
          .strict(),
        response: {
          200: z.object({
            nome: z.string(),
            genero: z.enum(["F", "M"]),
            dataNascimento: z.string(),
            cadastroCompleto: z.literal(true),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req) => {
      const u = req.usuario;
      if (!u.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const atletaId = u.atletaId;
      const { nome, genero, dataNascimento } = req.body;
      const agora = app.agora();

      if (dataNascimento > dataIso(agora)) {
        throw requisicaoInvalida("A data de nascimento não pode estar no futuro.");
      }
      const idade = idadeEm(dataNascimento, agora);
      if (idade > IDADE_MAXIMA_PLAUSIVEL) throw requisicaoInvalida("Data de nascimento inválida.");

      const recusado = await app.db.transacao(async (tx) => {
        const a = await tx.query<{
          ativo: boolean;
          anonimizado_em: Date | null;
          cadastro_completo_em: Date | null;
          cadastro_recusado_em: Date | null;
        }>(
          `select ativo, anonimizado_em, cadastro_completo_em, cadastro_recusado_em
             from atletas where id = $1::uuid for update`,
          [atletaId],
        );
        const atual = a.rows[0];
        if (!atual) throw naoEncontrado("Atleta não encontrado.");
        if (atual.anonimizado_em) throw erroAtletaAnonimizado();
        if (atual.cadastro_completo_em) {
          throw conflito(
            "O cadastro já foi completado. Para corrigir nome, gênero ou data de nascimento, abra um pedido do titular (tipo correção).",
          );
        }
        if (atual.cadastro_recusado_em || !atual.ativo) {
          throw conflito("O cadastro deste atleta está encerrado. Fale com a CBVela.");
        }

        if (idade < IDADE_MINIMA_PILOTO) {
          // Não grava nome, gênero nem data. O commit precisa acontecer: a recusa não pode ser desfeita.
          await tx.query(
            `update atletas set ativo = false, cadastro_recusado_em = $2 where id = $1::uuid`,
            [atletaId, agora],
          );
          await tx.query(`update usuarios set ativo = false where atleta_id = $1::uuid`, [
            atletaId,
          ]);
          await tx.query(
            `insert into pedidos_titular (atleta_id, tipo, descricao, criado_por, criado_em)
             values ($1::uuid, 'exclusao', $2, $3::uuid, $4)`,
            [atletaId, DESCRICAO_PEDIDO_MENOR, u.id, agora],
          );
          // Sem a data, a idade nem o nome: só o fato de a recusa ter ocorrido.
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
             values ($1::uuid, 'recusar_cadastro_menor', 'atletas', $2, '{}'::jsonb, $3)`,
            [u.id, atletaId, agora],
          );
          return true;
        }

        await tx.query(
          `update atletas set nome = $2, genero = $3, data_nascimento = $4::date, cadastro_completo_em = $5
            where id = $1::uuid`,
          [atletaId, nome, genero, dataNascimento, agora],
        );
        await tx.query(`update usuarios set nome = $2 where id = $1::uuid`, [u.id, nome]);
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1::uuid, 'completar_cadastro', 'atletas', $2, $3::jsonb, $4)`,
          [u.id, atletaId, JSON.stringify({ campos: ["nome", "genero", "dataNascimento"] }), agora],
        );
        return false;
      });

      if (recusado) {
        req.log.info(
          { evento: "cadastro_recusado_menor", atletaId },
          "cadastro recusado por idade",
        );
        throw requisicaoInvalida(MENSAGEM_MENOR_NO_CADASTRO);
      }
      return { nome, genero, dataNascimento, cadastroCompleto: true as const };
    },
  );
}

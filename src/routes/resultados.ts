import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { NIVEIS_DE_NOTA, NIVEL_GRAVADO, dataIso } from "../domain/index.js";
import { conflito, esquemaErro, naoEncontrado, requisicaoInvalidaCampos } from "../erros.js";
import { travarAtletaEditavel } from "../repositories/anonimizado.js";
import {
  COLUNAS_RESULTADO,
  ORIGEM_RESULTADO,
  SQL_EDICAO_RESULTADO,
  SQL_STATUS_RESULTADO,
  buscarAtletaVisivel,
  lerResultado,
  paraResultado,
} from "../repositories/atletas.js";
import type { LinhaResultado } from "../repositories/atletas.js";
import { avisarContasDoAtleta, avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import { carregarParametros } from "../repositories/parametros.js";
import { esquemaResultadoDetalhe } from "./esquemas-resultado.js";

/** Nome do evento sem diferença de caixa nem de espaços, para contar edições do mesmo evento. */
const SQL_EVENTO_NORMALIZADO = (valor: string) =>
  `lower(btrim(regexp_replace(${valor}, '\\s+', ' ', 'g')))`;

const esquemaListaResultados = z.object({ itens: z.array(esquemaResultadoDetalhe) });

export async function rotasResultados(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const seguranca = [{ bearerAuth: [] }];
  const idResultado = z.object({ id: z.string().regex(/^\d{1,18}$/, "Identificador inválido.") });

  rota.post(
    "/me/resultados",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["resultados"],
        summary:
          "O atleta informa um resultado (uma edição de um evento), com a súmula ou o link oficial",
        description:
          "Só o atleta, no próprio cadastro completo. `nivel`: mundial, continental (inclui Sul-Americano e Pan-Americano) ou nacional (Brasileiro); grava como `mundial`, `continental` ou `brasileiro`. `ano` é a edição (de 2000 ao ano atual). Exige a súmula (`anexoId`: anexo do próprio atleta com categoria `sumula`, enviado em POST /atletas/:id/evidencias) ou o `linkOficial` https (400 nos campos `anexoId` e `linkOficial` se faltar os dois). `tamanhoFrota` é opcional (a nota não depende dele; com ele, a posição não pode passar da frota). `data` é opcional (não futura, dentro do `ano`); sem ela, vale o último dia do ano da edição, ou hoje se o ano é o atual. Limite de edições: no máximo `edicoes_max` (regra PERF_RESULTADOS) do mesmo evento (mesmo nome, sem diferença de maiúsculas e espaços, e mesmo nível): acima disso, 409; edição repetida do mesmo evento, 409. Resultado já recusado não conta nos dois limites (dá para informar de novo). Nasce `pendente`: só entra na nota e nos gates depois da validação do treinador ou do gestor (PUT /resultados/:id/validacao). Avisa o treinador (`atleta_lancou_resultado`, `referencia: { resultadoId }`). Auditoria `informar_resultado` só com ids e nomes de campo.",
        security: seguranca,
        body: z
          .object({
            evento: z
              .string("Informe o nome do evento.")
              .trim()
              .min(2, "O nome do evento precisa ter ao menos 2 caracteres.")
              .max(120, "O nome do evento pode ter no máximo 120 caracteres."),
            nivel: z.enum(NIVEIS_DE_NOTA, {
              error: "O nível deve ser mundial, continental ou nacional.",
            }),
            ano: z
              .number("Informe o ano da edição.")
              .int("O ano deve ser um número inteiro.")
              .min(2000, "O ano deve ser a partir de 2000."),
            posicao: z
              .number("Informe a colocação.")
              .int("A colocação deve ser um número inteiro.")
              .min(1, "A colocação deve ser 1 ou mais.")
              .max(1000, "A colocação deve ser no máximo 1000."),
            tamanhoFrota: z
              .number("O tamanho da frota deve ser um número.")
              .int("O tamanho da frota deve ser um número inteiro.")
              .min(1, "O tamanho da frota deve ser 1 ou mais.")
              .max(1000, "O tamanho da frota deve ser no máximo 1000.")
              .nullish(),
            data: z.iso.date("Informe a data no formato AAAA-MM-DD.").nullish(),
            anexoId: z.uuid("Informe um anexo válido.").nullish(),
            linkOficial: z
              .url("Informe um link válido.")
              .max(500, "O link pode ter no máximo 500 caracteres.")
              .refine((u) => u.toLowerCase().startsWith("https://"), {
                message: "O link deve começar com https://.",
              })
              .nullish(),
          })
          .strict(),
        response: {
          201: esquemaResultadoDetalhe,
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

      const hoje = dataIso(agora);
      const anoAtual = Number(hoje.slice(0, 4));
      const invalidos: { campo: string; mensagem: string }[] = [];
      if (body.ano > anoAtual) {
        invalidos.push({ campo: "ano", mensagem: `O ano não pode passar de ${anoAtual}.` });
      }
      if (body.tamanhoFrota != null && body.posicao > body.tamanhoFrota) {
        invalidos.push({
          campo: "posicao",
          mensagem: "A colocação não pode passar do tamanho da frota.",
        });
      }
      if (body.data != null) {
        if (body.data > hoje) {
          invalidos.push({ campo: "data", mensagem: "A data do resultado não pode ser futura." });
        } else if (Number(body.data.slice(0, 4)) !== body.ano) {
          invalidos.push({
            campo: "data",
            mensagem: "A data precisa estar dentro do ano da edição.",
          });
        }
      }
      if (!body.anexoId && !body.linkOficial) {
        const msg = "Informe a súmula (anexoId) ou o link oficial (linkOficial) do resultado.";
        invalidos.push(
          { campo: "anexoId", mensagem: msg },
          { campo: "linkOficial", mensagem: msg },
        );
      }
      if (invalidos.length > 0) {
        throw requisicaoInvalidaCampos(invalidos, "Há campos inválidos no resultado.");
      }

      // Sem data informada: o último dia do ano da edição; no ano atual, hoje (nada de data futura,
      // que ficaria fora das janelas do G3 até o ano acabar).
      const data = body.data ?? (body.ano === anoAtual ? hoje : `${body.ano}-12-31`);
      const nivelGravado = NIVEL_GRAVADO[body.nivel];
      const parametros = await carregarParametros(app.db);
      const edicoesMax = parametros.regras.perfResultados.edicoesMax;

      const id = await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, base.id, { exigirAtivo: true });
        if (body.anexoId) {
          // `for share`: uma remoção do anexo em andamento termina antes; anexo removido não liga.
          const anexo = await tx.query(
            `select 1 from evidencias_anexos
              where id = $1::uuid and atleta_id = $2::uuid and categoria = 'sumula'
                and removido_em is null for share`,
            [body.anexoId, base.id],
          );
          if (anexo.rows.length === 0) {
            throw requisicaoInvalidaCampos(
              [
                {
                  campo: "anexoId",
                  mensagem:
                    "Súmula inexistente, removida ou de outro atleta. Envie o arquivo com a categoria sumula.",
                },
              ],
              "Súmula inválida.",
            );
          }
        }
        // As edições já informadas do mesmo evento e nível (recusadas não contam). A trava do atleta
        // serializa dois envios simultâneos.
        const edicoes = await tx.query<{ edicao: number }>(
          `select ${SQL_EDICAO_RESULTADO} as edicao
             from resultados_regata r
             left join validacao_resultado_atual v on v.resultado_id = r.id
            where r.atleta_id = $1::uuid and r.nivel = $2
              and ${SQL_EVENTO_NORMALIZADO("r.evento")} = ${SQL_EVENTO_NORMALIZADO("$3")}
              and ${SQL_STATUS_RESULTADO} <> 'recusado'`,
          [base.id, nivelGravado, body.evento],
        );
        if (edicoes.rows.some((e) => e.edicao === body.ano)) {
          throw conflito(`A edição de ${body.ano} deste evento já foi informada.`);
        }
        if (edicoes.rows.length >= edicoesMax) {
          throw conflito(
            `Este evento já tem ${edicoesMax} edições informadas, o máximo permitido (regra PERF_RESULTADOS).`,
          );
        }
        const ins = await tx.query<{ id: string }>(
          `insert into resultados_regata
             (atleta_id, nivel, evento, data, edicao, posicao, tamanho_frota, internacional, pontos_cbvela,
              fonte, link_oficial, anexo_id, registrado_por, registrado_em)
           values ($1::uuid, $2, $3, $4::date, $5, $6, $7, $8, null, 'atleta', $9, $10::uuid, $11::uuid, $12)
           returning id::text as id`,
          [
            base.id,
            nivelGravado,
            body.evento,
            data,
            body.ano,
            body.posicao,
            body.tamanhoFrota ?? null,
            body.nivel !== "nacional",
            body.linkOficial ?? null,
            body.anexoId ?? null,
            usuario.id,
            agora,
          ],
        );
        const novoId = ins.rows[0]!.id;
        // Sem o texto do evento nem o link: só ids e nomes de campo.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'informar_resultado', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            base.id,
            JSON.stringify({
              resultadoId: novoId,
              campos: [
                "evento",
                "nivel",
                "ano",
                "posicao",
                "tamanhoFrota",
                "data",
                "anexoId",
                "linkOficial",
              ].filter((c) => (body as Record<string, unknown>)[c] != null),
            }),
            agora,
          ],
        );
        await avisarTreinadorDoAtleta(tx, base.id, {
          tipo: "atleta_lancou_resultado",
          referencia: { resultadoId: novoId },
          autorId: usuario.id,
          em: agora,
        });
        return novoId;
      });

      return reply.code(201).send(await lerResultado(app.db, id));
    },
  );

  rota.put(
    "/resultados/:id/validacao",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      schema: {
        tags: ["resultados"],
        summary:
          "Valida ou recusa um resultado do atleta, ou invalida e revalida um resultado da World Sailing",
        description:
          "Gestor ou treinador do atleta (outro treinador e resultado inexistente: 404; atleta e IBVAR: 403). Vale para resultado da fonte `atleta` (valida ou recusa) e da fonte `world_sailing` (D19: `recusar` invalida o resultado importado, `validar` o revalida); os lançados por gestor ou treinador e os do Ranking CBVela já valem (400). `recusar` exige `motivo` (até 300 caracteres; 400 em `motivo`). A decisão vira uma linha nova na série (nada é sobrescrito): a situação vigente é a da validação mais recente, então dá para mudar de `validado` para `recusado` e vice-versa; repetir a situação atual dá 409 (o resultado da World Sailing já nasce vigente, então só `recusar` vale antes da primeira invalidação). Só o `validado` entra na nota (PERF_RESULTADOS) e nos gates G2 e G3: o resultado da World Sailing invalidado sai da nota e dos gates até ser revalidado. A súmula fica guardada. Avisa o atleta (`resultado_validado` ou `resultado_recusado`, `referencia: { resultadoId }`). Auditoria `decidir_resultado` sem o motivo.",
        security: seguranca,
        params: idResultado,
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
          200: esquemaResultadoDetalhe,
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

      // Acesso no SQL: gestor vê qualquer resultado; treinador só o de atleta dele.
      const alvo = await app.db.query<{ atleta_id: string; fonte: string }>(
        `select r.atleta_id::text as atleta_id, r.fonte
           from resultados_regata r join atletas a on a.id = r.atleta_id
          where r.id = $1::bigint and ($2::text = 'gestor' or a.treinador_id = $3::uuid)`,
        [req.params.id, usuario.papel, usuario.id],
      );
      const dono = alvo.rows[0];
      if (!dono) throw naoEncontrado("Resultado não encontrado.");
      if (dono.fonte !== "atleta" && dono.fonte !== "world_sailing") {
        throw requisicaoInvalidaCampos(
          [
            {
              campo: "id",
              mensagem:
                "Só o resultado informado pelo atleta ou importado da World Sailing passa por validação.",
            },
          ],
          "Este resultado não precisa de validação.",
        );
      }

      await app.db.transacao(async (tx) => {
        await travarAtletaEditavel(tx, dono.atleta_id);
        // Trava o resultado: duas decisões simultâneas esperam uma pela outra.
        await tx.query(`select 1 from resultados_regata where id = $1::bigint for update`, [
          req.params.id,
        ]);
        const atual = await tx.query<{ status: string }>(
          `select coalesce(v.status, case r.fonte when 'world_sailing' then 'validado' else 'pendente' end) as status
             from resultados_regata r left join validacao_resultado_atual v on v.resultado_id = r.id
            where r.id = $1::bigint`,
          [req.params.id],
        );
        const novo = validar ? "validado" : "recusado";
        if (atual.rows[0]?.status === novo) {
          throw conflito(`Este resultado já está ${novo}.`);
        }
        await tx.query(
          `insert into validacoes_resultado (resultado_id, status, motivo, validado_por, validado_em)
           values ($1::bigint, $2, $3, $4::uuid, $5)`,
          [req.params.id, novo, validar ? null : body.motivo, usuario.id, agora],
        );
        // Auditoria sem o texto do motivo: só ids e a decisão.
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'decidir_resultado', 'atleta', $2, $3::jsonb, $4)`,
          [
            usuario.id,
            dono.atleta_id,
            JSON.stringify({
              resultadoId: req.params.id,
              decisao: body.decisao,
              comMotivo: !validar,
            }),
            agora,
          ],
        );
        await avisarContasDoAtleta(tx, dono.atleta_id, {
          tipo: validar ? "resultado_validado" : "resultado_recusado",
          referencia: { resultadoId: req.params.id },
          autorId: usuario.id,
          em: agora,
        });
      });

      return lerResultado(app.db, req.params.id);
    },
  );

  rota.get(
    "/atletas/:id/resultados",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["resultados"],
        summary: "Resultados do atleta, com a situação de cada um",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta (IBVAR: 403; outro atleta ou treinador: 404). Do mais recente para o mais antigo. `?status=validado|pendente|recusado` filtra pela situação (os lançados por gestor, treinador ou importados do Ranking CBVela são sempre `validado`; os da World Sailing (`fonte: world_sailing`) são `validado` até serem invalidados, e então `recusado`, com o motivo). Cada item traz fonte, edição, súmula (`anexo`), motivo da recusa ou da invalidação e quem validou.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        querystring: z.object({ status: z.enum(["validado", "pendente", "recusado"]).optional() }),
        response: {
          200: esquemaListaResultados,
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
      const params: unknown[] = [base.id];
      let filtro = "";
      if (req.query.status) {
        params.push(req.query.status);
        filtro = `and ${SQL_STATUS_RESULTADO} = $2`;
      }
      const r = await app.db.query<LinhaResultado>(
        `select ${COLUNAS_RESULTADO} from ${ORIGEM_RESULTADO}
          where r.atleta_id = $1::uuid ${filtro}
          order by r.data desc, r.id desc`,
        params,
      );
      return { itens: r.rows.map((l) => paraResultado(l)) };
    },
  );
}

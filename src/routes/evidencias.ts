import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel, limitePorIp } from "../auth/plugin.js";
import {
  esquemaErro,
  evidenciaRemovida,
  conflito,
  cotaExcedida,
  naoEncontrado,
  requisicaoInvalida,
  semAcesso,
  servicoIndisponivel,
} from "../erros.js";
import { recusarAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";
import {
  CATEGORIAS_ANEXO,
  bytesUsadosPeloAtleta,
  removerAnexoNaoVinculado,
} from "../servicos/anexos.js";
import { avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import { removerOuPendenciar } from "../servicos/arquivos-pendentes.js";
import { ErroArmazenamento } from "../storage/index.js";
import { TIPOS_ARQUIVO, decodificarArquivo, limparMetadados } from "../servicos/arquivo-base64.js";

const TAMANHO_MAXIMO_BYTES = 5 * 1024 * 1024;
/** Envios por minuto, por usuário autenticado (não por IP). Conta também as tentativas recusadas. */
const LIMITE_ENVIOS = 20;

/** Base64 de 5 MB tem ~6,7 milhões de caracteres. */
const BASE64_MAXIMO = 7_000_000;

const esquemaAnexo = z.object({
  id: z.uuid(),
  nomeArquivo: z.string(),
  tipoMime: z.string(),
  tamanhoBytes: z.number().int(),
  indicadorId: z.string().nullable(),
  categoria: z.enum(CATEGORIAS_ANEXO).describe("evidencia, sumula ou balanca"),
  enviadoPor: z
    .object({ papel: z.enum(["gestor", "treinador", "atleta"]) })
    .describe("Papel de quem enviou o arquivo (sem nome nem e-mail)"),
  enviadoEm: z.string().describe("Instante ISO"),
  removidoEm: z
    .string()
    .nullable()
    .describe(
      "Instante ISO em que o arquivo foi removido (DELETE /evidencias/{id} ou limpeza de anexo não vinculado); nulo = disponível. Atleta anonimizado não aparece na API (404)",
    ),
});

interface LinhaAnexo {
  id: string;
  nome_arquivo: string;
  tipo_mime: string;
  tamanho_bytes: number;
  indicador_id: string | null;
  categoria: (typeof CATEGORIAS_ANEXO)[number];
  papel_remetente: "gestor" | "treinador" | "atleta";
  enviado_em: Date;
  removido_em: Date | null;
}

const paraAnexo = (l: LinhaAnexo) => ({
  id: l.id,
  nomeArquivo: l.nome_arquivo,
  tipoMime: l.tipo_mime,
  tamanhoBytes: l.tamanho_bytes,
  indicadorId: l.indicador_id,
  categoria: l.categoria,
  enviadoPor: { papel: l.papel_remetente },
  enviadoEm: new Date(l.enviado_em).toISOString(),
  removidoEm: l.removido_em ? new Date(l.removido_em).toISOString() : null,
});

/** Colunas de `evidencias_anexos e`, com o papel de quem enviou (join em `usuarios u`). */
const COLUNAS =
  "e.id, e.nome_arquivo, e.tipo_mime, e.tamanho_bytes, e.indicador_id, e.categoria, u.papel as papel_remetente, e.enviado_em, e.removido_em";
const ORIGEM = "evidencias_anexos e join usuarios u on u.id = e.enviado_por";

const MB = 1024 * 1024;
const mensagemCota = (limite: number) =>
  `O limite de ${Math.floor(limite / MB)} MB de anexos deste atleta seria ultrapassado. Remova arquivos que não estão em uso e tente de novo.`;

// Sem caracteres de controle nem barras (o nome só serve de rótulo; o arquivo é guardado com nome gerado).
const nomeArquivoValido = (n: string) => {
  for (const ch of n) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c === 0x7f || ch === "/" || ch === "\\") return false;
  }
  return true;
};

export async function rotasEvidencias(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id: z.uuid() });
  const respostasComuns = { 401: esquemaErro, 403: esquemaErro, 404: esquemaErro };
  const limiteIp = limitePorIp(app);

  rota.post(
    "/atletas/:id/evidencias",
    {
      // onRequest: limite por IP e sessão são conferidos ANTES de o corpo (até 8 MB) ser lido.
      onRequest: [limiteIp, app.autenticar],
      preHandler: [exigirPapel("gestor", "treinador", "atleta"), recusarAtletaAnonimizado(app)],
      bodyLimit: 8 * 1024 * 1024,
      // Limite por usuário no preHandler: roda depois de autenticar, então 401 não gasta a cota.
      config: {
        rateLimit: {
          max: LIMITE_ENVIOS,
          timeWindow: 60_000,
          hook: "preHandler",
          keyGenerator: (req) => `evidencias:${req.usuario.id}`,
        },
      },
      schema: {
        tags: ["evidencias"],
        summary: "Anexa um arquivo (PDF, JPEG ou PNG de até 5 MB) ao atleta",
        description:
          "Gestor, treinador dos próprios atletas, ou o atleta no próprio cadastro (outro atleta: 404). IBVAR: 403. O arquivo vai em base64, é conferido pelo tamanho e pela assinatura e fica no Storage privado. `categoria`: evidencia (padrão), sumula ou balanca. Use o `id` retornado como `anexoId` ao lançar a nota. Cota de 200 MB por atleta (soma dos anexos não removidos): acima dela, 413 `cota_excedida`. Limite de 20 envios por minuto por usuário (429 `limite_excedido`).",
        security: [{ bearerAuth: [] }],
        params,
        body: z
          .object({
            nomeArquivo: z
              .string()
              .min(1)
              .max(200)
              .refine(nomeArquivoValido, "Nome de arquivo inválido."),
            tipoMime: z.enum(["application/pdf", "image/jpeg", "image/png"]),
            conteudoBase64: z.string().min(4).max(BASE64_MAXIMO),
            indicadorId: z.string().min(1).max(64).optional(),
            categoria: z.enum(CATEGORIAS_ANEXO).default("evidencia"),
          })
          .strict(),
        response: {
          201: esquemaAnexo,
          400: esquemaErro,
          ...respostasComuns,
          409: esquemaErro,
          413: esquemaErro,
          429: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const cota = app.config.COTA_ANEXOS_BYTES;
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      // JPEG e PNG saem sem EXIF/GPS; PDF segue como veio.
      const bytes = limparMetadados(
        decodificarArquivo(body.conteudoBase64, body.tipoMime, {
          bytes: TAMANHO_MAXIMO_BYTES,
          mensagem: "O arquivo passa de 5 MB.",
        }),
        body.tipoMime,
      );
      const tipo = TIPOS_ARQUIVO[body.tipoMime];

      // Confere cedo, antes de gravar no Storage; a conferência que vale é a da transação, abaixo.
      if ((await bytesUsadosPeloAtleta(app.db, base.id)) + bytes.length > cota) {
        throw cotaExcedida(mensagemCota(cota));
      }

      if (body.indicadorId) {
        const ind = await app.db.query(`select 1 from indicadores where id = $1`, [
          body.indicadorId,
        ]);
        if (ind.rows.length === 0)
          throw requisicaoInvalida(`Indicador inexistente: ${body.indicadorId}.`);
      }

      const caminho = `${base.id}/${randomUUID()}.${tipo.ext}`;
      try {
        await app.armazenamento.salvar(caminho, bytes, body.tipoMime);
      } catch (e) {
        req.log.error({ err: e }, "falha ao salvar evidência");
        throw servicoIndisponivel("Não foi possível guardar o arquivo agora.");
      }
      const sha256 = createHash("sha256").update(bytes).digest("hex");

      let anexo: LinhaAnexo;
      try {
        anexo = await app.db.transacao(async (tx) => {
          // Trava o atleta (`for share`): uma anonimização em andamento termina antes, e o envio
          // que chega depois dela é recusado com 409 (o arquivo já no Storage sai no rollback).
          // Serializa os envios do mesmo atleta: a soma da cota não pode ser lida por dois ao mesmo tempo.
          await tx.query(`select pg_advisory_xact_lock(hashtextextended($1::text, 0))`, [
            `anexos:${base.id}`,
          ]);
          await travarAtletaEditavel(tx, base.id, { exigirAtivo: true });
          if ((await bytesUsadosPeloAtleta(tx, base.id)) + bytes.length > cota) {
            throw cotaExcedida(mensagemCota(cota));
          }
          const ins = await tx.query<{ id: string }>(
            `insert into evidencias_anexos
             (atleta_id, indicador_id, categoria, nome_arquivo, tipo_mime, tamanho_bytes, caminho, sha256, enviado_por, enviado_em)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           returning id`,
            [
              base.id,
              body.indicadorId ?? null,
              body.categoria,
              body.nomeArquivo,
              body.tipoMime,
              bytes.length,
              caminho,
              sha256,
              usuario.id,
              referencia,
            ],
          );
          const linha = (
            await tx.query<LinhaAnexo>(`select ${COLUNAS} from ${ORIGEM} where e.id = $1::uuid`, [
              ins.rows[0]!.id,
            ])
          ).rows[0]!;
          // Auditoria sem o nome do arquivo: só ids, categoria, tipo e tamanho.
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
           values ($1, 'anexar_evidencia', 'atleta', $2, $3::jsonb, $4)`,
            [
              usuario.id,
              base.id,
              JSON.stringify({
                anexoId: linha.id,
                tipoMime: body.tipoMime,
                tamanhoBytes: bytes.length,
                categoria: body.categoria,
                indicadorId: body.indicadorId ?? null,
              }),
              referencia,
            ],
          );
          if (usuario.papel === "atleta") {
            await avisarTreinadorDoAtleta(tx, base.id, {
              tipo: "atleta_anexou",
              referencia: { anexoId: linha.id, categoria: body.categoria },
              autorId: usuario.id,
              em: referencia,
            });
          }
          return linha;
        });
      } catch (e) {
        // O arquivo já está no Storage e o registro não saiu: não deixa arquivo órfão. Se a
        // remoção falhar, o caminho vai para `arquivos_pendentes` (sem nome de arquivo nem dado do atleta).
        await removerOuPendenciar(
          { db: app.db, armazenamento: app.armazenamento, log: req.log, agora: app.agora },
          caminho,
          "rollback_evidencia",
        );
        throw e;
      }
      return reply.code(201).send(paraAnexo(anexo));
    },
  );

  const acessoLeitura = () => [app.autenticar, exigirPapel("gestor", "treinador", "atleta")];

  rota.get(
    "/atletas/:id/evidencias",
    {
      preHandler: acessoLeitura(),
      schema: {
        tags: ["evidencias"],
        summary: "Lista os anexos do atleta (mais recentes primeiro)",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta. IBVAR não tem acesso. Cada item traz `categoria` e `enviadoPor.papel`. Filtro opcional `categoria`. `usoBytes` e `cotaBytes` mostram a cota de anexos do atleta (soma de todos os anexos não removidos, sem o filtro).",
        security: [{ bearerAuth: [] }],
        params,
        querystring: z.object({ categoria: z.enum(CATEGORIAS_ANEXO).optional() }),
        response: {
          200: z.object({
            anexos: z.array(esquemaAnexo),
            usoBytes: z.number().int().describe("Soma dos anexos não removidos do atleta"),
            cotaBytes: z.number().int().describe("Cota de anexos por atleta"),
          }),
          400: esquemaErro,
          ...respostasComuns,
        },
      },
    },
    async (req) => {
      const base = await buscarAtletaVisivel(app.db, req.usuario, req.params.id, app.agora());
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const categoria = req.query.categoria ?? null;
      const r = await app.db.query<LinhaAnexo>(
        `select ${COLUNAS} from ${ORIGEM}
          where e.atleta_id = $1::uuid and ($2::text is null or e.categoria = $2)
          order by e.enviado_em desc, e.id`,
        [base.id, categoria],
      );
      return {
        anexos: r.rows.map(paraAnexo),
        usoBytes: await bytesUsadosPeloAtleta(app.db, base.id),
        cotaBytes: app.config.COTA_ANEXOS_BYTES,
      };
    },
  );

  rota.get(
    "/evidencias/:id/link",
    {
      preHandler: acessoLeitura(),
      schema: {
        tags: ["evidencias"],
        summary: "Link temporário (5 minutos) para abrir a evidência",
        description:
          "Mesmo acesso da listagem, pelo atleta do anexo. Anexo removido de atleta ainda visível (ex.: removido por `DELETE /evidencias/{id}`) devolve 410 `evidencia_removida`; o atleta anonimizado já responde 404 antes disso. Cada geração de link fica na auditoria.",
        security: [{ bearerAuth: [] }],
        params,
        response: {
          200: z.object({ url: z.string(), expiraEm: z.string().describe("Instante ISO") }),
          ...respostasComuns,
          410: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req) => {
      const { usuario } = req;
      const r = await app.db.query<{
        atleta_id: string;
        caminho: string;
        tipo_mime: string;
        nome_arquivo: string;
        removido_em: Date | null;
      }>(
        `select atleta_id, caminho, tipo_mime, nome_arquivo, removido_em from evidencias_anexos where id = $1::uuid`,
        [req.params.id],
      );
      const anexo = r.rows[0];
      // Anexo inexistente e anexo de atleta fora do acesso dão o mesmo 404.
      const base = anexo
        ? await buscarAtletaVisivel(app.db, usuario, anexo.atleta_id, app.agora())
        : null;
      if (!anexo || !base) throw naoEncontrado("Evidência não encontrada.");

      // Arquivo já removido: nada a assinar, o Storage nem é consultado.
      if (anexo.removido_em) throw evidenciaRemovida();

      let link;
      try {
        link = await app.armazenamento.linkTemporario(
          anexo.caminho,
          anexo.tipo_mime,
          anexo.nome_arquivo,
        );
      } catch (e) {
        req.log.error({ err: e }, "falha ao gerar link de evidência");
        throw servicoIndisponivel("Não foi possível abrir o arquivo agora.");
      }
      await app.db.query(
        `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
         values ($1, 'acessar_evidencia', 'atleta', $2, $3::jsonb, $4)`,
        [usuario.id, base.id, JSON.stringify({ anexoId: req.params.id }), app.agora()],
      );
      return link;
    },
  );

  rota.delete(
    "/evidencias/:id",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador", "atleta")],
      schema: {
        tags: ["evidencias"],
        summary: "Remove um anexo que ainda não foi ligado a nenhuma avaliação",
        description:
          "Gestor, ou quem enviou o anexo (treinador, ou o próprio atleta no próprio cadastro) desde que ainda tenha acesso ao atleta; anexo de outro atleta dá 404 para o atleta. Só vale para anexo sem avaliação ligada (`anexoId`): anexo já ligado responde 409; inexistente ou de atleta fora do acesso, 404; já removido, 410. O arquivo sai do Storage primeiro (falha = 503 e nada muda). O registro não é apagado: fica marcado como removido (`removidoEm`, nome `removido`), a mesma marcação da anonimização. Auditoria `remover_anexo` só com ids.",
        security: [{ bearerAuth: [] }],
        params,
        response: {
          204: z.null(),
          ...respostasComuns,
          409: esquemaErro,
          410: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario } = req;
      const r = await app.db.query<{ atleta_id: string; enviado_por: string }>(
        `select atleta_id, enviado_por from evidencias_anexos where id = $1::uuid`,
        [req.params.id],
      );
      const anexo = r.rows[0];
      const base = anexo
        ? await buscarAtletaVisivel(app.db, usuario, anexo.atleta_id, app.agora())
        : null;
      if (!anexo || !base) throw naoEncontrado("Evidência não encontrada.");
      if (usuario.papel !== "gestor" && anexo.enviado_por !== usuario.id) {
        throw semAcesso("Só o gestor ou quem enviou o anexo pode removê-lo.");
      }

      let resultado;
      try {
        resultado = await removerAnexoNaoVinculado(
          { db: app.db, armazenamento: app.armazenamento, agora: app.agora },
          req.params.id,
          usuario.id,
        );
      } catch (e) {
        if (e instanceof ErroArmazenamento) {
          req.log.error({ err: e }, "falha ao remover evidência do Storage");
          throw servicoIndisponivel("Não foi possível remover o arquivo agora.");
        }
        throw e;
      }
      if (resultado === "inexistente") throw naoEncontrado("Evidência não encontrada.");
      if (resultado === "ja_removido") throw evidenciaRemovida();
      if (resultado === "vinculado") {
        throw conflito(
          "Este anexo já está ligado a uma avaliação, pesagem, resultado ou conquista e não pode ser removido.",
        );
      }
      return reply.code(204).send(null);
    },
  );
}

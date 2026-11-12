import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { esquemaErro, naoEncontrado, requisicaoInvalida, servicoIndisponivel } from "../erros.js";
import { buscarAtletaVisivel } from "../repositories/atletas.js";

const TAMANHO_MAXIMO_BYTES = 5 * 1024 * 1024;
/** Envios por minuto, por usuário autenticado (não por IP). Conta também as tentativas recusadas. */
const LIMITE_ENVIOS = 20;

/** Base64 de 5 MB tem ~6,7 milhões de caracteres. */
const BASE64_MAXIMO = 7_000_000;

const TIPOS = {
  "application/pdf": { ext: "pdf", assinatura: [0x25, 0x50, 0x44, 0x46] },
  "image/png": { ext: "png", assinatura: [0x89, 0x50, 0x4e, 0x47] },
  "image/jpeg": { ext: "jpg", assinatura: [0xff, 0xd8, 0xff] },
} as const;

const esquemaAnexo = z.object({
  id: z.uuid(),
  nomeArquivo: z.string(),
  tipoMime: z.string(),
  tamanhoBytes: z.number().int(),
  indicadorId: z.string().nullable(),
  enviadoEm: z.string().describe("Instante ISO"),
});

interface LinhaAnexo {
  id: string;
  nome_arquivo: string;
  tipo_mime: string;
  tamanho_bytes: number;
  indicador_id: string | null;
  enviado_em: Date;
}

const paraAnexo = (l: LinhaAnexo) => ({
  id: l.id,
  nomeArquivo: l.nome_arquivo,
  tipoMime: l.tipo_mime,
  tamanhoBytes: l.tamanho_bytes,
  indicadorId: l.indicador_id,
  enviadoEm: new Date(l.enviado_em).toISOString(),
});

const COLUNAS = "id, nome_arquivo, tipo_mime, tamanho_bytes, indicador_id, enviado_em";

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

  rota.post(
    "/atletas/:id/evidencias",
    {
      preHandler: [app.autenticar, exigirPapel("gestor", "treinador")],
      bodyLimit: 8 * 1024 * 1024,
      // preHandler: roda depois de autenticar, então req.usuario já existe e 401 não gasta a cota.
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
        summary: "Anexa uma evidência (PDF, JPEG ou PNG de até 5 MB) ao atleta",
        description:
          "Gestor, ou treinador dos próprios atletas. O arquivo vai em base64, é conferido pelo tamanho e pela assinatura e fica no Storage privado. Use o `id` retornado como `anexoId` ao lançar a nota. Limite de 20 envios por minuto por usuário (429 `limite_excedido`).",
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
          })
          .strict(),
        response: {
          201: esquemaAnexo,
          400: esquemaErro,
          ...respostasComuns,
          429: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const { usuario, body } = req;
      const referencia = app.agora();
      const base = await buscarAtletaVisivel(app.db, usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");

      if (
        !/^[A-Za-z0-9+/]+={0,2}$/.test(body.conteudoBase64) ||
        body.conteudoBase64.length % 4 !== 0
      ) {
        throw requisicaoInvalida("Conteúdo do arquivo inválido.");
      }
      const bytes = Buffer.from(body.conteudoBase64, "base64");
      if (bytes.length === 0) throw requisicaoInvalida("Arquivo vazio.");
      if (bytes.length > TAMANHO_MAXIMO_BYTES) throw requisicaoInvalida("O arquivo passa de 5 MB.");
      const tipo = TIPOS[body.tipoMime];
      if (!tipo.assinatura.every((b, i) => bytes[i] === b)) {
        throw requisicaoInvalida("O conteúdo do arquivo não corresponde ao tipo informado.");
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
          const r = await tx.query<LinhaAnexo>(
            `insert into evidencias_anexos
             (atleta_id, indicador_id, nome_arquivo, tipo_mime, tamanho_bytes, caminho, sha256, enviado_por, enviado_em)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           returning ${COLUNAS}`,
            [
              base.id,
              body.indicadorId ?? null,
              body.nomeArquivo,
              body.tipoMime,
              bytes.length,
              caminho,
              sha256,
              usuario.id,
              referencia,
            ],
          );
          const linha = r.rows[0]!;
          // Auditoria sem o nome do arquivo: só id, tipo e tamanho.
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
                indicadorId: body.indicadorId ?? null,
              }),
              referencia,
            ],
          );
          return linha;
        });
      } catch (e) {
        // O arquivo já está no Storage e o registro não saiu: não deixa arquivo órfão.
        try {
          await app.armazenamento.remover(caminho);
        } catch (e2) {
          // Sem caminho, nome de arquivo nem dados do atleta no log.
          const falha = e2 as { code?: unknown; name?: string };
          req.log.error(
            {
              evento: "evidencia_orfa",
              erro: typeof falha.code === "string" ? falha.code : (falha.name ?? "Error"),
            },
            "falha ao remover arquivo órfão",
          );
        }
        throw e;
      }
      return reply.code(201).send(paraAnexo(anexo));
    },
  );

  const acessoLeitura = [app.autenticar, exigirPapel("gestor", "treinador", "atleta")];

  rota.get(
    "/atletas/:id/evidencias",
    {
      preHandler: acessoLeitura,
      schema: {
        tags: ["evidencias"],
        summary: "Lista as evidências anexadas ao atleta (mais recentes primeiro)",
        description:
          "Gestor, treinador dos próprios atletas e o próprio atleta. IBVAR não tem acesso.",
        security: [{ bearerAuth: [] }],
        params,
        response: { 200: z.object({ anexos: z.array(esquemaAnexo) }), ...respostasComuns },
      },
    },
    async (req) => {
      const base = await buscarAtletaVisivel(app.db, req.usuario, req.params.id);
      if (!base) throw naoEncontrado("Atleta não encontrado.");
      const r = await app.db.query<LinhaAnexo>(
        `select ${COLUNAS} from evidencias_anexos where atleta_id = $1::uuid order by enviado_em desc, id`,
        [base.id],
      );
      return { anexos: r.rows.map(paraAnexo) };
    },
  );

  rota.get(
    "/evidencias/:id/link",
    {
      preHandler: acessoLeitura,
      schema: {
        tags: ["evidencias"],
        summary: "Link temporário (5 minutos) para abrir a evidência",
        description:
          "Mesmo acesso da listagem, pelo atleta do anexo. Cada geração de link fica na auditoria.",
        security: [{ bearerAuth: [] }],
        params,
        response: {
          200: z.object({ url: z.string(), expiraEm: z.string().describe("Instante ISO") }),
          ...respostasComuns,
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
      }>(
        `select atleta_id, caminho, tipo_mime, nome_arquivo from evidencias_anexos where id = $1::uuid`,
        [req.params.id],
      );
      const anexo = r.rows[0];
      // Anexo inexistente e anexo de atleta fora do acesso dão o mesmo 404.
      const base = anexo ? await buscarAtletaVisivel(app.db, usuario, anexo.atleta_id) : null;
      if (!anexo || !base) throw naoEncontrado("Evidência não encontrada.");

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
}

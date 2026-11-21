import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { UsuarioAutenticado } from "../auth/plugin.js";
import { exigirPapel, limitePorIp } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { esquemaErro, requisicaoInvalida, servicoIndisponivel } from "../erros.js";
import { TIPOS_ARQUIVO, decodificarArquivo, limparMetadados } from "../servicos/arquivo-base64.js";
import { linkDaFoto, removerFotoSemFalhar } from "../servicos/foto-perfil.js";

const TAMANHO_MAXIMO_FOTO = 2 * 1024 * 1024;
const BASE64_MAXIMO_FOTO = 2_800_000;
const LIMITE_ENVIOS_FOTO = 10;

const pessoa = z.object({ id: z.string(), nome: z.string() });

const esquemaPerfil = z.object({
  nome: z.string(),
  email: z.string().describe("E-mail de login (só leitura)"),
  papel: z.enum(["gestor", "treinador", "atleta"]),
  fotoUrl: z.string().nullable().describe("Link assinado curto; nulo = sem foto"),
  mfaAtivo: z.boolean().describe("A sessão atual passou pelo segundo fator (aal2)"),
  atleta: z
    .object({
      velaid: z.string(),
      classe: z.object({ id: z.string(), nome: z.string() }),
      numeroVela: z.string().nullable(),
      dataNascimento: z.string().describe("AAAA-MM-DD"),
      clube: z.string().nullable(),
      cidade: z.string().nullable(),
      uf: z.string().nullable(),
      treinador: pessoa.nullable(),
      emailContato: z.string().nullable(),
      termoAceitoEm: z.string().nullable().describe("Instante ISO do aceite do termo do piloto"),
      compartilharIbvar: z.boolean(),
    })
    .nullable(),
  treinador: z.object({ quantidadeAtletas: z.number().int() }).nullable(),
});

const esquemaFoto = z.object({ fotoUrl: z.string().nullable() });

interface LinhaAtletaPerfil {
  velaid_codigo: string;
  classe_id: string;
  classe_nome: string;
  numero_vela: string | null;
  data_nascimento: string;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  email_contato: string | null;
  treinador_id: string | null;
  treinador_nome: string | null;
  termo_aceito_em: Date | null;
  compartilhar_ibvar: boolean;
}

async function dadosDoAtleta(db: Db, atletaId: string) {
  const r = await db.query<LinhaAtletaPerfil>(
    `select a.velaid_codigo, a.classe_id, c.nome as classe_nome, a.numero_vela,
            to_char(a.data_nascimento, 'YYYY-MM-DD') as data_nascimento,
            a.clube, a.cidade, a.uf, a.email_contato,
            t.id::text as treinador_id, t.nome as treinador_nome,
            (select ct.registrado_em from consentimento_atual ct
              where ct.atleta_id = a.id and ct.tipo = 'termo_piloto' and ct.concedido) as termo_aceito_em,
            coalesce((select ci.concedido from consentimento_atual ci
                       where ci.atleta_id = a.id and ci.tipo = 'compartilhar_ibvar'), false) as compartilhar_ibvar
       from atletas a
       join classes c on c.id = a.classe_id
       left join usuarios t on t.id = a.treinador_id
      where a.id = $1::uuid`,
    [atletaId],
  );
  const l = r.rows[0];
  if (!l) return null;
  return {
    velaid: l.velaid_codigo,
    classe: { id: l.classe_id, nome: l.classe_nome },
    numeroVela: l.numero_vela,
    dataNascimento: l.data_nascimento,
    clube: l.clube,
    cidade: l.cidade,
    uf: l.uf,
    treinador: l.treinador_id ? { id: l.treinador_id, nome: l.treinador_nome ?? "" } : null,
    emailContato: l.email_contato,
    termoAceitoEm: l.termo_aceito_em ? new Date(l.termo_aceito_em).toISOString() : null,
    compartilharIbvar: l.compartilhar_ibvar,
  };
}

async function montarPerfil(
  app: FastifyInstance,
  u: UsuarioAutenticado,
  log: FastifyBaseLogger,
): Promise<z.infer<typeof esquemaPerfil>> {
  const r = await app.db.query<{ nome: string; email: string; foto_caminho: string | null }>(
    `select nome, email, foto_caminho from usuarios where id = $1::uuid`,
    [u.id],
  );
  const linha = r.rows[0]!;
  let treinador: { quantidadeAtletas: number } | null = null;
  if (u.papel === "treinador") {
    const c = await app.db.query<{ n: string }>(
      `select count(*)::text as n from atletas where treinador_id = $1::uuid and ativo`,
      [u.id],
    );
    treinador = { quantidadeAtletas: Number(c.rows[0]?.n ?? 0) };
  }
  return {
    nome: linha.nome,
    email: linha.email,
    papel: u.papel as "gestor" | "treinador" | "atleta",
    fotoUrl: await linkDaFoto(app.armazenamento, linha.foto_caminho, log),
    mfaAtivo: u.aal === "aal2",
    atleta: u.papel === "atleta" && u.atletaId ? await dadosDoAtleta(app.db, u.atletaId) : null,
    treinador,
  };
}

async function auditar(
  tx: Db,
  usuarioId: string,
  acao: string,
  detalhes: Record<string, unknown>,
  em: Date,
): Promise<void> {
  await tx.query(
    `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
     values ($1::uuid, $2, 'usuarios', $1, $3::jsonb, $4)`,
    [usuarioId, acao, JSON.stringify(detalhes), em],
  );
}

export async function rotasPerfil(app: FastifyInstance): Promise<void> {
  const rota = app.withTypeProvider<ZodTypeProvider>();
  const acesso = [app.autenticar, exigirPapel("gestor", "treinador", "atleta")];
  const respostasComuns = { 401: esquemaErro, 403: esquemaErro };
  const limiteIp = limitePorIp(app);

  rota.get(
    "/me/perfil",
    {
      preHandler: acesso,
      schema: {
        tags: ["sessao"],
        summary: "Meu perfil: dados de contato, foto e, para o atleta, o cadastro",
        description: "Atleta, treinador e gestor. IBVAR recebe 403.",
        security: [{ bearerAuth: [] }],
        response: { 200: esquemaPerfil, ...respostasComuns },
      },
    },
    async (req) => montarPerfil(app, req.usuario, req.log),
  );

  rota.put(
    "/me/perfil",
    {
      preHandler: acesso,
      schema: {
        tags: ["sessao"],
        summary: "Edita o perfil: nome (treinador e gestor) ou e-mail de contato (atleta)",
        description:
          "Os dados vindos do VelaID não são editáveis aqui: a correção é pelo pedido do titular (tipo `correcao`). A auditoria guarda só os nomes dos campos.",
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            nome: z.string().trim().min(2).max(120).optional(),
            emailContato: z.email().max(254).nullable().optional(),
          })
          .strict(),
        response: { 200: esquemaPerfil, 400: esquemaErro, ...respostasComuns },
      },
    },
    async (req) => {
      const u = req.usuario;
      const { nome, emailContato } = req.body;
      const campos = [
        ...(nome !== undefined ? ["nome"] : []),
        ...(emailContato !== undefined ? ["emailContato"] : []),
      ];
      if (campos.length === 0) throw requisicaoInvalida("Informe ao menos um campo.");
      const permitido = u.papel === "atleta" ? "emailContato" : "nome";
      if (campos.some((c) => c !== permitido)) {
        throw requisicaoInvalida("Seu papel não pode editar este campo.");
      }

      await app.db.transacao(async (tx) => {
        if (nome !== undefined) {
          await tx.query(`update usuarios set nome = $2 where id = $1::uuid`, [u.id, nome]);
        } else {
          await tx.query(`update atletas set email_contato = $2 where id = $1::uuid`, [
            u.atletaId,
            emailContato,
          ]);
        }
        await auditar(tx, u.id, "editar_perfil", { campos }, app.agora());
      });
      return montarPerfil(app, u, req.log);
    },
  );

  rota.post(
    "/me/foto",
    {
      // onRequest: limite por IP e sessão são conferidos ANTES de o corpo (até 3 MB) ser lido.
      onRequest: [limiteIp, app.autenticar],
      preHandler: [exigirPapel("gestor", "treinador", "atleta")],
      bodyLimit: 3 * 1024 * 1024,
      config: {
        rateLimit: {
          max: LIMITE_ENVIOS_FOTO,
          timeWindow: 60_000,
          hook: "preHandler",
          keyGenerator: (req) => `foto:${req.usuario.id}`,
        },
      },
      schema: {
        tags: ["sessao"],
        summary: "Envia ou troca a foto de perfil (JPEG ou PNG de até 2 MB)",
        description:
          "A foto anterior é removida do Storage. Limite de 10 envios por minuto por usuário (429 `limite_excedido`).",
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            tipoMime: z.enum(["image/jpeg", "image/png"]),
            conteudoBase64: z.string().min(4).max(BASE64_MAXIMO_FOTO),
          })
          .strict(),
        response: {
          200: esquemaFoto,
          400: esquemaErro,
          ...respostasComuns,
          429: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req) => {
      const u = req.usuario;
      const { tipoMime, conteudoBase64 } = req.body;
      // Sem EXIF nem GPS: a foto do perfil é guardada só com a imagem.
      const bytes = limparMetadados(
        decodificarArquivo(conteudoBase64, tipoMime, {
          bytes: TAMANHO_MAXIMO_FOTO,
          mensagem: "A foto passa de 2 MB.",
        }),
        tipoMime,
      );
      const caminho = `fotos/${u.id}/${randomUUID()}.${TIPOS_ARQUIVO[tipoMime].ext}`;
      try {
        await app.armazenamento.salvar(caminho, bytes, tipoMime);
      } catch (e) {
        req.log.error({ err: e }, "falha ao salvar foto");
        throw servicoIndisponivel("Não foi possível guardar a foto agora.");
      }

      let anterior: string | null;
      try {
        anterior = await app.db.transacao(async (tx) => {
          const r = await tx.query<{ foto_caminho: string | null }>(
            `select foto_caminho from usuarios where id = $1::uuid for update`,
            [u.id],
          );
          await tx.query(`update usuarios set foto_caminho = $2 where id = $1::uuid`, [
            u.id,
            caminho,
          ]);
          await auditar(
            tx,
            u.id,
            "enviar_foto",
            { tipoMime, tamanhoBytes: bytes.length },
            app.agora(),
          );
          return r.rows[0]?.foto_caminho ?? null;
        });
      } catch (e) {
        await removerFotoSemFalhar(app.armazenamento, caminho, req.log);
        throw e;
      }
      if (anterior) await removerFotoSemFalhar(app.armazenamento, anterior, req.log);
      return { fotoUrl: await linkDaFoto(app.armazenamento, caminho, req.log) };
    },
  );

  rota.delete(
    "/me/foto",
    {
      preHandler: acesso,
      schema: {
        tags: ["sessao"],
        summary: "Remove a foto de perfil",
        description: "Idempotente: sem foto, também responde 204.",
        security: [{ bearerAuth: [] }],
        response: { 204: z.null().describe("Foto removida"), ...respostasComuns },
      },
    },
    async (req, reply) => {
      const u = req.usuario;
      const anterior = await app.db.transacao(async (tx) => {
        const r = await tx.query<{ foto_caminho: string | null }>(
          `select foto_caminho from usuarios where id = $1::uuid for update`,
          [u.id],
        );
        const caminho = r.rows[0]?.foto_caminho ?? null;
        if (!caminho) return null;
        await tx.query(`update usuarios set foto_caminho = null where id = $1::uuid`, [u.id]);
        await auditar(tx, u.id, "remover_foto", {}, app.agora());
        return caminho;
      });
      if (anterior) await removerFotoSemFalhar(app.armazenamento, anterior, req.log);
      return reply.code(204).send(null);
    },
  );
}

import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyBaseLogger } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { UsuarioAutenticado } from "../auth/plugin.js";
import { exigirPapel, limitePorIp } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { mesPassaporteValido, normalizarTelefone, ultimoDiaDoMes } from "../domain/index.js";
import {
  conflito,
  esquemaErro,
  naoEncontrado,
  requisicaoInvalida,
  requisicaoInvalidaCampos,
  servicoIndisponivel,
} from "../erros.js";
import { avisarTreinadorDoAtleta } from "../repositories/avisos.js";
import { lerContatoSensivel } from "../repositories/contato-sensivel.js";
import { esquemaAptidao } from "./aptidao.js";
import { cortarNoFimDaPalavra } from "../domain/world-sailing.js";
import {
  baixarFotoWorldSailing,
  FotoWorldSailingInvalida,
} from "../integracoes/world-sailing/foto.js";
import { ErroWorldSailing } from "../integracoes/world-sailing/tipos.js";
import { erroAtletaAnonimizado, travarAtletaEditavel } from "../repositories/anonimizado.js";
import { TIPOS_ARQUIVO, decodificarArquivo, limparMetadados } from "../servicos/arquivo-base64.js";
import { removerOuPendenciar } from "../servicos/arquivos-pendentes.js";
import { linkDaFoto } from "../servicos/foto-perfil.js";

const TAMANHO_MAXIMO_FOTO = 2 * 1024 * 1024;
const BASE64_MAXIMO_FOTO = 2_800_000;
const LIMITE_ENVIOS_FOTO = 10;

const CAMPOS_DO_ATLETA = ["emailContato", "telefone", "passaporteValidoAte", "bio"];

/** Controle que não seja tabulação, quebra de linha nem retorno de carro (o Postgres nem aceita o nulo). */
const temCaractereDeControle = (texto: string): boolean =>
  [...texto].some((c) => {
    const n = c.charCodeAt(0);
    return n === 127 || (n < 32 && n !== 9 && n !== 10 && n !== 13);
  });

const pessoa = z.object({ id: z.string(), nome: z.string() });

const esquemaPerfil = z.object({
  nome: z.string(),
  email: z.string().describe("E-mail de login (só leitura)"),
  papel: z.enum(["gestor", "treinador", "atleta"]),
  fotoUrl: z.string().nullable().describe("Link assinado curto; nulo = sem foto"),
  mfaAtivo: z.boolean().describe("A sessão atual passou pelo segundo fator (aal2)"),
  atleta: z
    .object({
      wsId: z.string().describe("ID World Sailing (a chave do atleta)"),
      velaid: z.string().nullable().describe("Nulo se o atleta não tem VelaID"),
      cadastroCompleto: z
        .boolean()
        .describe(
          "Falso até o atleta informar nome, gênero e data de nascimento (PUT /me/cadastro)",
        ),
      classe: z.object({ id: z.string(), nome: z.string() }),
      numeroVela: z.string().nullable(),
      dataNascimento: z.string().nullable().describe("AAAA-MM-DD; nula com o cadastro incompleto"),
      clube: z.string().nullable(),
      cidade: z.string().nullable(),
      uf: z.string().nullable(),
      treinador: pessoa.nullable(),
      emailContato: z.string().nullable(),
      termoAceitoEm: z.string().nullable().describe("Instante ISO do aceite do termo do piloto"),
      compartilharIbvar: z.boolean(),
      telefone: z.string().nullable().describe("E.164 (+5511999998888); nulo se não informado"),
      passaporteValidoAte: z
        .string()
        .nullable()
        .describe("AAAA-MM (último dia do mês); sem número nem cópia do passaporte"),
      aptidao: esquemaAptidao
        .nullable()
        .describe("Última aptidão conferida pelo gestor; nulo se nunca conferida"),
      bio: z
        .string()
        .nullable()
        .describe("Mini bio (texto simples, até 500 caracteres); nula se não escreveu"),
    })
    .nullable(),
  treinador: z.object({ quantidadeAtletas: z.number().int() }).nullable(),
  sugestaoWorldSailing: z
    .object({
      fotoUrl: z
        .string()
        .nullable()
        .describe("Foto de https://assets.sailing.org/, para a prévia (o servidor é quem a baixa)"),
      bio: z.string().nullable().describe("Texto da World Sailing; vai cortado em 500 caracteres"),
    })
    .nullable()
    .describe(
      "Sugestão de foto e bio do perfil da World Sailing (D19). Só para o atleta, enquanto ele não decidiu (POST /me/perfil/world-sailing) e houver foto ou bio; nulo nos demais casos",
    ),
});

const esquemaFoto = z.object({ fotoUrl: z.string().nullable() });

interface LinhaAtletaPerfil {
  ws_id: string;
  cadastro_completo: boolean;
  velaid_codigo: string | null;
  classe_id: string;
  classe_nome: string;
  numero_vela: string | null;
  data_nascimento: string | null;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  email_contato: string | null;
  treinador_id: string | null;
  treinador_nome: string | null;
  termo_aceito_em: Date | null;
  compartilhar_ibvar: boolean;
  bio: string | null;
}

async function dadosDoAtleta(db: Db, u: UsuarioAutenticado, atletaId: string, em: Date) {
  const r = await db.query<LinhaAtletaPerfil>(
    `select a.ws_id, (a.cadastro_completo_em is not null) as cadastro_completo,
            a.velaid_codigo, a.classe_id, c.nome as classe_nome, a.numero_vela,
            to_char(a.data_nascimento, 'YYYY-MM-DD') as data_nascimento,
            a.clube, a.cidade, a.uf, a.email_contato, a.bio,
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
  const sensivel = await lerContatoSensivel(db, u, atletaId, em);
  return {
    wsId: l.ws_id,
    velaid: l.velaid_codigo,
    cadastroCompleto: l.cadastro_completo,
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
    telefone: sensivel?.telefone ?? null,
    passaporteValidoAte: sensivel?.passaporteValidoAte ?? null,
    aptidao: sensivel?.aptidao ?? null,
    bio: l.bio,
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
    atleta:
      u.papel === "atleta" && u.atletaId
        ? await dadosDoAtleta(app.db, u, u.atletaId, app.agora())
        : null,
    treinador,
    sugestaoWorldSailing:
      u.papel === "atleta" && u.atletaId ? await sugestaoDeFotoEBio(app.db, u.atletaId) : null,
  };
}

/** Foto e bio sugeridas pela World Sailing, enquanto o atleta não decidiu e houver o que sugerir. */
async function sugestaoDeFotoEBio(
  db: Db,
  atletaId: string,
): Promise<{ fotoUrl: string | null; bio: string | null } | null> {
  const r = await db.query<{ foto_url: string | null; bio: string | null }>(
    `select p.foto_url, p.bio
       from world_sailing_perfis p join atletas a on a.id = p.atleta_id
      where p.atleta_id = $1::uuid and a.anonimizado_em is null and p.foto_bio_decidida_em is null
        and (p.foto_url is not null or p.bio is not null)`,
    [atletaId],
  );
  const l = r.rows[0];
  return l ? { fotoUrl: l.foto_url, bio: l.bio ? cortarNoFimDaPalavra(l.bio, 500) : null } : null;
}

/**
 * Guarda a foto de perfil do usuário (já sem metadados) e troca a anterior. `noMesmaTransacao` roda na
 * transação que grava o caminho (se ela falhar, o arquivo novo sai do Storage). A foto antiga sai depois.
 */
async function trocarFotoDoUsuario(
  app: FastifyInstance,
  log: FastifyBaseLogger,
  usuarioId: string,
  bytes: Buffer,
  tipoMime: keyof typeof TIPOS_ARQUIVO,
  detalhesAuditoria: Record<string, unknown>,
  noMesmaTransacao?: (tx: Db) => Promise<void>,
): Promise<string> {
  const limpeza = { db: app.db, armazenamento: app.armazenamento, log, agora: app.agora };
  const caminho = `fotos/${usuarioId}/${randomUUID()}.${TIPOS_ARQUIVO[tipoMime].ext}`;
  try {
    await app.armazenamento.salvar(caminho, bytes, tipoMime);
  } catch (e) {
    log.error({ err: e }, "falha ao salvar foto");
    throw servicoIndisponivel("Não foi possível guardar a foto agora.");
  }
  let anterior: string | null;
  try {
    anterior = await app.db.transacao(async (tx) => {
      const r = await tx.query<{ foto_caminho: string | null }>(
        `select foto_caminho from usuarios where id = $1::uuid for update`,
        [usuarioId],
      );
      await tx.query(`update usuarios set foto_caminho = $2 where id = $1::uuid`, [
        usuarioId,
        caminho,
      ]);
      await auditar(
        tx,
        usuarioId,
        "enviar_foto",
        { tipoMime, tamanhoBytes: bytes.length, ...detalhesAuditoria },
        app.agora(),
      );
      if (noMesmaTransacao) await noMesmaTransacao(tx);
      return r.rows[0]?.foto_caminho ?? null;
    });
  } catch (e) {
    await removerOuPendenciar(limpeza, caminho, "rollback_foto");
    throw e;
  }
  if (anterior) await removerOuPendenciar(limpeza, anterior, "troca_foto");
  return caminho;
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
  // Um array novo por rota: o plugin de rate-limit empurra hooks no array da rota e não pode vazar para as outras.
  const acesso = () => [app.autenticar, exigirPapel("gestor", "treinador", "atleta")];
  const respostasComuns = { 401: esquemaErro, 403: esquemaErro };
  const limiteIp = limitePorIp(app);

  rota.get(
    "/me/perfil",
    {
      preHandler: acesso(),
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
      preHandler: acesso(),
      schema: {
        tags: ["sessao"],
        summary:
          "Edita o perfil: nome (treinador e gestor) ou e-mail, telefone e validade do passaporte (atleta)",
        description:
          "Nome, gênero e data de nascimento do atleta (informados em PUT /me/cadastro) e o ID World Sailing não são editáveis aqui: a correção é pelo pedido do titular (tipo `correcao`); só o gestor troca o WS ID. `telefone` (atleta): E.164; aceita espaços, parênteses, traços e pontos, que são removidos; sem `+` só com DDD brasileiro (10 ou 11 dígitos), e então vira `+55...`; outro formato é 400. `passaporteValidoAte` (atleta): `AAAA-MM`, gravado como o último dia do mês; data passada é aceita (serve para avisar que venceu); não guardamos número nem cópia do passaporte. `telefone` e `passaporteValidoAte` aceitam `null` para apagar. `bio` (atleta): texto simples de até 500 caracteres (espaços nas pontas saem; vazio ou `null` apaga). A auditoria guarda só os nomes dos campos (nunca o texto da bio).",
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            nome: z
              .string()
              .trim()
              .min(2, "O nome precisa ter ao menos 2 caracteres.")
              .max(120, "O nome pode ter no máximo 120 caracteres.")
              .optional(),
            emailContato: z
              .email("Informe um e-mail válido.")
              .max(254, "O e-mail pode ter no máximo 254 caracteres.")
              .nullable()
              .optional(),
            telefone: z
              .string()
              .max(40, "O telefone pode ter no máximo 40 caracteres.")
              .nullable()
              .optional()
              .describe("E.164, ou só com DDD brasileiro (vira +55...); null apaga"),
            passaporteValidoAte: z
              .string()
              .max(7, "Informe o mês no formato AAAA-MM.")
              .nullable()
              .optional()
              .describe("AAAA-MM; null apaga"),
            bio: z
              .string()
              .trim()
              .max(500, "A bio pode ter no máximo 500 caracteres.")
              .refine((t) => !temCaractereDeControle(t), {
                message: "A bio aceita só texto simples.",
              })
              .nullable()
              .optional()
              .describe(
                "Mini bio do atleta (texto simples, até 500 caracteres; vazio ou null apaga). Texto livre visto pelo gestor, pelo treinador e, com o aceite do termo que inclui foto e bio, pelo IBVAR: não cite saúde, família nem contato",
              ),
          })
          .strict(),
        response: { 200: esquemaPerfil, 400: esquemaErro, ...respostasComuns },
      },
    },
    async (req) => {
      const u = req.usuario;
      const { nome, emailContato, telefone, passaporteValidoAte } = req.body;
      // Bio vazia apaga, como null.
      const bio = req.body.bio === undefined ? undefined : req.body.bio?.trim() || null;
      const campos = [
        ...(nome !== undefined ? ["nome"] : []),
        ...(emailContato !== undefined ? ["emailContato"] : []),
        ...(telefone !== undefined ? ["telefone"] : []),
        ...(passaporteValidoAte !== undefined ? ["passaporteValidoAte"] : []),
        ...(bio !== undefined ? ["bio"] : []),
      ];
      if (campos.length === 0) throw requisicaoInvalida("Informe ao menos um campo.");
      const permitidos = u.papel === "atleta" ? CAMPOS_DO_ATLETA : ["nome"];
      if (campos.some((c) => !permitidos.includes(c))) {
        throw requisicaoInvalida("Seu papel não pode editar este campo.");
      }

      const invalidos: { campo: string; mensagem: string }[] = [];
      let telefoneE164: string | null = null;
      if (typeof telefone === "string") {
        telefoneE164 = normalizarTelefone(telefone);
        if (telefoneE164 === null)
          invalidos.push({
            campo: "telefone",
            mensagem:
              "Informe o telefone com DDD (ex.: (11) 99999-8888) ou com o código do país (ex.: +351 912 345 678).",
          });
      }
      if (typeof passaporteValidoAte === "string" && !mesPassaporteValido(passaporteValidoAte)) {
        invalidos.push({
          campo: "passaporteValidoAte",
          mensagem: "Informe o mês no formato AAAA-MM, com mês de 01 a 12 (ex.: 2029-03).",
        });
      }
      if (invalidos.length > 0) throw requisicaoInvalidaCampos(invalidos);

      await app.db.transacao(async (tx) => {
        if (nome !== undefined) {
          await tx.query(`update usuarios set nome = $2 where id = $1::uuid`, [u.id, nome]);
        } else {
          // Só os campos enviados mudam; null apaga.
          const sets: string[] = [];
          const params: unknown[] = [u.atletaId];
          const set = (coluna: string, valor: unknown) => {
            params.push(valor);
            sets.push(`${coluna} = $${params.length}`);
          };
          if (emailContato !== undefined) set("email_contato", emailContato);
          if (telefone !== undefined) set("telefone", telefoneE164);
          if (bio !== undefined) set("bio", bio);
          if (passaporteValidoAte !== undefined)
            set(
              "passaporte_valido_ate",
              passaporteValidoAte === null ? null : ultimoDiaDoMes(passaporteValidoAte),
            );
          await tx.query(`update atletas set ${sets.join(", ")} where id = $1::uuid`, params);
        }
        await auditar(tx, u.id, "editar_perfil", { campos }, app.agora());
        if (u.papel === "atleta" && u.atletaId) {
          await avisarTreinadorDoAtleta(tx, u.atletaId, {
            tipo: "atleta_atualizou_perfil",
            referencia: { campos },
            autorId: u.id,
            em: app.agora(),
          });
        }
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
      const caminho = await trocarFotoDoUsuario(app, req.log, u.id, bytes, tipoMime, {});
      return { fotoUrl: await linkDaFoto(app.armazenamento, caminho, req.log) };
    },
  );

  rota.post(
    "/me/perfil/world-sailing",
    {
      preHandler: [app.autenticar, exigirPapel("atleta")],
      schema: {
        tags: ["sessao"],
        summary: "O atleta aceita ou dispensa a foto e a bio sugeridas pela World Sailing",
        description:
          "Só o atleta, uma vez (a decisão fica marcada, também quando ele dispensa com `usarFoto` e `usarBio` falsos; depois disso, 409). Sem sugestão, 404. `usarFoto`: o SERVIDOR baixa a foto, só de https://assets.sailing.org/ (sem seguir redirecionamento, até 5 MB, só JPEG ou PNG conferidos pela assinatura do arquivo; outro formato dá 400, falha de rede ou tempo esgotado dá 503), tira EXIF e GPS e a guarda como a foto do perfil (a regra de foto e bio para o IBVAR é a mesma de sempre: só com consentimento na versão do termo que inclui foto e bio). `usarBio`: a bio da World Sailing, cortada em 500 caracteres no fim de uma palavra, substitui a bio do perfil. Pedir uma delas sem a sugestão correspondente dá 400. A auditoria guarda só se usou foto e bio (nunca o texto).",
        security: [{ bearerAuth: [] }],
        body: z
          .object({
            usarFoto: z.boolean("Informe se quer usar a foto."),
            usarBio: z.boolean("Informe se quer usar a bio."),
          })
          .strict(),
        response: {
          200: z.object({
            usouFoto: z.boolean(),
            usouBio: z.boolean(),
            fotoUrl: z.string().nullable().describe("Link assinado curto da foto do perfil"),
            bio: z.string().nullable().describe("Bio atual do perfil"),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
          503: esquemaErro,
        },
      },
    },
    async (req) => {
      const u = req.usuario;
      if (!u.atletaId) throw naoEncontrado("Atleta não encontrado.");
      const atletaId = u.atletaId;
      const { usarFoto, usarBio } = req.body;
      const sug = await app.db.query<{
        foto_url: string | null;
        bio: string | null;
        decidida: boolean;
        anonimizado: boolean;
      }>(
        `select p.foto_url, p.bio, (p.foto_bio_decidida_em is not null) as decidida,
                (a.anonimizado_em is not null) as anonimizado
           from world_sailing_perfis p join atletas a on a.id = p.atleta_id
          where p.atleta_id = $1::uuid`,
        [atletaId],
      );
      const s = sug.rows[0];
      if (!s) throw naoEncontrado("Não há sugestão da World Sailing para este perfil.");
      if (s.anonimizado) throw erroAtletaAnonimizado();
      if (s.decidida) throw conflito("Você já decidiu sobre a foto e a bio da World Sailing.");
      if (usarFoto && !s.foto_url) throw requisicaoInvalida("A World Sailing não trouxe foto.");
      if (usarBio && !s.bio) throw requisicaoInvalida("A World Sailing não trouxe bio.");

      let foto: { bytes: Buffer; tipoMime: "image/jpeg" | "image/png" } | null = null;
      if (usarFoto) {
        try {
          const baixada = await baixarFotoWorldSailing(s.foto_url!, app.worldSailing.fetch);
          foto = {
            bytes: limparMetadados(baixada.bytes, baixada.tipoMime),
            tipoMime: baixada.tipoMime,
          };
        } catch (e) {
          if (e instanceof FotoWorldSailingInvalida) {
            throw requisicaoInvalida(
              "A foto da World Sailing não pôde ser usada (endereço, formato ou tamanho). Envie uma foto pelo perfil.",
            );
          }
          if (e instanceof ErroWorldSailing) {
            req.log.warn(
              { evento: "world_sailing_foto_falhou", erro: e.codigo },
              "foto não baixou",
            );
            throw servicoIndisponivel("Não foi possível baixar a foto da World Sailing agora.");
          }
          throw e;
        }
      }
      const bio = usarBio && s.bio ? cortarNoFimDaPalavra(s.bio, 500) : null;

      const decidir = async (tx: Db): Promise<void> => {
        await travarAtletaEditavel(tx, atletaId);
        const marcou = await tx.query(
          `update world_sailing_perfis set foto_bio_decidida_em = $2
            where atleta_id = $1::uuid and foto_bio_decidida_em is null returning atleta_id`,
          [atletaId, app.agora()],
        );
        if (marcou.rows.length === 0) {
          throw conflito("Você já decidiu sobre a foto e a bio da World Sailing.");
        }
        if (bio) await tx.query(`update atletas set bio = $2 where id = $1::uuid`, [atletaId, bio]);
        await auditar(
          tx,
          u.id,
          "aceitar_sugestao_world_sailing",
          { usouFoto: foto !== null, usouBio: bio !== null },
          app.agora(),
        );
      };

      if (foto) {
        await trocarFotoDoUsuario(
          app,
          req.log,
          u.id,
          foto.bytes,
          foto.tipoMime,
          { origem: "world_sailing" },
          decidir,
        );
      } else {
        await app.db.transacao(decidir);
      }

      const atual = await app.db.query<{ foto_caminho: string | null; bio: string | null }>(
        `select u.foto_caminho, a.bio from usuarios u join atletas a on a.id = $2::uuid where u.id = $1::uuid`,
        [u.id, atletaId],
      );
      return {
        usouFoto: foto !== null,
        usouBio: bio !== null,
        fotoUrl: await linkDaFoto(app.armazenamento, atual.rows[0]?.foto_caminho ?? null, req.log),
        bio: atual.rows[0]?.bio ?? null,
      };
    },
  );

  rota.delete(
    "/me/foto",
    {
      preHandler: acesso(),
      schema: {
        tags: ["sessao"],
        summary: "Remove a foto de perfil",
        description:
          "Idempotente: sem foto, também responde 204. O arquivo sai do Storage antes de o caminho sair do banco: se o Storage falhar, responde 503 e a foto continua (tente de novo).",
        security: [{ bearerAuth: [] }],
        response: {
          204: z.null().describe("Foto removida"),
          ...respostasComuns,
          503: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const u = req.usuario;
      const atual = await app.db.query<{ foto_caminho: string | null }>(
        `select foto_caminho from usuarios where id = $1::uuid`,
        [u.id],
      );
      const caminho = atual.rows[0]?.foto_caminho ?? null;
      if (!caminho) return reply.code(204).send(null);
      // O arquivo sai primeiro: se a remoção falhar o caminho continua no banco e dá para repetir.
      try {
        await app.armazenamento.remover(caminho);
      } catch (e) {
        req.log.error({ err: e }, "falha ao remover foto");
        throw servicoIndisponivel("Não foi possível remover a foto agora. Tente de novo.");
      }
      await app.db.transacao(async (tx) => {
        const r = await tx.query(
          `update usuarios set foto_caminho = null where id = $1::uuid and foto_caminho = $2 returning id`,
          [u.id, caminho],
        );
        if (r.rows.length > 0) await auditar(tx, u.id, "remover_foto", {}, app.agora());
      });
      return reply.code(204).send(null);
    },
  );
}

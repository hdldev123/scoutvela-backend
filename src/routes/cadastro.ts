import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { exigirPapel } from "../auth/plugin.js";
import { idadeEm } from "../domain/index.js";
import { ErroApi, esquemaErro, naoEncontrado } from "../erros.js";
import { ArquivoRejeitado, importarCsv } from "../importacao/index.js";

const VERSAO_TERMO = "Piloto 18+ · v1";
const IDADE_MINIMA_PILOTO = 18;
const CODIGO_VELAID = /^[A-Z]{2}-[A-Z0-9]{2,10}$/;

const requisicaoInvalida = (m: string) => new ErroApi(400, "requisicao_invalida", m);
/** Conflito de estado (já cadastrado, já aceito). Usa o código `requisicao_invalida` com status 409. */
const conflito = (m: string) => new ErroApi(409, "requisicao_invalida", m);

function normalizarCodigo(texto: string): string {
  const codigo = texto.trim().toUpperCase();
  if (!CODIGO_VELAID.test(codigo)) {
    throw requisicaoInvalida("Código VelaID inválido. Use o formato UF-XXXX, por exemplo MG-T15.");
  }
  return codigo;
}

function motivoMenor(nome: string, idade: number): string {
  return `Cadastro bloqueado: ${nome} tem ${idade} anos. O piloto aceita só 18+; a versão para menores, com responsável, está em desenho.`;
}

interface LinhaVelaId {
  codigo: string;
  nome: string;
  genero: "F" | "M";
  data_nascimento: string;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  ws_id: string | null;
  email: string | null;
}

const COLUNAS_VELAID_SQL = "codigo, nome, genero, data_nascimento::text as data_nascimento, clube, cidade, uf, ws_id, email";

const esquemaBusca = z.object({
  codigo: z.string().max(40).describe("Código VelaID (ex.: MG-T15); espaços e minúsculas são normalizados"),
});

const esquemaRespostaBusca = z.object({
  codigo: z.string(),
  nome: z.string(),
  genero: z.enum(["F", "M"]),
  dataNascimento: z.string().describe("AAAA-MM-DD"),
  idade: z.number().int(),
  clube: z.string().nullable(),
  cidade: z.string().nullable(),
  uf: z.string().nullable(),
  wsId: z.string().nullable(),
  jaNoPiloto: z.boolean(),
  elegivel: z.boolean(),
  motivo: z.string().nullable().describe("Por que não é elegível; nulo quando elegível"),
});

const esquemaCadastro = z.object({
  velaidCodigo: z.string().max(40),
  classeId: z.string().min(1).max(40),
  treinadorId: z.uuid(),
});

const esquemaImportacao = z.object({
  tipo: z.enum(["velaid", "ranking_cbvela"]),
  arquivoNome: z.string().max(200).optional(),
  conteudo: z.string().min(1).max(512 * 1024).describe("CSV em texto (UTF-8), até 512 KB"),
});

const esquemaRespostaImportacao = z.object({
  id: z.number().int(),
  linhasOk: z.number().int(),
  linhasErro: z.number().int(),
  erros: z.array(z.object({ linha: z.number().int(), mensagem: z.string() })).describe("Até 200 erros; linhasErro traz a contagem total"),
});

export async function rotasCadastro(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const soGestor = [app.autenticar, exigirPapel("gestor")];
  const seguranca = [{ bearerAuth: [] }];

  r.post(
    "/velaid/busca",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Busca um atleta no VelaID pelo código",
        description: "Não devolve e-mail. Menor de 18 anos e atleta já cadastrado vêm com elegivel=false e o motivo.",
        security: seguranca,
        body: esquemaBusca,
        response: { 200: esquemaRespostaBusca, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro, 404: esquemaErro },
      },
    },
    async (req) => {
      const codigo = normalizarCodigo(req.body.codigo);
      const { rows } = await app.db.query<LinhaVelaId>(`select ${COLUNAS_VELAID_SQL} from velaid_registros where codigo = $1`, [codigo]);
      const v = rows[0];
      if (!v) throw naoEncontrado(`Nenhum atleta com o código ${codigo} no VelaID.`);

      const idade = idadeEm(v.data_nascimento, app.agora());
      const existente = await app.db.query("select 1 from atletas where velaid_codigo = $1", [codigo]);
      const jaNoPiloto = existente.rows.length > 0;
      let motivo: string | null = null;
      if (jaNoPiloto) motivo = `O código ${codigo} já está no piloto.`;
      else if (idade < IDADE_MINIMA_PILOTO) motivo = motivoMenor(v.nome, idade);

      return {
        codigo: v.codigo,
        nome: v.nome,
        genero: v.genero,
        dataNascimento: v.data_nascimento,
        idade,
        clube: v.clube,
        cidade: v.cidade,
        uf: v.uf,
        wsId: v.ws_id,
        jaNoPiloto,
        elegivel: motivo === null,
        motivo,
      };
    },
  );

  r.get(
    "/treinadores",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Treinadores ativos (para escolher o responsável no cadastro)",
        security: seguranca,
        response: { 200: z.array(z.object({ id: z.string(), nome: z.string() })), 401: esquemaErro, 403: esquemaErro },
      },
    },
    async () => {
      const { rows } = await app.db.query<{ id: string; nome: string }>(
        "select id, nome from usuarios where papel = 'treinador' and ativo order by nome",
      );
      return rows;
    },
  );

  r.post(
    "/atletas",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Cadastra o atleta a partir do VelaID e registra o envio do termo",
        description:
          "Revalida tudo no servidor: existe no VelaID, 18+, ainda não cadastrado, classe ativa e treinador válido. O atleta só entra no ranking depois do aceite do termo.",
        security: seguranca,
        body: esquemaCadastro,
        response: {
          201: z.object({
            id: z.string(),
            nome: z.string(),
            termo: z.object({ status: z.literal("aguardando_aceite"), versao: z.string() }),
          }),
          400: esquemaErro,
          401: esquemaErro,
          403: esquemaErro,
          404: esquemaErro,
          409: esquemaErro,
        },
      },
    },
    async (req, reply) => {
      const codigo = normalizarCodigo(req.body.velaidCodigo);
      const { classeId, treinadorId } = req.body;
      const usuarioId = req.usuario.id;
      const referencia = app.agora();

      const criado = await app.db
        .transacao(async (tx) => {
          const v = (await tx.query<LinhaVelaId>(`select ${COLUNAS_VELAID_SQL} from velaid_registros where codigo = $1`, [codigo])).rows[0];
          if (!v) throw naoEncontrado(`Nenhum atleta com o código ${codigo} no VelaID.`);
          const idade = idadeEm(v.data_nascimento, referencia);
          if (idade < IDADE_MINIMA_PILOTO) throw requisicaoInvalida(motivoMenor(v.nome, idade));
          if ((await tx.query("select 1 from atletas where velaid_codigo = $1", [codigo])).rows.length > 0) {
            throw conflito(`O código ${codigo} já está no piloto.`);
          }
          if ((await tx.query("select 1 from classes where id = $1 and ativa", [classeId])).rows.length === 0) {
            throw requisicaoInvalida("Classe inválida ou inativa.");
          }
          const trein = await tx.query("select 1 from usuarios where id = $1 and papel = 'treinador' and ativo", [treinadorId]);
          if (trein.rows.length === 0) throw requisicaoInvalida("Treinador inválido ou inativo.");

          const ins = await tx.query<{ id: string }>(
            `insert into atletas (velaid_codigo, nome, genero, data_nascimento, classe_id, clube, cidade, uf, ws_id,
                                  treinador_id, email_contato, criado_por)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
            [v.codigo, v.nome, v.genero, v.data_nascimento, classeId, v.clube, v.cidade, v.uf, v.ws_id, treinadorId, v.email, usuarioId],
          );
          const id = ins.rows[0]!.id;
          const detalhes = JSON.stringify({ velaid: codigo, classeId, versaoTermo: VERSAO_TERMO });
          await tx.query(
            `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
             values ($1, 'cadastrar_atleta', 'atletas', $2, $3::jsonb), ($1, 'enviar_termo', 'atletas', $2, $3::jsonb)`,
            [usuarioId, id, detalhes],
          );
          return { id, nome: v.nome };
        })
        .catch((e: unknown) => {
          // Cadastro simultâneo do mesmo código: a restrição única do banco decide.
          if ((e as { code?: string }).code === "23505") throw conflito(`O código ${codigo} já está no piloto.`);
          throw e;
        });

      // Provedor de e-mail ainda não definido: só log estruturado, sem e-mail nem dado pessoal.
      req.log.info({ evento: "termo_enviado", atletaId: criado.id, versao: VERSAO_TERMO }, "termo do piloto enviado");
      return reply.code(201).send({ ...criado, termo: { status: "aguardando_aceite" as const, versao: VERSAO_TERMO } });
    },
  );

  // Rota estática: o Fastify a prefere a GET /atletas/:id (em atletas.ts) para o texto "pendentes".
  r.get(
    "/atletas/pendentes",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Atletas cadastrados que ainda não aceitaram o termo do piloto",
        security: seguranca,
        response: {
          200: z.array(
            z.object({
              id: z.string(),
              nome: z.string(),
              velaid: z.string(),
              classe: z.object({ id: z.string(), nome: z.string() }),
              criadoEm: z.string().describe("Instante ISO"),
            }),
          ),
          401: esquemaErro,
          403: esquemaErro,
        },
      },
    },
    async () => {
      const { rows } = await app.db.query<{ id: string; nome: string; velaid: string; classe_id: string; classe_nome: string; criado_em: Date }>(
        `select a.id, a.nome, a.velaid_codigo as velaid, c.id as classe_id, c.nome as classe_nome, a.criado_em
           from atletas a join classes c on c.id = a.classe_id
          where a.ativo
            and not exists (select 1 from consentimento_atual ct
                             where ct.atleta_id = a.id and ct.tipo = 'termo_piloto' and ct.concedido)
          order by a.criado_em, a.nome`,
      );
      return rows.map((l) => ({
        id: l.id,
        nome: l.nome,
        velaid: l.velaid,
        classe: { id: l.classe_id, nome: l.classe_nome },
        criadoEm: new Date(l.criado_em).toISOString(),
      }));
    },
  );

  r.post(
    "/atletas/:id/termo",
    {
      preHandler: soGestor,
      schema: {
        tags: ["cadastro"],
        summary: "Registra o aceite do termo do piloto recebido do atleta",
        description:
          "Não concede o compartilhamento com o IBVAR: essa decisão é do atleta (consentimento explícito). Depois do aceite o atleta entra no ranking.",
        security: seguranca,
        params: z.object({ id: z.uuid() }),
        body: z.object({ versao: z.literal(VERSAO_TERMO) }),
        response: { 200: z.object({ ok: z.literal(true) }), 400: esquemaErro, 401: esquemaErro, 403: esquemaErro, 404: esquemaErro, 409: esquemaErro },
      },
    },
    async (req) => {
      const { id } = req.params;
      const usuarioId = req.usuario.id;
      await app.db.transacao(async (tx) => {
        const a = await tx.query("select 1 from atletas where id = $1 and ativo for update", [id]);
        if (a.rows.length === 0) throw naoEncontrado("Atleta não encontrado.");
        const aceito = await tx.query(
          "select 1 from consentimento_atual where atleta_id = $1 and tipo = 'termo_piloto' and concedido",
          [id],
        );
        if (aceito.rows.length > 0) throw conflito("O termo deste atleta já foi aceito.");
        await tx.query(
          `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
           values ($1, 'termo_piloto', true, $2, $3, $4)`,
          [id, req.body.versao, app.agora(), usuarioId],
        );
        await tx.query(
          `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes)
           values ($1, 'registrar_aceite_termo', 'atletas', $2, $3::jsonb)`,
          [usuarioId, id, JSON.stringify({ versaoTermo: req.body.versao })],
        );
      });
      return { ok: true as const };
    },
  );

  r.post(
    "/importacoes",
    {
      preHandler: soGestor,
      bodyLimit: 2 * 1024 * 1024,
      schema: {
        tags: ["cadastro"],
        summary: "Importa CSV do VelaID ou do Ranking CBVela",
        description:
          "JSON com o CSV em texto. Separador ; ou , (detectado no cabeçalho). VelaID: codigo;nome;genero;data_nascimento;clube;cidade;uf;ws_id;email. " +
          "Ranking CBVela: velaid;nivel;evento;data;posicao;tamanho_frota;pontos (nível brasileiro, estadual ou regional). " +
          "Colunas cpf, rg, documento, endereço e renda rejeitam o arquivo inteiro. Linha inválida vira erro da linha.",
        security: seguranca,
        body: esquemaImportacao,
        response: { 201: esquemaRespostaImportacao, 400: esquemaErro, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req, reply) => {
      const { tipo, conteudo } = req.body;
      if (Buffer.byteLength(conteudo, "utf8") > 512 * 1024) {
        throw requisicaoInvalida("O arquivo passa de 512 KB.");
      }
      // eslint-disable-next-line no-control-regex
      const arquivoNome = req.body.arquivoNome?.replace(/[\u0000-\u001f\u007f]/g, "").trim() || null;
      try {
        const res = await importarCsv(app.db, { tipo, arquivoNome, conteudo, usuarioId: req.usuario.id, agora: app.agora() });
        return reply.code(201).send(res);
      } catch (e) {
        if (e instanceof ArquivoRejeitado) throw requisicaoInvalida(e.message);
        throw e;
      }
    },
  );
}

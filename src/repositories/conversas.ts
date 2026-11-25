import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";

/**
 * Chat (D16, decisão I). Três tipos de conversa:
 *  - `treinador_atleta`: 1:1, privada, ligada ao par (treinador, atleta);
 *  - `gestao_atleta`: o atleta com a gestão (caixa compartilhada dos gestores; uma por atleta);
 *  - `gestao_treinador`: o treinador com a gestão (caixa compartilhada; uma por treinador).
 * Atleta com atleta não existe e o IBVAR não participa. A matriz de acesso fica no SQL abaixo.
 */
export const TIPOS_CONVERSA = ["treinador_atleta", "gestao_atleta", "gestao_treinador"] as const;
export type TipoConversa = (typeof TIPOS_CONVERSA)[number];

/** Quem lê uma conversa entre treinador e atleta sem ser parte dela (supervisão) tem 24 horas. */
export const HORAS_SUPERVISAO = 24;
/** Envio de mensagens por usuário por minuto. */
export const LIMITE_MENSAGENS_POR_MINUTO = 30;
/** Dias de retenção depois da inativação ou da anonimização (job `job:limpar-conversas`). */
export const DIAS_RETENCAO_CONVERSAS = 90;
export const TAMANHO_MAX_MENSAGEM = 2000;

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

/** Parâmetros fixos das consultas deste arquivo: $1 usuário, $2 agora, $3 papel. */
const paramsBase = (u: UsuarioDeAcesso, agora: Date): unknown[] => [u.id, agora, u.papel];

const supervisaoVigenteSql = `exists (select 1 from acessos_supervisao s
                                       where s.conversa_id = c.id and s.gestor_id = $1::uuid
                                         and s.expira_em > $2::timestamptz)`;

/** Conversas em que a pessoa é parte (as do gestor são as `gestao_*`). Vale para listas e contagens. */
function participaSql(papel: string): string {
  switch (papel) {
    case "atleta":
      return `c.tipo in ('treinador_atleta', 'gestao_atleta') and c.atleta_id = (select u.atleta_id from usuarios u where u.id = $1::uuid)`;
    case "treinador":
      return `c.tipo in ('treinador_atleta', 'gestao_treinador') and c.treinador_id = $1::uuid`;
    case "gestor":
      return `c.tipo in ('gestao_atleta', 'gestao_treinador')`;
    default:
      return "false";
  }
}

/** Quem pode abrir a conversa pelo id: as partes, mais o gestor com supervisão vigente. */
function acessoSql(papel: string): string {
  const base = participaSql(papel);
  return papel === "gestor"
    ? `(${base} or (c.tipo = 'treinador_atleta' and ${supervisaoVigenteSql}))`
    : `(${base})`;
}

/**
 * Somente leitura: par antigo (o atleta trocou de treinador), atleta ou treinador desativado, e o
 * gestor lendo por supervisão. Os demais enviam.
 */
const SOMENTE_LEITURA_SQL = `case c.tipo
    when 'treinador_atleta' then ($3::text = 'gestor'
      or a.treinador_id is distinct from c.treinador_id or not a.ativo or not t.ativo)
    when 'gestao_atleta' then not a.ativo
    else not t.ativo end`;

const NAO_LIDAS_SQL = `(select count(*) from mensagens m
                         where m.conversa_id = c.id and m.autor_id <> $1::uuid
                           and m.enviada_em > coalesce(l.lida_ate, '-infinity'::timestamptz))`;

const FROM = `from conversas c
  left join atletas a on a.id = c.atleta_id
  left join usuarios t on t.id = c.treinador_id
  left join leituras_conversa l on l.conversa_id = c.id and l.usuario_id = $1::uuid`;

export interface LinhaConversa {
  id: string;
  tipo: TipoConversa;
  atleta_id: string | null;
  atleta_nome: string | null;
  treinador_id: string | null;
  treinador_nome: string | null;
  criada_em: Date;
  ultima_mensagem_em: Date | null;
  nao_lidas: string;
  somente_leitura: boolean;
  supervisao_ate: Date | null;
}

const COLUNAS = `c.id::text as id, c.tipo, a.id::text as atleta_id, a.nome as atleta_nome,
  t.id::text as treinador_id, t.nome as treinador_nome, c.criada_em, c.ultima_mensagem_em,
  ${NAO_LIDAS_SQL}::text as nao_lidas, (${SOMENTE_LEITURA_SQL}) as somente_leitura,
  (select max(s.expira_em) from acessos_supervisao s
    where s.conversa_id = c.id and s.gestor_id = $1::uuid and s.expira_em > $2::timestamptz) as supervisao_ate`;

const ORDEM = `order by c.ultima_mensagem_em desc nulls last, c.criada_em desc, c.id`;

/** As conversas em que a pessoa é parte. Sem IBVAR (devolve vazio). */
export async function listarConversas(
  db: Db,
  usuario: UsuarioDeAcesso,
  agora: Date,
): Promise<LinhaConversa[]> {
  const r = await db.query<LinhaConversa>(
    `select ${COLUNAS} ${FROM} where ${participaSql(usuario.papel)} ${ORDEM}`,
    paramsBase(usuario, agora),
  );
  return r.rows;
}

/**
 * Só para o gestor: as conversas entre treinador e atleta, só com metadados (participantes e datas).
 * Sem trecho e sem contagem de mensagens: `nao_lidas` sai zerado e a conversa vem como somente leitura.
 */
export async function listarConversasParaSupervisao(
  db: Db,
  gestor: UsuarioDeAcesso,
  agora: Date,
): Promise<LinhaConversa[]> {
  const r = await db.query<LinhaConversa>(
    `select c.id::text as id, c.tipo, a.id::text as atleta_id, a.nome as atleta_nome,
            t.id::text as treinador_id, t.nome as treinador_nome, c.criada_em, c.ultima_mensagem_em,
            '0' as nao_lidas, true as somente_leitura,
            (select max(s.expira_em) from acessos_supervisao s
              where s.conversa_id = c.id and s.gestor_id = $1::uuid and s.expira_em > $2::timestamptz) as supervisao_ate
       from conversas c
       join atletas a on a.id = c.atleta_id
       join usuarios t on t.id = c.treinador_id
      where c.tipo = 'treinador_atleta'
      ${ORDEM}`,
    [gestor.id, agora],
  );
  return r.rows;
}

/** Uma conversa a que a pessoa tem acesso (parte ou supervisão vigente); nulo = não existe ou sem acesso. */
export async function buscarConversaAcessivel(
  db: Db,
  usuario: UsuarioDeAcesso,
  conversaId: string,
  agora: Date,
  opcoes: { travar?: boolean } = {},
): Promise<LinhaConversa | null> {
  const r = await db.query<LinhaConversa>(
    `select ${COLUNAS} ${FROM}
      where c.id = $4::uuid and ${acessoSql(usuario.papel)}
      ${opcoes.travar ? "for share of c" : ""}`,
    [...paramsBase(usuario, agora), conversaId],
  );
  return r.rows[0] ?? null;
}

/** Conversa pelo id, sem checar acesso (só para a rota de supervisão, que checa o papel). */
export async function tipoDaConversa(db: Db, conversaId: string): Promise<TipoConversa | null> {
  const r = await db.query<{ tipo: TipoConversa }>(
    `select tipo from conversas where id = $1::uuid`,
    [conversaId],
  );
  return r.rows[0]?.tipo ?? null;
}

export interface LinhaMensagem {
  id: string;
  texto: string;
  enviada_em: Date;
  autor_id: string;
  autor_nome: string;
  autor_papel: string;
}

export interface FiltroMensagens {
  depoisDe?: Date;
  antesDe?: Date;
  limite: number;
}

/**
 * Mensagens da conversa em ordem cronológica. Sem filtro ou com `antesDe`: as mais recentes (até o
 * limite) antes do instante; `temMaisAntigas` diz se há mais. Com `depoisDe` (polling): só as novas.
 * Quem chama já conferiu o acesso à conversa.
 */
export async function listarMensagens(
  db: Db,
  conversaId: string,
  f: FiltroMensagens,
): Promise<{ linhas: LinhaMensagem[]; temMaisAntigas: boolean }> {
  const params: unknown[] = [conversaId];
  const where = [`m.conversa_id = $1::uuid`];
  if (f.depoisDe) {
    params.push(f.depoisDe);
    where.push(`m.enviada_em > $${params.length}::timestamptz`);
  }
  if (f.antesDe) {
    params.push(f.antesDe);
    where.push(`m.enviada_em < $${params.length}::timestamptz`);
  }
  params.push(f.limite + 1);
  const asc = f.depoisDe !== undefined && f.antesDe === undefined;
  const r = await db.query<LinhaMensagem>(
    `select m.id::text as id, m.texto, m.enviada_em, u.id::text as autor_id, u.nome as autor_nome, u.papel as autor_papel
       from mensagens m join usuarios u on u.id = m.autor_id
      where ${where.join(" and ")}
      order by m.enviada_em ${asc ? "asc" : "desc"}, m.id ${asc ? "asc" : "desc"}
      limit $${params.length}`,
    params,
  );
  const mais = r.rows.length > f.limite;
  const linhas = mais ? r.rows.slice(0, f.limite) : r.rows;
  if (!asc) linhas.reverse();
  return { linhas, temMaisAntigas: !asc && mais };
}

/** Insere a mensagem e atualiza a data da última. Dentro da transação do envio. */
export async function inserirMensagem(
  tx: Db,
  conversaId: string,
  autorId: string,
  texto: string,
  em: Date,
): Promise<string> {
  const r = await tx.query<{ id: string }>(
    `insert into mensagens (conversa_id, autor_id, texto, enviada_em)
     values ($1::uuid, $2::uuid, $3, $4::timestamptz) returning id::text as id`,
    [conversaId, autorId, texto, em],
  );
  await tx.query(
    `update conversas set ultima_mensagem_em = greatest(coalesce(ultima_mensagem_em, $2::timestamptz), $2::timestamptz)
      where id = $1::uuid`,
    [conversaId, em],
  );
  return r.rows[0]!.id;
}

/**
 * Avisa quem recebe a mensagem (`mensagem_nova`, `referencia: { conversaId }`), só se a pessoa ainda não
 * tem um aviso `mensagem_nova` não lido desta conversa (evita enxurrada). Quem escreve nunca se avisa.
 * Destinatários: o outro lado da conversa; na caixa compartilhada, os gestores ativos. Devolve quantos
 * avisos criou. O aviso não cita atleta (`atleta_id` nulo): não depende da visibilidade do atleta.
 */
export async function avisarMensagemNova(
  tx: Db,
  conversa: Pick<LinhaConversa, "id" | "tipo" | "atleta_id" | "treinador_id">,
  autor: { id: string; papel: string },
  em: Date,
): Promise<number> {
  const gestores = `select u.id from usuarios u where u.papel = 'gestor' and u.ativo`;
  const contasDoAtleta = `select u.id from usuarios u where u.papel = 'atleta' and u.ativo and u.atleta_id = $5::uuid`;
  const treinador = `select u.id from usuarios u where u.id = $5::uuid and u.ativo`;
  // Cada fragmento usa no máximo o $5: ou o atleta, ou o treinador, ou ninguém (gestores).
  let destinatarios: string;
  let alvo: string | null = null;
  switch (conversa.tipo) {
    case "treinador_atleta":
      [destinatarios, alvo] =
        autor.papel === "atleta"
          ? [treinador, conversa.treinador_id]
          : [contasDoAtleta, conversa.atleta_id];
      break;
    case "gestao_atleta":
      [destinatarios, alvo] =
        autor.papel === "gestor" ? [contasDoAtleta, conversa.atleta_id] : [gestores, null];
      break;
    default:
      [destinatarios, alvo] =
        autor.papel === "gestor" ? [treinador, conversa.treinador_id] : [gestores, null];
  }
  const r = await tx.query(
    `insert into avisos (destinatario_id, tipo, atleta_id, referencia, criado_por, criado_em)
     select d.id, 'mensagem_nova', null, $2::jsonb, $3::uuid, $4::timestamptz
       from (${destinatarios}) d
      where d.id <> $3::uuid
        and not exists (select 1 from avisos v
                         where v.destinatario_id = d.id and v.tipo = 'mensagem_nova'
                           and v.lido_em is null and v.referencia->>'conversaId' = $1::text)
  returning id`,
    [
      conversa.id,
      JSON.stringify({ conversaId: conversa.id }),
      autor.id,
      em,
      ...(alvo ? [alvo] : []),
    ],
  );
  return r.rows.length;
}

/** Marca a conversa como lida até `em` para a pessoa, e os avisos de mensagem nova dela. */
export async function marcarConversaLida(
  db: Db,
  usuarioId: string,
  conversaId: string,
  em: Date,
): Promise<void> {
  await db.transacao(async (tx) => {
    await tx.query(
      `insert into leituras_conversa (conversa_id, usuario_id, lida_ate)
       values ($1::uuid, $2::uuid, $3::timestamptz)
       on conflict (conversa_id, usuario_id)
       do update set lida_ate = greatest(leituras_conversa.lida_ate, excluded.lida_ate)`,
      [conversaId, usuarioId, em],
    );
    await tx.query(
      `update avisos set lido_em = $3::timestamptz
        where destinatario_id = $1::uuid and tipo = 'mensagem_nova' and lido_em is null
          and referencia->>'conversaId' = $2::text`,
      [usuarioId, conversaId, em],
    );
  });
}

/** Total de mensagens não lidas do usuário, nas conversas em que é parte (balão `conversas`). */
export async function contarConversasNaoLidas(db: Db, usuario: UsuarioDeAcesso): Promise<number> {
  if (usuario.papel === "atleta" && !usuario.atletaId) return 0;
  const r = await db.query<{ n: string }>(
    `select coalesce(sum(${NAO_LIDAS_SQL}), 0)::text as n
       from conversas c
       left join leituras_conversa l on l.conversa_id = c.id and l.usuario_id = $1::uuid
      where ${participaSql(usuario.papel)}`,
    [usuario.id],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Apaga as conversas (e mensagens, leituras, acessos de supervisão e avisos) dos ids. Os gatilhos de
 * só-inserção exigem `scoutvela.limpando_conversas` ou a anonimização do atleta da conversa.
 * Chame dentro de uma transação.
 */
export async function apagarConversas(tx: Db, ids: string[]): Promise<{ mensagens: number }> {
  if (ids.length === 0) return { mensagens: 0 };
  await tx.query(`delete from acessos_supervisao where conversa_id = any($1::uuid[])`, [ids]);
  await tx.query(`delete from leituras_conversa where conversa_id = any($1::uuid[])`, [ids]);
  const m = await tx.query(
    `delete from mensagens where conversa_id = any($1::uuid[]) returning id`,
    [ids],
  );
  await tx.query(
    `delete from avisos where tipo = 'mensagem_nova' and referencia->>'conversaId' = any($1::text[])`,
    [ids],
  );
  await tx.query(`delete from conversas where id = any($1::uuid[])`, [ids]);
  return { mensagens: m.rows.length };
}

/** Anonimização do atleta: apaga na hora as conversas dele (dentro da transação, com `scoutvela.anonimizando`). */
export async function apagarConversasDoAtleta(tx: Db, atletaId: string): Promise<void> {
  const r = await tx.query<{ id: string }>(
    `select id::text as id from conversas where atleta_id = $1::uuid`,
    [atletaId],
  );
  await apagarConversas(
    tx,
    r.rows.map((x) => x.id),
  );
}

import { fonteDaFaixa, type FonteFaixa } from "./parametros.js";
import { termoSql } from "./termo.js";
import { idadeEm } from "../domain/classfit.js";
import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import type {
  Classe,
  Genero,
  NivelCompeticao,
  PerfilSuporte,
  PosicaoClasse,
  StatusGate,
} from "../domain/tipos.js";

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

/** Faixa de altura de referência da classe (informativa, nula se não definida). */
export interface ClasseAltura {
  alturaMinCm: number | null;
  alturaMediaCm: number | null;
  alturaMaxCm: number | null;
  /** De onde vem a faixa de peso da classe (D18); nula se não informada. */
  fonte: FonteFaixa | null;
}

/** Atleta com o que o cadastro, a classe e o treinador respondem. */
export interface AtletaBase {
  id: string;
  /** ID World Sailing normalizado: a chave do atleta. */
  wsId: string;
  /** Código VelaID; nulo se o atleta não tem (opcional). */
  velaid: string | null;
  nome: string;
  genero: Genero;
  /** AAAA-MM-DD. */
  dataNascimento: string;
  classe: Classe & ClasseAltura;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  numeroVela: string | null;
  emailContato: string | null;
  treinador: { id: string; nome: string } | null;
  termoAceito: boolean;
}

export interface NotaAtual {
  indicadorId: string;
  valor: number;
  evidencia: string | null;
  link: string | null;
  origem: "avaliacao" | "resposta_confirmada" | "autoavaliacao_aprovada";
  /** Justificativa do treinador ao corrigir a sugestão do atleta; nula se não houve. */
  justificativa: string | null;
  avaliador: { id: string; nome: string } | null;
  lancadoEm: string;
  anexo: { id: string; nomeArquivo: string } | null;
}

export interface MedidaAtual {
  pesoKg: number | null;
  alturaCm: number | null;
  /** Da última medida com peso. */
  pesoMedidoEm: string | null;
  pesoEvidencia: string | null;
  pesoRegistradoPor: { id: string; nome: string } | null;
}

export type StatusResultado = "validado" | "pendente" | "recusado";

export interface ResultadoDoAtleta {
  id: string;
  data: string;
  nivel: NivelCompeticao;
  evento: string;
  /** Ano da edição (o ano da data nos resultados anteriores à D10). */
  edicao: number;
  posicao: number;
  /** Nulo quando o atleta informou o resultado sem a frota. */
  tamanhoFrota: number | null;
  internacional: boolean;
  pontosCbvela: number | null;
  fonte: "ranking_cbvela" | "manual" | "atleta";
  linkOficial: string | null;
  /** Só o resultado do atleta passa por validação; os demais valem direto (`validado`). */
  status: StatusResultado;
  /** Motivo da recusa. */
  motivo: string | null;
  validadoPor: { id: string; nome: string } | null;
  validadoEm: string | null;
  /** Súmula anexada pelo atleta; nula se removida ou sem anexo. */
  anexo: { id: string; nomeArquivo: string } | null;
  registradoEm: string;
}

export interface FinanceiroAtual {
  perfilSuporte: PerfilSuporte;
  mesesAssegurados: number | null;
  patrocinioPrivado: "sim" | "em_negociacao" | "nao" | null;
  /** Preenchido só quando a carga pede `componentesFinanceiro`. */
  componentes: { id: string; nome: string; autonomia: string; apoioCbvela: string }[];
}

/** Tudo o que se carrega por atleta para o cálculo e para a ficha. */
export interface DadosAtleta {
  notas: NotaAtual[];
  respostas: Record<string, string>;
  sugestoesPendentes: Record<string, { valor: number; lancadoEm: string }>;
  medida: MedidaAtual;
  /** Mais recente primeiro. */
  resultados: ResultadoDoAtleta[];
  /** Índice 0 = G1. Nulo = vale a sugestão automática. */
  decisoesGates: (StatusGate | null)[];
  financeiro: FinanceiroAtual | null;
  /** Ciclos fechados, mais antigo primeiro (só com `historico`). */
  historicoScore: { ciclo: string; score: number }[];
}

export interface OpcoesCarga {
  /** Inclui os componentes do financeiro (só a ficha usa). */
  componentesFinanceiro?: boolean;
  /** Inclui o histórico de score dos ciclos fechados. */
  historico?: boolean;
  /**
   * Só os resultados validados, sem motivo, anexo nem quem validou (visão do IBVAR). O cálculo usa
   * sempre só os validados; isto restringe também o que a ficha lista.
   */
  resultadosParaIbvar?: boolean;
}

/**
 * WHERE da matriz de acesso ("Score, pilares e gates"). Os parâmetros são posicionais,
 * a partir de `proximoIndiceParam`. Atleta sem consentimento nunca sai do banco para o IBVAR.
 */
export function filtroVisibilidade(
  usuario: UsuarioDeAcesso,
  alias: string,
  proximoIndiceParam: number,
): { sql: string; params: unknown[] } {
  const n = proximoIndiceParam;
  switch (usuario.papel) {
    case "gestor":
      return { sql: "true", params: [] };
    case "treinador":
      return { sql: `${alias}.treinador_id = $${n}::uuid`, params: [usuario.id] };
    case "atleta":
      if (!usuario.atletaId) return { sql: "false", params: [] };
      return { sql: `${alias}.id = $${n}::uuid`, params: [usuario.atletaId] };
    case "ibvar":
      return {
        sql: `exists (select 1 from consentimento_atual ci
                       where ci.atleta_id = ${alias}.id and ci.tipo = 'compartilhar_ibvar' and ci.concedido)`,
        params: [],
      };
    default:
      return { sql: "false", params: [] };
  }
}

interface LinhaBase {
  id: string;
  ws_id: string;
  velaid_codigo: string | null;
  nome: string;
  genero: Genero;
  data_nascimento: string;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  numero_vela: string | null;
  email_contato: string | null;
  treinador_id: string | null;
  treinador_nome: string | null;
  termo_aceito: boolean;
  classe_id: string;
  classe_nome: string;
  classe_evento: string;
  classe_posicao: PosicaoClasse;
  peso_min_kg: string;
  peso_medio_kg: string;
  peso_max_kg: string;
  altura_min_cm: string | null;
  altura_media_cm: string | null;
  altura_max_cm: string | null;
  faixa_fonte_documento: string | null;
  faixa_fonte_versao: string | null;
  faixa_fonte_data: string | null;
}

export interface FiltrosListagem {
  /** Instante de referência (`app.agora()`): decide qual termo é o vigente. */
  agora: Date;
  /** Só atletas com o termo do piloto aceito (ranking e listas do piloto; segue TERMO_EXIGE_REACEITE). */
  somenteTermoAceito?: boolean;
  /** Evento da classe (ex.: "ILCA 7"). */
  classeEvento?: string;
  genero?: Genero;
  /** Restringe a um atleta. */
  atletaId?: string;
}

/**
 * Atleta com o cadastro completado (nome, gênero e nascimento informados). Quem ainda não completou
 * fica fora do ranking, do score, das pendências, do fechamento de ciclo, dos lembretes e do investimento.
 */
export const cadastroCompletoSql = (alias: string) => `${alias}.cadastro_completo_em is not null`;

/** Atletas ativos, com o cadastro completo, que o usuário pode ver, em ordem alfabética. */
export async function listarAtletasVisiveis(
  db: Db,
  usuario: UsuarioDeAcesso,
  filtros: FiltrosListagem,
): Promise<AtletaBase[]> {
  const vis = filtroVisibilidade(usuario, "a", 1);
  const params: unknown[] = [...vis.params];
  const condicoes = ["a.ativo", cadastroCompletoSql("a"), `(${vis.sql})`];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const termoAceito = termoSql.aceitoNoPiloto("a.id", param(filtros.agora));
  // IBVAR segue a regra do ranking em toda leitura (ficha, histórico): fora do piloto, 404.
  if (filtros.somenteTermoAceito || usuario.papel === "ibvar") condicoes.push(termoAceito);
  if (filtros.classeEvento) condicoes.push(`c.evento = ${param(filtros.classeEvento)}`);
  if (filtros.genero) condicoes.push(`a.genero = ${param(filtros.genero)}`);
  if (filtros.atletaId) condicoes.push(`a.id = ${param(filtros.atletaId)}::uuid`);

  const r = await db.query<LinhaBase>(
    `select a.id, a.ws_id, a.velaid_codigo, a.nome, a.genero, a.data_nascimento::text as data_nascimento,
            a.clube, a.cidade, a.uf, a.numero_vela, a.email_contato,
            a.treinador_id, t.nome as treinador_nome,
            ${termoAceito} as termo_aceito,
            c.id as classe_id, c.nome as classe_nome, c.evento as classe_evento, c.posicao as classe_posicao,
            c.peso_min_kg, c.peso_medio_kg, c.peso_max_kg,
            c.altura_min_cm, c.altura_media_cm, c.altura_max_cm,
            c.faixa_fonte_documento, c.faixa_fonte_versao, c.faixa_fonte_data::text as faixa_fonte_data
       from atletas a
       join classes c on c.id = a.classe_id
       left join usuarios t on t.id = a.treinador_id
      where ${condicoes.join(" and ")}
      order by a.nome, a.id`,
    params,
  );
  return r.rows.map((l) => ({
    id: l.id,
    wsId: l.ws_id,
    velaid: l.velaid_codigo,
    nome: l.nome,
    genero: l.genero,
    dataNascimento: l.data_nascimento,
    classe: {
      id: l.classe_id,
      nome: l.classe_nome,
      evento: l.classe_evento,
      posicao: l.classe_posicao,
      pesoMinKg: Number(l.peso_min_kg),
      pesoMedioKg: Number(l.peso_medio_kg),
      pesoMaxKg: Number(l.peso_max_kg),
      alturaMinCm: l.altura_min_cm === null ? null : Number(l.altura_min_cm),
      alturaMediaCm: l.altura_media_cm === null ? null : Number(l.altura_media_cm),
      alturaMaxCm: l.altura_max_cm === null ? null : Number(l.altura_max_cm),
      fonte: fonteDaFaixa(l),
    },
    clube: l.clube,
    cidade: l.cidade,
    uf: l.uf,
    numeroVela: l.numero_vela,
    emailContato: l.email_contato,
    treinador: l.treinador_id ? { id: l.treinador_id, nome: l.treinador_nome ?? "" } : null,
    termoAceito: l.termo_aceito,
  }));
}

/** Um atleta ativo e com cadastro completo, se o usuário puder vê-lo (senão nulo, sem distinguir de inexistente). */
export async function buscarAtletaVisivel(
  db: Db,
  usuario: UsuarioDeAcesso,
  id: string,
  agora: Date,
): Promise<AtletaBase | null> {
  const lista = await listarAtletasVisiveis(db, usuario, { atletaId: id, agora });
  return lista[0] ?? null;
}

/** Atletas ativos do piloto (termo aceito) sem consentimento de compartilhamento com o IBVAR. */
export async function contarSemConsentimentoIbvar(db: Db, agora: Date): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*)::text as n
       from atletas a
      where a.ativo and ${cadastroCompletoSql("a")} and ${termoSql.aceitoNoPiloto("a.id", "$1")}
        and not exists (select 1 from consentimento_atual ci
                         where ci.atleta_id = a.id and ci.tipo = 'compartilhar_ibvar' and ci.concedido)`,
    [agora],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/** Linha da lista de gestão (GET /atletas): sem dado sensível nem e-mail. */
export interface AtletaGestao {
  id: string;
  /** Nulo enquanto o cadastro está incompleto. */
  nome: string | null;
  wsId: string;
  velaid: string | null;
  classe: { id: string; nome: string };
  treinador: { id: string; nome: string } | null;
  numeroVela: string | null;
  /** Calculada no servidor; nula com o cadastro incompleto. A data de nascimento não sai na lista. */
  idade: number | null;
  ativo: boolean;
  termoAceito: boolean;
  cadastroCompleto: boolean;
  /** Menor de 18 anos no primeiro acesso: inativado, aguarda a anonimização. */
  cadastroRecusado: boolean;
  /** Já existe conta (usuário de papel atleta) ligada a este atleta. */
  contaVinculada: boolean;
}

export interface FiltrosGestao {
  agora: Date;
  ativo?: boolean | undefined;
  termoAceito?: boolean | undefined;
  cadastroCompleto?: boolean | undefined;
  classeId?: string | undefined;
  treinadorId?: string | undefined;
  /** Parte do nome, do ID World Sailing ou do código VelaID, sem diferenciar maiúsculas. */
  busca?: string | undefined;
}

const escaparLike = (texto: string) => texto.replace(/[\\%_]/g, (c) => `\\${c}`);

/**
 * Todos os atletas do piloto para o gestor, inclusive inativos e sem o termo aceito.
 * Termo aceito segue a mesma regra do ranking (TERMO_EXIGE_REACEITE).
 */
export async function listarAtletasGestao(db: Db, filtros: FiltrosGestao): Promise<AtletaGestao[]> {
  const params: unknown[] = [];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  const termoAceito = termoSql.aceitoNoPiloto("a.id", param(filtros.agora));
  const condicoes: string[] = [];
  if (filtros.ativo !== undefined) condicoes.push(`a.ativo = ${param(filtros.ativo)}`);
  if (filtros.termoAceito !== undefined) {
    condicoes.push(filtros.termoAceito ? termoAceito : `not ${termoAceito}`);
  }
  if (filtros.cadastroCompleto !== undefined) {
    condicoes.push(
      filtros.cadastroCompleto ? cadastroCompletoSql("a") : `not ${cadastroCompletoSql("a")}`,
    );
  }
  if (filtros.classeId) condicoes.push(`a.classe_id = ${param(filtros.classeId)}`);
  if (filtros.treinadorId) condicoes.push(`a.treinador_id = ${param(filtros.treinadorId)}::uuid`);
  const busca = filtros.busca?.trim();
  if (busca) {
    const p = param(`%${escaparLike(busca)}%`);
    condicoes.push(
      `(a.nome ilike ${p} escape '\\' or a.ws_id ilike ${p} escape '\\' or a.velaid_codigo ilike ${p} escape '\\')`,
    );
  }

  const r = await db.query<{
    id: string;
    nome: string | null;
    ws_id: string;
    velaid_codigo: string | null;
    classe_id: string;
    classe_nome: string;
    treinador_id: string | null;
    treinador_nome: string | null;
    numero_vela: string | null;
    data_nascimento: string | null;
    ativo: boolean;
    termo_aceito: boolean;
    cadastro_completo: boolean;
    cadastro_recusado: boolean;
    conta_vinculada: boolean;
  }>(
    `select a.id, a.nome, a.ws_id, a.velaid_codigo, c.id as classe_id, c.nome as classe_nome,
            a.treinador_id, t.nome as treinador_nome, a.numero_vela,
            a.data_nascimento::text as data_nascimento, a.ativo,
            ${termoAceito} as termo_aceito,
            ${cadastroCompletoSql("a")} as cadastro_completo,
            (a.cadastro_recusado_em is not null) as cadastro_recusado,
            exists (select 1 from usuarios u where u.atleta_id = a.id) as conta_vinculada
       from atletas a
       join classes c on c.id = a.classe_id
       left join usuarios t on t.id = a.treinador_id
      ${condicoes.length ? `where ${condicoes.join(" and ")}` : ""}
      order by a.nome nulls last, a.ws_id, a.id`,
    params,
  );
  return r.rows.map((l) => ({
    id: l.id,
    nome: l.nome,
    wsId: l.ws_id,
    velaid: l.velaid_codigo,
    classe: { id: l.classe_id, nome: l.classe_nome },
    treinador: l.treinador_id ? { id: l.treinador_id, nome: l.treinador_nome ?? "" } : null,
    numeroVela: l.numero_vela,
    idade:
      l.cadastro_completo && l.data_nascimento ? idadeEm(l.data_nascimento, filtros.agora) : null,
    ativo: l.ativo,
    termoAceito: l.termo_aceito,
    cadastroCompleto: l.cadastro_completo,
    cadastroRecusado: l.cadastro_recusado,
    contaVinculada: l.conta_vinculada,
  }));
}

export async function cicloAberto(db: Db): Promise<{ nome: string; prazo: string } | null> {
  const r = await db.query<{ nome: string; prazo: string }>(
    `select nome, prazo::text as prazo from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  return r.rows[0] ?? null;
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/** Situação do resultado: o do atleta vale a validação mais recente (sem validação, pendente); os demais já valem. */
export const SQL_STATUS_RESULTADO = `case when r.fonte = 'atleta' then coalesce(v.status, 'pendente') else 'validado' end`;
/** Ano da edição: o informado ou, nos resultados antigos, o ano da data. */
export const SQL_EDICAO_RESULTADO = `coalesce(r.edicao, extract(year from r.data))::int`;

export interface LinhaResultado {
  id: string;
  atleta_id: string;
  data: string;
  nivel: NivelCompeticao;
  evento: string;
  edicao: number;
  posicao: number;
  tamanho_frota: number | null;
  internacional: boolean;
  pontos_cbvela: string | null;
  fonte: ResultadoDoAtleta["fonte"];
  link_oficial: string | null;
  status: StatusResultado;
  motivo: string | null;
  validado_por: string | null;
  validador_nome: string | null;
  validado_em: Date | null;
  anexo_id: string | null;
  anexo_nome: string | null;
  registrado_em: Date;
}

export const COLUNAS_RESULTADO = `r.id::text as id, r.atleta_id, r.data::text as data, r.nivel, r.evento,
       ${SQL_EDICAO_RESULTADO} as edicao, r.posicao, r.tamanho_frota, r.internacional, r.pontos_cbvela,
       r.fonte, r.link_oficial, ${SQL_STATUS_RESULTADO} as status, v.motivo,
       v.validado_por::text as validado_por, u.nome as validador_nome, v.validado_em,
       case when ea.removido_em is null then r.anexo_id::text end as anexo_id,
       case when ea.removido_em is null then ea.nome_arquivo end as anexo_nome, r.registrado_em`;

export const ORIGEM_RESULTADO = `resultados_regata r
       left join validacao_resultado_atual v on v.resultado_id = r.id
       left join usuarios u on u.id = v.validado_por
       left join evidencias_anexos ea on ea.id = r.anexo_id`;

/** `semDetalhe`: visão do IBVAR (sem motivo, anexo nem quem validou). */
export function paraResultado(l: LinhaResultado, semDetalhe = false): ResultadoDoAtleta {
  return {
    id: l.id,
    data: l.data,
    nivel: l.nivel,
    evento: l.evento,
    edicao: l.edicao,
    posicao: l.posicao,
    tamanhoFrota: l.tamanho_frota,
    internacional: l.internacional,
    pontosCbvela: l.pontos_cbvela === null ? null : Number(l.pontos_cbvela),
    fonte: l.fonte,
    linkOficial: l.link_oficial,
    status: l.status,
    motivo: semDetalhe ? null : l.motivo,
    validadoPor:
      semDetalhe || !l.validado_por ? null : { id: l.validado_por, nome: l.validador_nome ?? "" },
    validadoEm: semDetalhe || !l.validado_em ? null : iso(l.validado_em),
    anexo: semDetalhe || !l.anexo_id ? null : { id: l.anexo_id, nomeArquivo: l.anexo_nome ?? "" },
    registradoEm: iso(l.registrado_em),
  };
}

/** Um resultado pelo id, como o gestor o vê (a rota já conferiu o acesso). */
export async function lerResultado(db: Db, id: string): Promise<ResultadoDoAtleta> {
  const r = await db.query<LinhaResultado>(
    `select ${COLUNAS_RESULTADO} from ${ORIGEM_RESULTADO} where r.id = $1::bigint`,
    [id],
  );
  return paraResultado(r.rows[0]!);
}

/**
 * Carrega, numa ida por tabela, tudo o que o cálculo (e a ficha) precisa para o conjunto de atletas.
 * Os ids devem vir de `listarAtletasVisiveis`/`buscarAtletaVisivel` (filtro de acesso já aplicado).
 */
export async function carregarDadosAtletas(
  db: Db,
  atletaIds: string[],
  opcoes: OpcoesCarga = {},
): Promise<Map<string, DadosAtleta>> {
  const mapa = new Map<string, DadosAtleta>();
  for (const id of atletaIds) {
    mapa.set(id, {
      notas: [],
      respostas: {},
      sugestoesPendentes: {},
      medida: {
        pesoKg: null,
        alturaCm: null,
        pesoMedidoEm: null,
        pesoEvidencia: null,
        pesoRegistradoPor: null,
      },
      resultados: [],
      decisoesGates: [null, null, null, null],
      financeiro: null,
      historicoScore: [],
    });
  }
  if (atletaIds.length === 0) return mapa;
  const p = [atletaIds];

  const [notas, respostas, sugestoes, medidas, resultados, decisoes, financeiro] =
    await Promise.all([
      db.query<{
        atleta_id: string;
        indicador_id: string;
        valor: number;
        evidencia: string | null;
        link: string | null;
        origem: NotaAtual["origem"];
        justificativa: string | null;
        avaliador_id: string | null;
        avaliador_nome: string | null;
        lancado_em: Date;
        anexo_id: string | null;
        anexo_nome: string | null;
      }>(
        `select n.atleta_id, n.indicador_id, n.valor, n.evidencia, n.link, n.origem, n.justificativa, n.avaliador_id,
              u.nome as avaliador_nome, n.lancado_em, n.anexo_id, ea.nome_arquivo as anexo_nome
         from avaliacao_atual n
         left join usuarios u on u.id = n.avaliador_id
         left join evidencias_anexos ea on ea.id = n.anexo_id
        where n.atleta_id = any($1::uuid[])`,
        p,
      ),
      db.query<{ atleta_id: string; indicador_id: string; resposta: string }>(
        `select atleta_id, indicador_id, resposta from resposta_atual where atleta_id = any($1::uuid[])`,
        p,
      ),
      db.query<{ atleta_id: string; indicador_id: string; valor: number; lancado_em: Date }>(
        `select atleta_id, indicador_id, valor, lancado_em from sugestao_pendente where atleta_id = any($1::uuid[])`,
        p,
      ),
      db.query<{
        atleta_id: string;
        peso_kg: string | null;
        altura_cm: string | null;
        medido_em: Date;
        evidencia: string;
        registrado_por: string;
        registrador_nome: string;
      }>(
        `select m.atleta_id, m.peso_kg, m.altura_cm, m.medido_em, m.evidencia, m.registrado_por,
              u.nome as registrador_nome
         from medidas_corporais m join usuarios u on u.id = m.registrado_por
        where m.atleta_id = any($1::uuid[])
        order by m.medido_em desc, m.id desc`,
        p,
      ),
      db.query<LinhaResultado>(
        `select ${COLUNAS_RESULTADO}
           from ${ORIGEM_RESULTADO}
          where r.atleta_id = any($1::uuid[])
            ${opcoes.resultadosParaIbvar ? `and ${SQL_STATUS_RESULTADO} = 'validado'` : ""}
          order by r.data desc, r.id desc`,
        p,
      ),
      db.query<{ atleta_id: string; gate: number; status: StatusGate | null }>(
        `select atleta_id, gate, status from gate_decisao_atual where atleta_id = any($1::uuid[])`,
        p,
      ),
      db.query<{
        id: string;
        atleta_id: string;
        perfil_suporte: PerfilSuporte;
        meses_assegurados: number | null;
        patrocinio_privado: "sim" | "em_negociacao" | "nao" | null;
      }>(
        `select id, atleta_id, perfil_suporte, meses_assegurados, patrocinio_privado
         from financeiro_atual where atleta_id = any($1::uuid[])`,
        p,
      ),
    ]);

  const dado = (id: string): DadosAtleta => mapa.get(id)!;

  for (const l of notas.rows) {
    dado(l.atleta_id).notas.push({
      indicadorId: l.indicador_id,
      valor: l.valor,
      evidencia: l.evidencia,
      link: l.link,
      origem: l.origem,
      justificativa: l.justificativa,
      avaliador: l.avaliador_id ? { id: l.avaliador_id, nome: l.avaliador_nome ?? "" } : null,
      lancadoEm: iso(l.lancado_em),
      anexo: l.anexo_id ? { id: l.anexo_id, nomeArquivo: l.anexo_nome ?? "" } : null,
    });
  }
  for (const l of respostas.rows) dado(l.atleta_id).respostas[l.indicador_id] = l.resposta;
  for (const l of sugestoes.rows) {
    dado(l.atleta_id).sugestoesPendentes[l.indicador_id] = {
      valor: l.valor,
      lancadoEm: iso(l.lancado_em),
    };
  }

  // Medidas vêm da mais recente para a mais antiga: vale a primeira com peso e a primeira com altura.
  for (const l of medidas.rows) {
    const m = dado(l.atleta_id).medida;
    if (m.pesoKg === null && l.peso_kg !== null) {
      m.pesoKg = Number(l.peso_kg);
      m.pesoMedidoEm = iso(l.medido_em);
      m.pesoEvidencia = l.evidencia;
      m.pesoRegistradoPor = { id: l.registrado_por, nome: l.registrador_nome };
    }
    if (m.alturaCm === null && l.altura_cm !== null) m.alturaCm = Number(l.altura_cm);
  }

  for (const l of resultados.rows) {
    dado(l.atleta_id).resultados.push(paraResultado(l, opcoes.resultadosParaIbvar === true));
  }
  for (const l of decisoes.rows) dado(l.atleta_id).decisoesGates[l.gate - 1] = l.status;

  const finIds: string[] = [];
  for (const l of financeiro.rows) {
    dado(l.atleta_id).financeiro = {
      perfilSuporte: l.perfil_suporte,
      mesesAssegurados: l.meses_assegurados,
      patrocinioPrivado: l.patrocinio_privado,
      componentes: [],
    };
    finIds.push(String(l.id));
  }

  if (opcoes.componentesFinanceiro && finIds.length > 0) {
    const comp = await db.query<{
      atleta_id: string;
      id: string;
      nome: string;
      autonomia: string;
      apoio_cbvela: string;
    }>(
      `select f.atleta_id, c.id, c.nome, fc.autonomia, fc.apoio_cbvela
         from financeiro_componentes fc
         join financeiro_campanha f on f.id = fc.financeiro_id
         join componentes_custo c on c.id = fc.componente_id
        where fc.financeiro_id = any($1::bigint[])
        order by c.ordem`,
      [finIds],
    );
    for (const l of comp.rows) {
      dado(l.atleta_id).financeiro?.componentes.push({
        id: l.id,
        nome: l.nome,
        autonomia: l.autonomia,
        apoioCbvela: l.apoio_cbvela,
      });
    }
  }

  if (opcoes.historico) {
    const h = await db.query<{ atleta_id: string; ciclo: string; score: string }>(
      `select s.atleta_id, c.nome as ciclo, s.score
         from scores_ciclo s join ciclos_avaliacao c on c.id = s.ciclo_id
        where s.atleta_id = any($1::uuid[]) and c.status = 'fechado'
        order by c.inicio, c.id`,
      p,
    );
    for (const l of h.rows)
      dado(l.atleta_id).historicoScore.push({ ciclo: l.ciclo, score: Number(l.score) });
  }

  return mapa;
}

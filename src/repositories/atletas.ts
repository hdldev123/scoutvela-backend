import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import type { Classe, Genero, NivelCompeticao, PerfilSuporte, PosicaoClasse, StatusGate } from "../domain/tipos.js";

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

/** Atleta com o que o cadastro, a classe e o treinador respondem. */
export interface AtletaBase {
  id: string;
  velaid: string;
  nome: string;
  genero: Genero;
  /** AAAA-MM-DD. */
  dataNascimento: string;
  classe: Classe;
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
  evidencia: string;
  origem: "avaliacao" | "resposta_confirmada";
  avaliador: { id: string; nome: string } | null;
  lancadoEm: string;
}

export interface MedidaAtual {
  pesoKg: number | null;
  alturaCm: number | null;
  /** Da última medida com peso. */
  pesoMedidoEm: string | null;
  pesoEvidencia: string | null;
  pesoRegistradoPor: { id: string; nome: string } | null;
}

export interface ResultadoDoAtleta {
  data: string;
  nivel: NivelCompeticao;
  evento: string;
  posicao: number;
  tamanhoFrota: number;
  internacional: boolean;
  pontosCbvela: number | null;
  fonte: "ranking_cbvela" | "manual";
  linkOficial: string | null;
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
}

const TERMO_ACEITO_SQL = `exists (select 1 from consentimento_atual ct
                                   where ct.atleta_id = a.id and ct.tipo = 'termo_piloto' and ct.concedido)`;

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
  velaid_codigo: string;
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
}

export interface FiltrosListagem {
  /** Só atletas com o termo do piloto aceito (ranking e listas do piloto). */
  somenteTermoAceito?: boolean;
  /** Evento da classe (ex.: "ILCA 7"). */
  classeEvento?: string;
  genero?: Genero;
  /** Restringe a um atleta. */
  atletaId?: string;
}

/** Atletas ativos que o usuário pode ver, em ordem alfabética. */
export async function listarAtletasVisiveis(
  db: Db,
  usuario: UsuarioDeAcesso,
  filtros: FiltrosListagem = {},
): Promise<AtletaBase[]> {
  const vis = filtroVisibilidade(usuario, "a", 1);
  const params: unknown[] = [...vis.params];
  const condicoes = ["a.ativo", `(${vis.sql})`];
  const param = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (filtros.somenteTermoAceito) condicoes.push(TERMO_ACEITO_SQL);
  if (filtros.classeEvento) condicoes.push(`c.evento = ${param(filtros.classeEvento)}`);
  if (filtros.genero) condicoes.push(`a.genero = ${param(filtros.genero)}`);
  if (filtros.atletaId) condicoes.push(`a.id = ${param(filtros.atletaId)}::uuid`);

  const r = await db.query<LinhaBase>(
    `select a.id, a.velaid_codigo, a.nome, a.genero, a.data_nascimento::text as data_nascimento,
            a.clube, a.cidade, a.uf, a.numero_vela, a.email_contato,
            a.treinador_id, t.nome as treinador_nome,
            ${TERMO_ACEITO_SQL} as termo_aceito,
            c.id as classe_id, c.nome as classe_nome, c.evento as classe_evento, c.posicao as classe_posicao,
            c.peso_min_kg, c.peso_medio_kg, c.peso_max_kg
       from atletas a
       join classes c on c.id = a.classe_id
       left join usuarios t on t.id = a.treinador_id
      where ${condicoes.join(" and ")}
      order by a.nome, a.id`,
    params,
  );
  return r.rows.map((l) => ({
    id: l.id,
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

/** Um atleta ativo, se o usuário puder vê-lo (senão nulo, sem distinguir de inexistente). */
export async function buscarAtletaVisivel(db: Db, usuario: UsuarioDeAcesso, id: string): Promise<AtletaBase | null> {
  const lista = await listarAtletasVisiveis(db, usuario, { atletaId: id });
  return lista[0] ?? null;
}

/** Atletas ativos do piloto (termo aceito) sem consentimento de compartilhamento com o IBVAR. */
export async function contarSemConsentimentoIbvar(db: Db): Promise<number> {
  const r = await db.query<{ n: string }>(
    `select count(*)::text as n
       from atletas a
      where a.ativo and ${TERMO_ACEITO_SQL}
        and not exists (select 1 from consentimento_atual ci
                         where ci.atleta_id = a.id and ci.tipo = 'compartilhar_ibvar' and ci.concedido)`,
  );
  return Number(r.rows[0]?.n ?? 0);
}

export async function cicloAberto(db: Db): Promise<{ nome: string; prazo: string } | null> {
  const r = await db.query<{ nome: string; prazo: string }>(
    `select nome, prazo::text as prazo from ciclos_avaliacao where status = 'aberto' limit 1`,
  );
  return r.rows[0] ?? null;
}

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

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
      medida: { pesoKg: null, alturaCm: null, pesoMedidoEm: null, pesoEvidencia: null, pesoRegistradoPor: null },
      resultados: [],
      decisoesGates: [null, null, null, null],
      financeiro: null,
      historicoScore: [],
    });
  }
  if (atletaIds.length === 0) return mapa;
  const p = [atletaIds];

  const [notas, respostas, sugestoes, medidas, resultados, decisoes, financeiro] = await Promise.all([
    db.query<{
      atleta_id: string;
      indicador_id: string;
      valor: number;
      evidencia: string;
      origem: "avaliacao" | "resposta_confirmada";
      avaliador_id: string | null;
      avaliador_nome: string | null;
      lancado_em: Date;
    }>(
      `select n.atleta_id, n.indicador_id, n.valor, n.evidencia, n.origem, n.avaliador_id,
              u.nome as avaliador_nome, n.lancado_em
         from avaliacao_atual n left join usuarios u on u.id = n.avaliador_id
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
    db.query<{
      atleta_id: string;
      data: string;
      nivel: NivelCompeticao;
      evento: string;
      posicao: number;
      tamanho_frota: number;
      internacional: boolean;
      pontos_cbvela: string | null;
      fonte: "ranking_cbvela" | "manual";
      link_oficial: string | null;
    }>(
      `select atleta_id, data::text as data, nivel, evento, posicao, tamanho_frota, internacional,
              pontos_cbvela, fonte, link_oficial
         from resultados_regata where atleta_id = any($1::uuid[]) order by data desc, id desc`,
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
      origem: l.origem,
      avaliador: l.avaliador_id ? { id: l.avaliador_id, nome: l.avaliador_nome ?? "" } : null,
      lancadoEm: iso(l.lancado_em),
    });
  }
  for (const l of respostas.rows) dado(l.atleta_id).respostas[l.indicador_id] = l.resposta;
  for (const l of sugestoes.rows) {
    dado(l.atleta_id).sugestoesPendentes[l.indicador_id] = { valor: l.valor, lancadoEm: iso(l.lancado_em) };
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
    dado(l.atleta_id).resultados.push({
      data: l.data,
      nivel: l.nivel,
      evento: l.evento,
      posicao: l.posicao,
      tamanhoFrota: l.tamanho_frota,
      internacional: l.internacional,
      pontosCbvela: l.pontos_cbvela === null ? null : Number(l.pontos_cbvela),
      fonte: l.fonte,
      linkOficial: l.link_oficial,
    });
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
    const comp = await db.query<{ atleta_id: string; id: string; nome: string; autonomia: string; apoio_cbvela: string }>(
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
    for (const l of h.rows) dado(l.atleta_id).historicoScore.push({ ciclo: l.ciclo, score: Number(l.score) });
  }

  return mapa;
}

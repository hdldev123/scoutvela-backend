import type { Db } from "../db/db.js";
import { CODIGOS_REGRAS, ESQUEMAS_REGRAS, type CodigoRegra } from "./regras-esquemas.js";
import type {
  Classe,
  FaixaScore,
  Parametros,
  Pilar,
  Regras,
  StatusGate,
  TipoIndicador,
} from "../domain/tipos.js";

type ValorRegra = Record<string, unknown>;

function numero(v: unknown, regra: string, campo: string): number {
  const n = Number(v);
  if (v === null || v === undefined || Number.isNaN(n)) {
    throw new Error(`Regra ${regra} sem o campo numérico "${campo}"`);
  }
  return n;
}

/** Converte as regras do banco (jsonb em snake_case) para o tipo Regras (camelCase). */
export function regrasDoBanco(linhas: { codigo: string; valor: ValorRegra }[]): Regras {
  const porCodigo = new Map(linhas.map((l) => [l.codigo, l.valor]));
  const pegar = (codigo: string): ValorRegra => {
    const v = porCodigo.get(codigo);
    if (!v) throw new Error(`Regra ${codigo} não encontrada na tabela regras`);
    return v;
  };

  const p3 = pegar("P3");
  const g1 = pegar("G1");
  const g2 = pegar("G2");
  const g3 = pegar("G3");
  const g4 = pegar("G4") as Record<string, { status: StatusGate; motivo: string }>;
  const rk = pegar("RANKING_CBVELA");
  const perfil = (p: "A" | "B" | "C" | "D") => {
    const x = g4[p];
    if (!x) throw new Error(`Regra G4 sem o perfil ${p}`);
    return { status: x.status, motivo: x.motivo };
  };

  return {
    p3: { limites: (p3.limites as unknown[]).map((n) => numero(n, "P3", "limites")) },
    g1: {
      aptoAte: numero(g1.apto_ate, "G1", "apto_ate"),
      condicionalAte: numero(g1.condicional_ate, "G1", "condicional_ate"),
    },
    g2: {
      mundialAptoAteFracao: numero(g2.mundial_apto_ate_fracao, "G2", "mundial_apto_ate_fracao"),
      sulAmericanoCondicionalAtePosicao: numero(
        g2.sul_americano_condicional_ate_posicao,
        "G2",
        "sul_americano_condicional_ate_posicao",
      ),
      mundialCondicionalAteFracao: numero(
        g2.mundial_condicional_ate_fracao,
        "G2",
        "mundial_condicional_ate_fracao",
      ),
      brasileiroCondicionalAtePosicao: numero(
        g2.brasileiro_condicional_ate_posicao,
        "G2",
        "brasileiro_condicional_ate_posicao",
      ),
    },
    g3: {
      aptoMinEventos: numero(g3.apto_min_eventos, "G3", "apto_min_eventos"),
      condicionalMinEventos: numero(g3.condicional_min_eventos, "G3", "condicional_min_eventos"),
      janelaMeses: numero(g3.janela_meses, "G3", "janela_meses"),
    },
    g4: { A: perfil("A"), B: perfil("B"), C: perfil("C"), D: perfil("D") },
    rankingCbvela: { janelaSemanas: numero(rk.janela_semanas, "RANKING_CBVELA", "janela_semanas") },
    perfPontos: perfPontosDoBanco(porCodigo.get("PERF_PONTOS")),
  };
}

/** PERF_PONTOS (migration 0012). Ausente ou desligada: sem nota sugerida. */
function perfPontosDoBanco(valor: ValorRegra | undefined): Regras["perfPontos"] {
  if (!valor) return { ativa: false, faixas: [] };
  const faixas = Array.isArray(valor.faixas) ? (valor.faixas as Record<string, unknown>[]) : [];
  return {
    ativa: valor.ativa === true,
    faixas: faixas
      .map((f) => ({
        ate: numero(f.ate, "PERF_PONTOS", "faixas.ate"),
        nota: numero(f.nota, "PERF_PONTOS", "faixas.nota"),
      }))
      .sort((a, b) => a.ate - b.ate),
  };
}

/** Carrega do banco tudo o que o cálculo precisa: pilares, indicadores, faixas, classes e regras. */
export async function carregarParametros(db: Db): Promise<Parametros> {
  const pilaresRows = (
    await db.query<{
      id: string;
      nome: string;
      nome_curto: string;
      peso: string;
      sensivel: boolean;
      evidencia_padrao: string;
    }>("select id, nome, nome_curto, peso, sensivel, evidencia_padrao from pilares order by ordem")
  ).rows;
  const indicadoresRows = (
    await db.query<{
      id: string;
      pilar_id: string;
      nome: string;
      tipo: TipoIndicador;
      calculado: boolean;
    }>("select id, pilar_id, nome, tipo, calculado from indicadores order by pilar_id, ordem")
  ).rows;
  const faixasRows = (
    await db.query<{ id: string; nome: string; nome_curto: string; score_min: string }>(
      "select id, nome, nome_curto, score_min from faixas_score order by score_min desc",
    )
  ).rows;
  const classesRows = (
    await db.query<{
      id: string;
      nome: string;
      evento: string;
      posicao: Classe["posicao"];
      peso_min_kg: string;
      peso_medio_kg: string;
      peso_max_kg: string;
    }>(
      "select id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg from classes order by ordem",
    )
  ).rows;
  const regrasRows = (
    await db.query<{ codigo: string; valor: ValorRegra }>("select codigo, valor from regras")
  ).rows;

  const pilares: Pilar[] = pilaresRows.map((p) => ({
    id: p.id,
    nome: p.nome,
    nomeCurto: p.nome_curto,
    peso: Number(p.peso),
    sensivel: p.sensivel,
    evidenciaPadrao: p.evidencia_padrao,
    indicadores: indicadoresRows
      .filter((i) => i.pilar_id === p.id)
      .map((i) => ({
        id: i.id,
        pilarId: i.pilar_id,
        nome: i.nome,
        tipo: i.tipo,
        calculado: i.calculado,
      })),
  }));
  const faixas: FaixaScore[] = faixasRows.map((f) => ({
    id: f.id,
    nome: f.nome,
    nomeCurto: f.nome_curto,
    scoreMin: Number(f.score_min),
  }));
  const classes: Classe[] = classesRows.map((c) => ({
    id: c.id,
    nome: c.nome,
    evento: c.evento,
    posicao: c.posicao,
    pesoMinKg: Number(c.peso_min_kg),
    pesoMedioKg: Number(c.peso_medio_kg),
    pesoMaxKg: Number(c.peso_max_kg),
  }));

  return { pilares, faixas, classes, regras: regrasDoBanco(regrasRows) };
}

export interface ParametrosCompletos {
  pilares: Pilar[];
  faixas: FaixaScore[];
  classes: (Classe & { ativa: boolean })[];
  rubricas: { pilarId: string | null; nota: number; descricao: string }[];
  regras: { codigo: string; descricao: string; valor: unknown; atualizadoEm: string }[];
  componentesCusto: { id: string; nome: string }[];
}

/** Leitura completa para a tela de parâmetros e para a escala de avaliação (inclui rubricas, regras brutas e componentes). */
export async function carregarParametrosCompletos(db: Db): Promise<ParametrosCompletos> {
  const base = await carregarParametros(db);
  const [rubricas, regras, componentes, ativas] = await Promise.all([
    db.query<{ pilar_id: string | null; nota: number; descricao: string }>(
      "select pilar_id, nota, descricao from rubricas order by pilar_id nulls first, nota",
    ),
    db.query<{ codigo: string; descricao: string; valor: unknown; atualizado_em: Date }>(
      "select codigo, descricao, valor, atualizado_em from regras order by codigo",
    ),
    db.query<{ id: string; nome: string }>("select id, nome from componentes_custo order by ordem"),
    db.query<{ id: string; ativa: boolean }>("select id, ativa from classes"),
  ]);
  const ativaPorId = new Map(ativas.rows.map((c) => [c.id, c.ativa]));
  return {
    pilares: base.pilares,
    faixas: base.faixas,
    classes: base.classes.map((c) => ({ ...c, ativa: ativaPorId.get(c.id) ?? true })),
    rubricas: rubricas.rows.map((r) => ({
      pilarId: r.pilar_id,
      nota: r.nota,
      descricao: r.descricao,
    })),
    regras: regras.rows.map((r) => ({
      codigo: r.codigo,
      descricao: r.descricao,
      valor: r.valor,
      atualizadoEm: new Date(r.atualizado_em).toISOString(),
    })),
    componentesCusto: componentes.rows,
  };
}

export interface AtualizacaoParametros {
  pesos?: Record<string, number> | undefined;
  faixas?: { id: string; scoreMin: number }[] | undefined;
  rubricas?: { pilarId: string | null; nota: number; descricao: string }[] | undefined;
  /** Ids de pilar cujas rubricas próprias são removidas. A escala geral (pilar nulo) não sai. */
  rubricasRemover?: (string | null)[] | undefined;
  regras?: Record<string, unknown> | undefined;
  classes?:
    | {
        id: string;
        pesoMinKg?: number | undefined;
        pesoMedioKg?: number | undefined;
        pesoMaxKg?: number | undefined;
        ativa?: boolean | undefined;
      }[]
    | undefined;
}

/** Erro de validação de negócio ao atualizar parâmetros (a rota converte em 400). */
export class ErroParametros extends Error {}

/**
 * Atualiza pesos, faixas de score, rubricas, regras e classes numa transação e grava uma
 * linha de auditoria com antes e depois de cada bloco (valores de parametrização, não dado pessoal).
 */
export async function atualizarParametros(
  db: Db,
  usuarioId: string,
  dados: AtualizacaoParametros,
): Promise<void> {
  await db.transacao(async (tx) => {
    const detalhes: Record<string, unknown> = {};

    if (dados.pesos) {
      const atuais = (await tx.query<{ id: string; peso: string }>("select id, peso from pilares"))
        .rows;
      const antes: Record<string, number> = {};
      for (const p of atuais) antes[p.id] = Number(p.peso);
      const ids = Object.keys(antes).sort();
      const enviados = Object.keys(dados.pesos).sort();
      if (ids.length !== enviados.length || ids.some((id, i) => id !== enviados[i])) {
        throw new ErroParametros("Informe o peso de todos os pilares, e só deles.");
      }
      if (Object.values(dados.pesos).reduce((t, v) => t + v, 0) !== 100) {
        throw new ErroParametros("A soma dos pesos precisa ser 100.");
      }
      for (const [id, peso] of Object.entries(dados.pesos)) {
        await tx.query("update pilares set peso = $1 where id = $2", [peso, id]);
      }
      detalhes.pesos = { antes, depois: dados.pesos };
    }

    if (dados.faixas) {
      const atuais = (
        await tx.query<{ id: string; score_min: string }>(
          "select id, score_min from faixas_score order by ordem",
        )
      ).rows;
      const enviadas = new Map(dados.faixas.map((f) => [f.id, f.scoreMin]));
      if (
        enviadas.size !== dados.faixas.length ||
        enviadas.size !== atuais.length ||
        atuais.some((f) => !enviadas.has(f.id))
      ) {
        throw new ErroParametros("Informe o score mínimo de todas as faixas, e só delas.");
      }
      const valores = atuais.map((f) => enviadas.get(f.id) as number);
      if (valores.some((v, i) => i > 0 && v >= (valores[i - 1] as number))) {
        throw new ErroParametros(
          "Os scores mínimos das faixas precisam ser estritamente decrescentes.",
        );
      }
      if (valores[valores.length - 1] !== 0)
        throw new ErroParametros("A última faixa precisa começar em 0.");
      const antes: Record<string, number> = {};
      for (const f of atuais) {
        antes[f.id] = Number(f.score_min);
        await tx.query("update faixas_score set score_min = $1 where id = $2", [
          enviadas.get(f.id),
          f.id,
        ]);
      }
      detalhes.faixas = { antes, depois: Object.fromEntries(enviadas) };
    }

    if (dados.rubricas) {
      const chaves = new Set<string>();
      const antes: { pilarId: string | null; nota: number; descricao: string | null }[] = [];
      for (const r of dados.rubricas) {
        const chave = `${r.pilarId ?? ""}|${r.nota}`;
        if (chaves.has(chave))
          throw new ErroParametros("Rubrica repetida para o mesmo pilar e nota.");
        chaves.add(chave);
        if (
          r.pilarId !== null &&
          (await tx.query("select 1 from pilares where id = $1", [r.pilarId])).rows.length === 0
        ) {
          throw new ErroParametros(`Pilar desconhecido: ${r.pilarId}.`);
        }
        const atual = (
          await tx.query<{ descricao: string }>(
            "select descricao from rubricas where pilar_id is not distinct from $1 and nota = $2",
            [r.pilarId, r.nota],
          )
        ).rows[0];
        antes.push({ pilarId: r.pilarId, nota: r.nota, descricao: atual?.descricao ?? null });
        if (atual) {
          await tx.query(
            "update rubricas set descricao = $3 where pilar_id is not distinct from $1 and nota = $2",
            [r.pilarId, r.nota, r.descricao],
          );
        } else {
          await tx.query("insert into rubricas (pilar_id, nota, descricao) values ($1, $2, $3)", [
            r.pilarId,
            r.nota,
            r.descricao,
          ]);
        }
      }
      detalhes.rubricas = { antes, depois: dados.rubricas };
    }

    if (dados.rubricasRemover) {
      const emEdicao = new Set((dados.rubricas ?? []).map((r) => r.pilarId));
      const antes: { pilarId: string | null; nota: number; descricao: string }[] = [];
      for (const pilarId of dados.rubricasRemover) {
        // null e texto vazio: a escala geral nunca é removida.
        if (!pilarId) {
          throw new ErroParametros(
            "A escala geral (pilar nulo) não pode ser removida: informe só ids de pilar.",
          );
        }
        if ((await tx.query("select 1 from pilares where id = $1", [pilarId])).rows.length === 0) {
          throw new ErroParametros(`Pilar desconhecido: ${pilarId}.`);
        }
        if (emEdicao.has(pilarId)) {
          throw new ErroParametros(
            `O pilar ${pilarId} está em rubricas e em rubricasRemover na mesma requisição.`,
          );
        }
        const linhas = (
          await tx.query<{ nota: number; descricao: string }>(
            "select nota, descricao from rubricas where pilar_id = $1 order by nota",
            [pilarId],
          )
        ).rows;
        if (linhas.length === 0) {
          throw new ErroParametros(`O pilar ${pilarId} não tem rubrica própria para remover.`);
        }
        await tx.query("delete from rubricas where pilar_id = $1", [pilarId]);
        for (const l of linhas) antes.push({ pilarId, nota: l.nota, descricao: l.descricao });
      }
      detalhes.rubricasRemovidas = { antes, depois: [] };
    }

    if (dados.regras) {
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      for (const [codigo, valor] of Object.entries(dados.regras)) {
        if (!(CODIGOS_REGRAS as string[]).includes(codigo))
          throw new ErroParametros(`Regra desconhecida: ${codigo}.`);
        const parsed = ESQUEMAS_REGRAS[codigo as CodigoRegra].safeParse(valor);
        if (!parsed.success) {
          const problema = parsed.error.issues[0];
          const onde = problema?.path.length ? ` (${problema.path.join(".")})` : "";
          throw new ErroParametros(
            `Regra ${codigo} inválida${onde}: ${problema?.message ?? "valor incorreto"}.`,
          );
        }
        const atual = (
          await tx.query<{ valor: unknown }>("select valor from regras where codigo = $1", [codigo])
        ).rows[0];
        if (!atual) throw new ErroParametros(`Regra desconhecida: ${codigo}.`);
        antes[codigo] = atual.valor;
        depois[codigo] = parsed.data;
        await tx.query(
          "update regras set valor = $2::jsonb, atualizado_em = now(), atualizado_por = $3 where codigo = $1",
          [codigo, JSON.stringify(parsed.data), usuarioId],
        );
      }
      detalhes.regras = { antes, depois };
    }

    if (dados.classes) {
      const antes: Record<string, unknown> = {};
      const depois: Record<string, unknown> = {};
      for (const c of dados.classes) {
        const { pesoMinKg: min, pesoMedioKg: medio, pesoMaxKg: max } = c;
        const faixaInformada = [min, medio, max];
        const comFaixa = min !== undefined && medio !== undefined && max !== undefined;
        if (!comFaixa && faixaInformada.some((v) => v !== undefined)) {
          throw new ErroParametros(`Classe ${c.id}: informe peso mínimo, médio e máximo juntos.`);
        }
        if (!comFaixa && c.ativa === undefined)
          throw new ErroParametros(`Classe ${c.id}: nada para alterar.`);
        if (comFaixa && !(min <= medio && medio <= max)) {
          throw new ErroParametros(
            "Em cada classe, o peso mínimo não pode passar da média, nem a média do máximo.",
          );
        }
        const atual = (
          await tx.query<{
            peso_min_kg: string;
            peso_medio_kg: string;
            peso_max_kg: string;
            ativa: boolean;
          }>("select peso_min_kg, peso_medio_kg, peso_max_kg, ativa from classes where id = $1", [
            c.id,
          ])
        ).rows[0];
        if (!atual) throw new ErroParametros(`Classe desconhecida: ${c.id}.`);
        if (c.ativa === false && atual.ativa) {
          const emUso = await tx.query(
            "select 1 from atletas where classe_id = $1 and ativo limit 1",
            [c.id],
          );
          if (emUso.rows.length > 0) {
            throw new ErroParametros(
              `Não dá para desativar a classe ${c.id}: há atleta ativo nela. Mude o atleta de classe antes.`,
            );
          }
        }
        const pesoAtual = [
          Number(atual.peso_min_kg),
          Number(atual.peso_medio_kg),
          Number(atual.peso_max_kg),
        ];
        antes[c.id] = { pesoKg: pesoAtual, ativa: atual.ativa };
        depois[c.id] = {
          pesoKg: comFaixa ? [min, medio, max] : pesoAtual,
          ativa: c.ativa ?? atual.ativa,
        };
        if (comFaixa) {
          await tx.query(
            "update classes set peso_min_kg = $1, peso_medio_kg = $2, peso_max_kg = $3 where id = $4",
            [min, medio, max, c.id],
          );
        }
        if (c.ativa !== undefined)
          await tx.query("update classes set ativa = $1 where id = $2", [c.ativa, c.id]);
      }
      detalhes.classes = { antes, depois };
    }

    await tx.query(
      "insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes) values ($1, 'atualizar_parametros', 'parametros', null, $2::jsonb)",
      [usuarioId, JSON.stringify(detalhes)],
    );
  });
}

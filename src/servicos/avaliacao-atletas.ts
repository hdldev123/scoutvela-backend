import type { Db } from "../db/db.js";
import { calcularAtleta } from "../domain/index.js";
import type { EntradaCalculo, Parametros, ResultadoCalculo } from "../domain/index.js";
import { carregarDadosAtletas } from "../repositories/atletas.js";
import type { AtletaBase, DadosAtleta, OpcoesCarga } from "../repositories/atletas.js";

export interface AtletaAvaliado {
  atleta: AtletaBase;
  dados: DadosAtleta;
  calculo: ResultadoCalculo;
}

/** Monta a entrada do domínio a partir do que foi carregado do banco. */
export function montarEntradaCalculo(
  atleta: AtletaBase,
  dados: DadosAtleta,
  referencia: Date,
): EntradaCalculo {
  const notas: Record<string, number> = {};
  for (const n of dados.notas) notas[n.indicadorId] = n.valor;
  return {
    classe: atleta.classe,
    pesoKg: dados.medida.pesoKg,
    notas,
    resultados: dados.resultados.map((r) => ({
      nivel: r.nivel,
      evento: r.evento,
      data: r.data,
      posicao: r.posicao,
      tamanhoFrota: r.tamanhoFrota,
      internacional: r.internacional,
      pontosCbvela: r.pontosCbvela,
    })),
    perfilSuporte: dados.financeiro?.perfilSuporte ?? null,
    decisoesGates: dados.decisoesGates,
    referencia,
  };
}

/** Calcula score, pilares e gates dos atletas já carregados (puro, sem banco). */
export function avaliarAtletas(
  parametros: Parametros,
  atletas: AtletaBase[],
  dados: Map<string, DadosAtleta>,
  referencia: Date,
): AtletaAvaliado[] {
  return atletas.map((atleta) => {
    const d = dados.get(atleta.id);
    if (!d) throw new Error(`Dados do atleta ${atleta.id} não carregados`);
    return {
      atleta,
      dados: d,
      calculo: calcularAtleta(parametros, montarEntradaCalculo(atleta, d, referencia)),
    };
  });
}

/** Carrega (uma ida por tabela) e calcula. `atletas` deve vir já filtrado pela matriz de acesso. */
export async function carregarEAvaliarAtletas(
  db: Db,
  parametros: Parametros,
  atletas: AtletaBase[],
  referencia: Date,
  opcoes: OpcoesCarga = {},
): Promise<AtletaAvaliado[]> {
  const dados = await carregarDadosAtletas(
    db,
    atletas.map((a) => a.id),
    opcoes,
  );
  return avaliarAtletas(parametros, atletas, dados, referencia);
}

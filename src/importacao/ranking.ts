import type { Db } from "../db/db.js";
import { linhaComoObjeto } from "./csv.js";
import { lerData } from "./comum.js";
import type { ErroLinha, ResultadoLinhas } from "./comum.js";

/** Colunas do CSV do Ranking CBVela. */
export const COLUNAS_RANKING_OBRIGATORIAS = [
  "velaid",
  "nivel",
  "evento",
  "data",
  "posicao",
  "tamanho_frota",
  "pontos",
] as const;

const NIVEIS_NACIONAIS = ["brasileiro", "estadual", "regional"] as const;

interface ResultadoCsv {
  velaid: string;
  nivel: (typeof NIVEIS_NACIONAIS)[number];
  evento: string;
  data: string;
  posicao: number;
  tamanhoFrota: number;
  pontos: number;
}

function inteiroPositivo(texto: string): number | null {
  return /^\d{1,6}$/.test(texto) && Number(texto) > 0 ? Number(texto) : null;
}

/** Valida uma linha; devolve o resultado ou a mensagem de erro (sem dado pessoal). */
export function validarLinhaRanking(
  l: Record<string, string>,
  hoje: string,
): ResultadoCsv | string {
  const velaid = (l.velaid ?? "").toUpperCase();
  if (!/^[A-Z]{2}-[A-Z0-9]{2,10}$/.test(velaid)) return "Código VelaID inválido (formato UF-XXXX).";
  const nivel = (l.nivel ?? "").toLowerCase();
  if (!(NIVEIS_NACIONAIS as readonly string[]).includes(nivel))
    return "Nível inválido (use brasileiro, estadual ou regional).";
  const evento = l.evento ?? "";
  if (evento.length < 3 || evento.length > 120)
    return "Evento ausente ou longo demais (3 a 120 caracteres).";
  const data = lerData(l.data ?? "");
  if (!data) return "Data inválida (use AAAA-MM-DD ou DD/MM/AAAA).";
  if (data > hoje) return "Data no futuro.";
  const posicao = inteiroPositivo(l.posicao ?? "");
  const tamanhoFrota = inteiroPositivo(l.tamanho_frota ?? "");
  if (posicao === null) return "Posição inválida (inteiro maior que zero).";
  if (tamanhoFrota === null) return "Tamanho da frota inválido (inteiro maior que zero).";
  if (posicao > tamanhoFrota) return "Posição maior que o tamanho da frota.";
  const textoPontos = (l.pontos ?? "").replace(",", ".");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(textoPontos))
    return "Pontos inválidos (número de 0 a 99999,99).";
  return {
    velaid,
    nivel: nivel as ResultadoCsv["nivel"],
    evento,
    data,
    posicao,
    tamanhoFrota,
    pontos: Number(textoPontos),
  };
}

/**
 * Insere resultados nacionais do Ranking CBVela (fonte `ranking_cbvela`, `internacional = false`)
 * de atletas ativos do piloto. Mesmo atleta + evento + data já existente vira erro "já importado".
 */
export async function importarRanking(
  tx: Db,
  cabecalho: string[],
  linhas: string[][],
  hoje: string,
  registradoPor: string,
): Promise<ResultadoLinhas> {
  const erros: ErroLinha[] = [];
  let linhasOk = 0;
  for (const [i, bruta] of linhas.entries()) {
    const linha = i + 2;
    const r = validarLinhaRanking(linhaComoObjeto(cabecalho, bruta), hoje);
    if (typeof r === "string") {
      erros.push({ linha, mensagem: r });
      continue;
    }
    const atleta = await tx.query<{ id: string }>(
      "select id from atletas where velaid_codigo = $1 and ativo",
      [r.velaid],
    );
    const atletaId = atleta.rows[0]?.id;
    if (!atletaId) {
      erros.push({ linha, mensagem: "Código VelaID não está entre os atletas do piloto." });
      continue;
    }
    const repetido = await tx.query(
      "select 1 from resultados_regata where atleta_id = $1 and lower(evento) = lower($2) and data = $3::date",
      [atletaId, r.evento, r.data],
    );
    if (repetido.rows.length > 0) {
      erros.push({ linha, mensagem: "Resultado já importado (mesmo atleta, evento e data)." });
      continue;
    }
    await tx.query(
      `insert into resultados_regata (atleta_id, nivel, evento, data, posicao, tamanho_frota, internacional, pontos_cbvela, fonte, registrado_por)
       values ($1, $2, $3, $4::date, $5, $6, false, $7, 'ranking_cbvela', $8)`,
      [atletaId, r.nivel, r.evento, r.data, r.posicao, r.tamanhoFrota, r.pontos, registradoPor],
    );
    linhasOk++;
  }
  return { linhasOk, erros };
}

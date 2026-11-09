import type { Db } from "../db/db.js";
import { dataIso } from "../domain/datas.js";
import { colunasProibidas, ErroCsv, lerCsv } from "./csv.js";
import { faltandoColunas } from "./comum.js";
import type { ErroLinha } from "./comum.js";
import { importarRanking, COLUNAS_RANKING_OBRIGATORIAS } from "./ranking.js";
import { importarVelaId, COLUNAS_VELAID_OBRIGATORIAS } from "./velaid.js";

export { ErroCsv, lerCsv } from "./csv.js";
export type { ErroLinha } from "./comum.js";

export type TipoImportacao = "velaid" | "ranking_cbvela";

export const MAX_LINHAS_IMPORTACAO = 5000;
/** Erros guardados/devolvidos por importação (a contagem total em `linhasErro` é exata). */
export const MAX_ERROS_GUARDADOS = 200;

export interface ResultadoImportacao {
  id: number;
  linhasOk: number;
  linhasErro: number;
  erros: ErroLinha[];
}

/** Rejeição do arquivo inteiro (nada é gravado). */
export class ArquivoRejeitado extends Error {}

/**
 * Valida o arquivo e importa numa transação. Colunas proibidas (LGPD), cabeçalho incompleto
 * ou arquivo grande demais rejeitam o arquivo inteiro; linha inválida só vira erro da linha.
 */
export async function importarCsv(
  db: Db,
  p: { tipo: TipoImportacao; arquivoNome: string | null; conteudo: string; usuarioId: string; agora: Date },
): Promise<ResultadoImportacao> {
  let csv;
  try {
    csv = lerCsv(p.conteudo);
  } catch (e) {
    if (e instanceof ErroCsv) throw new ArquivoRejeitado(e.message);
    throw e;
  }

  const proibidas = colunasProibidas(csv.cabecalho);
  if (proibidas.length > 0) {
    throw new ArquivoRejeitado(
      `O arquivo tem coluna que o Scout Vela não armazena (${proibidas.join(", ")}). Remova a coluna e envie de novo; nada foi importado.`,
    );
  }
  const obrigatorias = p.tipo === "velaid" ? COLUNAS_VELAID_OBRIGATORIAS : COLUNAS_RANKING_OBRIGATORIAS;
  const faltando = faltandoColunas(csv.cabecalho, obrigatorias);
  if (faltando.length > 0) {
    throw new ArquivoRejeitado(`Faltam colunas no cabeçalho: ${faltando.join(", ")}.`);
  }
  if (csv.linhas.length === 0) throw new ArquivoRejeitado("O arquivo não tem linhas de dados.");
  if (csv.linhas.length > MAX_LINHAS_IMPORTACAO) {
    throw new ArquivoRejeitado(`O arquivo passa de ${MAX_LINHAS_IMPORTACAO} linhas. Divida em arquivos menores.`);
  }

  const hoje = dataIso(p.agora);
  return db.transacao(async (tx) => {
    const r =
      p.tipo === "velaid"
        ? await importarVelaId(tx, csv.cabecalho, csv.linhas, hoje)
        : await importarRanking(tx, csv.cabecalho, csv.linhas, hoje, p.usuarioId);
    const erros = r.erros.slice(0, MAX_ERROS_GUARDADOS);
    const ins = await tx.query<{ id: string }>(
      `insert into importacoes (tipo, arquivo_nome, linhas_ok, linhas_erro, erros, importado_por)
       values ($1, $2, $3, $4, $5::jsonb, $6) returning id::text`,
      [p.tipo, p.arquivoNome, r.linhasOk, r.erros.length, JSON.stringify(erros), p.usuarioId],
    );
    const id = Number(ins.rows[0]!.id);
    await tx.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes) values ($1, 'importar_csv', 'importacoes', $2, $3::jsonb)`,
      [p.usuarioId, String(id), JSON.stringify({ tipo: p.tipo, linhasOk: r.linhasOk, linhasErro: r.erros.length })],
    );
    return { id, linhasOk: r.linhasOk, linhasErro: r.erros.length, erros };
  });
}

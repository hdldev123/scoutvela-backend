import type { Db } from "../db/db.js";
import { linhaComoObjeto } from "./csv.js";
import { lerData } from "./comum.js";
import type { ErroLinha, ResultadoLinhas } from "./comum.js";

/** Colunas do CSV do VelaID. Sem CPF, documento nem endereço (LGPD). */
export const COLUNAS_VELAID_OBRIGATORIAS = ["codigo", "nome", "genero", "data_nascimento"] as const;
export const COLUNAS_VELAID = [...COLUNAS_VELAID_OBRIGATORIAS, "clube", "cidade", "uf", "ws_id", "email"] as const;

interface RegistroVelaId {
  codigo: string;
  nome: string;
  genero: "F" | "M";
  dataNascimento: string;
  clube: string | null;
  cidade: string | null;
  uf: string | null;
  wsId: string | null;
  email: string | null;
}

const GENEROS: Record<string, "F" | "M"> = { f: "F", feminino: "F", m: "M", masculino: "M" };

function opcional(valor: string, max: number): string | null | undefined {
  if (valor === "") return null;
  return valor.length > max ? undefined : valor;
}

/** Valida uma linha; devolve o registro ou a mensagem de erro (sem dado pessoal). */
export function validarLinhaVelaId(l: Record<string, string>, hoje: string): RegistroVelaId | string {
  const codigo = (l.codigo ?? "").toUpperCase();
  if (!/^[A-Z]{2}-[A-Z0-9]{2,10}$/.test(codigo)) return "Código VelaID inválido (formato UF-XXXX).";
  const nome = l.nome ?? "";
  if (nome.length < 2 || nome.length > 120) return "Nome ausente ou longo demais (2 a 120 caracteres).";
  const genero = GENEROS[(l.genero ?? "").toLowerCase()];
  if (!genero) return "Gênero inválido (use F ou M).";
  const dataNascimento = lerData(l.data_nascimento ?? "");
  if (!dataNascimento) return "Data de nascimento inválida (use AAAA-MM-DD ou DD/MM/AAAA).";
  if (dataNascimento < "1900-01-01" || dataNascimento > hoje) return "Data de nascimento fora do intervalo possível.";

  const clube = opcional(l.clube ?? "", 120);
  const cidade = opcional(l.cidade ?? "", 120);
  if (clube === undefined || cidade === undefined) return "Clube ou cidade longo demais (máximo 120 caracteres).";
  const ufTexto = (l.uf ?? "").toUpperCase();
  if (ufTexto !== "" && !/^[A-Z]{2}$/.test(ufTexto)) return "UF inválida (duas letras).";
  const wsId = opcional(l.ws_id ?? "", 20);
  if (wsId === undefined) return "ID World Sailing longo demais (máximo 20 caracteres).";
  const email = opcional(l.email ?? "", 254);
  if (email === undefined || (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))) return "E-mail inválido.";

  return { codigo, nome, genero, dataNascimento, clube, cidade, uf: ufTexto === "" ? null : ufTexto, wsId, email };
}

/** Upsert em velaid_registros (fonte `csv`). Linha inválida vira erro e não derruba o arquivo. */
export async function importarVelaId(tx: Db, cabecalho: string[], linhas: string[][], hoje: string): Promise<ResultadoLinhas> {
  const erros: ErroLinha[] = [];
  let linhasOk = 0;
  for (const [i, bruta] of linhas.entries()) {
    const linha = i + 2;
    const r = validarLinhaVelaId(linhaComoObjeto(cabecalho, bruta), hoje);
    if (typeof r === "string") {
      erros.push({ linha, mensagem: r });
      continue;
    }
    await tx.query(
      `insert into velaid_registros (codigo, nome, genero, data_nascimento, clube, cidade, uf, ws_id, email, fonte, atualizado_em)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'csv', now())
       on conflict (codigo) do update set
         nome = excluded.nome, genero = excluded.genero, data_nascimento = excluded.data_nascimento,
         clube = excluded.clube, cidade = excluded.cidade, uf = excluded.uf, ws_id = excluded.ws_id,
         email = excluded.email, fonte = 'csv', atualizado_em = now()`,
      [r.codigo, r.nome, r.genero, r.dataNascimento, r.clube, r.cidade, r.uf, r.wsId, r.email],
    );
    linhasOk++;
  }
  return { linhasOk, erros };
}

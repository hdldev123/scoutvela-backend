/** Parser de CSV pequeno: separador `;` ou `,` (detectado no cabeçalho), aspas duplas com `""`, BOM e CRLF. */

export class ErroCsv extends Error {}

export interface CsvLido {
  separador: ";" | ",";
  /** Nomes das colunas já normalizados (minúsculas, sem acento, `_` no lugar de espaço). */
  cabecalho: string[];
  /** Registros de dados (sem o cabeçalho), com células já sem aspas e sem espaços nas pontas. */
  linhas: string[][];
}

/** Colunas que o Scout Vela se recusa a armazenar (LGPD). Comparadas após `normalizarColuna`. */
export const COLUNAS_PROIBIDAS = ["cpf", "rg", "documento", "endereco", "renda"] as const;

const MARCAS_DE_ACENTO = new RegExp(
  `[${String.fromCharCode(0x300)}-${String.fromCharCode(0x36f)}]`,
  "g",
);

export function normalizarColuna(nome: string): string {
  return nome
    .normalize("NFD")
    .replace(MARCAS_DE_ACENTO, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function detectarSeparador(texto: string): ";" | "," {
  const fim = texto.search(/[\r\n]/);
  const primeira = fim === -1 ? texto : texto.slice(0, fim);
  const pontoVirgulas = primeira.split(";").length - 1;
  const virgulas = primeira.split(",").length - 1;
  return pontoVirgulas >= virgulas && pontoVirgulas > 0 ? ";" : ",";
}

/** Divide o texto em registros e células. Linhas totalmente vazias são ignoradas. */
function dividir(texto: string, separador: string): string[][] {
  const registros: string[][] = [];
  let celula = "";
  let registro: string[] = [];
  let entreAspas = false;
  let celulaAspada = false;

  const fecharCelula = () => {
    registro.push(celulaAspada ? celula : celula.trim());
    celula = "";
    celulaAspada = false;
  };
  const fecharRegistro = () => {
    fecharCelula();
    if (registro.some((c) => c !== "")) registros.push(registro);
    registro = [];
  };

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i]!;
    if (entreAspas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          celula += '"';
          i++;
        } else {
          entreAspas = false;
        }
      } else {
        celula += c;
      }
      continue;
    }
    if (c === '"' && celula.trim() === "") {
      entreAspas = true;
      celulaAspada = true;
      celula = "";
    } else if (c === separador) {
      fecharCelula();
    } else if (c === "\r") {
      if (texto[i + 1] === "\n") i++;
      fecharRegistro();
    } else if (c === "\n") {
      fecharRegistro();
    } else if (celulaAspada) {
      // Texto solto depois das aspas de fechamento: mantém, ignorando espaços.
      if (c.trim() !== "") celula += c;
    } else {
      celula += c;
    }
  }
  if (entreAspas) throw new ErroCsv("O arquivo tem aspas sem fechar.");
  if (celula !== "" || registro.length > 0) fecharRegistro();
  return registros;
}

export function lerCsv(conteudo: string): CsvLido {
  const texto = conteudo.charCodeAt(0) === 0xfeff ? conteudo.slice(1) : conteudo;
  if (texto.trim() === "") throw new ErroCsv("O arquivo está vazio.");
  const separador = detectarSeparador(texto);
  const registros = dividir(texto, separador);
  const [primeiro, ...linhas] = registros;
  if (!primeiro) throw new ErroCsv("O arquivo está vazio.");
  const cabecalho = primeiro.map(normalizarColuna);
  if (cabecalho.some((c) => c === "")) throw new ErroCsv("O cabeçalho tem coluna sem nome.");
  if (new Set(cabecalho).size !== cabecalho.length)
    throw new ErroCsv("O cabeçalho tem colunas repetidas.");
  return { separador, cabecalho, linhas };
}

/** Colunas proibidas presentes no cabeçalho. */
export function colunasProibidas(cabecalho: string[]): string[] {
  return cabecalho.filter((c) => (COLUNAS_PROIBIDAS as readonly string[]).includes(c));
}

/** Linha como objeto coluna -> valor. Células faltantes viram "". */
export function linhaComoObjeto(cabecalho: string[], linha: string[]): Record<string, string> {
  return Object.fromEntries(cabecalho.map((c, i) => [c, linha[i] ?? ""]));
}

import { z } from "zod";

/** Campo inválido de uma requisição: caminho (ex.: `notas.0.evidencia`) e mensagem legível. */
export interface CampoInvalido {
  campo: string;
  mensagem: string;
}

function plural(n: number, singular: string, pluralTxt: string): string {
  return `${n} ${n === 1 ? singular : pluralTxt}`;
}

const FORMATOS: Record<string, string> = {
  email: "Informe um e-mail válido.",
  url: "Informe um endereço (URL) válido.",
  uuid: "Identificador inválido.",
  guid: "Identificador inválido.",
  datetime: "Informe data e hora no formato ISO (ex.: 2026-05-20T10:00:00Z).",
  date: "Informe a data no formato AAAA-MM-DD.",
  time: "Informe a hora no formato HH:MM.",
};

/**
 * Mensagem padrão, em pt-BR, por tipo de erro do Zod. Vale só quando o esquema não define
 * a própria mensagem. Nunca inclui o valor recebido (pode ser dado sensível).
 */
export function mensagemPadrao(issue: z.core.$ZodRawIssue): string {
  switch (issue.code) {
    case "invalid_type":
      return issue.input === undefined || issue.input === null
        ? "Campo obrigatório."
        : issue.expected === "number" || issue.expected === "int"
          ? "Informe um número."
          : issue.expected === "string"
            ? "Informe um texto."
            : issue.expected === "boolean"
              ? "Informe verdadeiro ou falso."
              : issue.expected === "array"
                ? "Informe uma lista."
                : issue.expected === "object"
                  ? "Informe um objeto."
                  : "Tipo de valor inválido.";
    case "too_small": {
      const min = Number(issue.minimum);
      if (issue.origin === "string") {
        return min <= 1
          ? "Preencha este campo."
          : `Informe pelo menos ${plural(min, "caractere", "caracteres")}.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return `Informe pelo menos ${plural(min, "item", "itens")}.`;
      }
      return issue.inclusive ? `O valor mínimo é ${min}.` : `O valor deve ser maior que ${min}.`;
    }
    case "too_big": {
      const max = Number(issue.maximum);
      if (issue.origin === "string") {
        return `Use no máximo ${plural(max, "caractere", "caracteres")}.`;
      }
      if (issue.origin === "array" || issue.origin === "set") {
        return `Informe no máximo ${plural(max, "item", "itens")}.`;
      }
      return issue.inclusive ? `O valor máximo é ${max}.` : `O valor deve ser menor que ${max}.`;
    }
    case "invalid_format":
      return FORMATOS[issue.format] ?? "Formato inválido.";
    case "invalid_value":
      return "Valor não permitido.";
    case "not_multiple_of":
      return "Valor inválido.";
    case "unrecognized_keys":
      return "Campo não reconhecido.";
    case "invalid_union":
      return "Valor inválido.";
    default:
      return "Valor inválido.";
  }
}

let configurado = false;

/** Troca as mensagens padrão do Zod (inglês) pelas de `mensagemPadrao`. Idempotente. */
export function configurarMensagensZod(): void {
  if (configurado) return;
  configurado = true;
  z.config({ customError: (issue) => mensagemPadrao(issue) });
}

/** Converte `instancePath` do Fastify (`/notas/0/evidencia`) em `notas.0.evidencia`. */
export function caminhoDoCampo(instancePath: string): string {
  return instancePath.replace(/^\/+/, "").split("/").filter(Boolean).join(".");
}

/** Lista de campos inválidos a partir do erro de validação do Fastify (sem duplicar caminho+mensagem). */
export function camposDoErro(
  validation: ReadonlyArray<{ instancePath: string; message?: string }>,
): CampoInvalido[] {
  const vistos = new Set<string>();
  const campos: CampoInvalido[] = [];
  for (const v of validation.slice(0, 50)) {
    const campo = caminhoDoCampo(v.instancePath);
    const mensagem = v.message && v.message.length > 0 ? v.message : "Valor inválido.";
    const chave = `${campo}\u0000${mensagem}`;
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    campos.push({ campo, mensagem });
  }
  return campos;
}

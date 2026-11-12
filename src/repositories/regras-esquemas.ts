import { z } from "zod";

/**
 * Esquema de cada regra da tabela `regras` (jsonb em snake_case). Usado só para validar
 * a edição pelo gestor; a leitura para o cálculo está em regrasDoBanco.
 */
const fracao = z.number().min(0).max(1);
const posicao = z.number().int().min(1).max(500);
const statusGate = z.enum(["apto", "condicional", "alerta"]);
const perfilG4 = z.strictObject({ status: statusGate, motivo: z.string().trim().min(3).max(200) });

export const ESQUEMAS_REGRAS = {
  P3: z.strictObject({
    limites: z
      .array(z.number().positive().max(100))
      .length(5, "P3 precisa de 5 limites.")
      .refine(
        (l) => l.every((v, i) => i === 0 || v > (l[i - 1] as number)),
        "Os limites de P3 precisam ser crescentes.",
      ),
  }),
  G1: z
    .strictObject({
      apto_ate: z.number().positive().max(100),
      condicional_ate: z.number().positive().max(100),
    })
    .refine(
      (v) => v.apto_ate < v.condicional_ate,
      "Em G1, apto_ate precisa ser menor que condicional_ate.",
    ),
  G2: z.strictObject({
    mundial_apto_ate_fracao: fracao,
    sul_americano_condicional_ate_posicao: posicao,
    mundial_condicional_ate_fracao: fracao,
    brasileiro_condicional_ate_posicao: posicao,
  }),
  G3: z
    .strictObject({
      apto_min_eventos: z.number().int().min(0).max(100),
      condicional_min_eventos: z.number().int().min(0).max(100),
      janela_meses: z.number().int().min(1).max(60),
    })
    .refine(
      (v) => v.apto_min_eventos >= v.condicional_min_eventos,
      "Em G3, apto_min_eventos não pode ser menor que condicional_min_eventos.",
    ),
  G4: z.strictObject({ A: perfilG4, B: perfilG4, C: perfilG4, D: perfilG4 }),
  RANKING_CBVELA: z.strictObject({ janela_semanas: z.number().int().min(1).max(104) }),
} as const;

export type CodigoRegra = keyof typeof ESQUEMAS_REGRAS;
export const CODIGOS_REGRAS = Object.keys(ESQUEMAS_REGRAS) as CodigoRegra[];

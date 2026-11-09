import type { Classe, Genero, PosicaoClasse } from "./tipos.js";
import { dataIso } from "./datas.js";

export function distanciaClassFit(
  pesoKg: number,
  classe: Classe,
): { deltaKg: number; distanciaRelativa: number } {
  const meiaFaixa = (classe.pesoMaxKg - classe.pesoMinKg) / 2;
  return {
    deltaKg: pesoKg - classe.pesoMedioKg,
    distanciaRelativa: Math.abs(pesoKg - classe.pesoMedioKg) / meiaFaixa,
  };
}

/** limites[i] é o teto da nota 5 − i; acima do último limite, nota 0. */
export function notaPeso(distanciaRelativa: number, limites: number[]): number {
  for (let i = 0; i < limites.length; i++) {
    if (distanciaRelativa <= (limites[i] as number)) return 5 - i;
  }
  return 0;
}

/** Anos completos na data de referência. */
export function idadeEm(dataNascimentoIso: string, referencia: Date): number {
  const [na, nm, nd] = dataNascimentoIso.split("-").map(Number) as [number, number, number];
  const [ra, rm, rd] = dataIso(referencia).split("-").map(Number) as [number, number, number];
  let idade = ra - na;
  if (rm < nm || (rm === nm && rd < nd)) idade--;
  return idade;
}

export function funcaoNaClasse(posicao: PosicaoClasse, genero: Genero): string {
  if (posicao === "ind") return "Individual";
  const f = genero === "F";
  return posicao === "helm" ? (f ? "Timoneira" : "Timoneiro") : f ? "Proeira" : "Proeiro";
}

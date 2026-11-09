import type { EntradaCalculo, Gate, Parametros, StatusFinal, StatusGate } from "./tipos.js";
import { distanciaClassFit } from "./classfit.js";
import { dataIso, menosMeses, naJanela } from "./datas.js";

export interface SugestaoGate {
  gate: number;
  status: StatusGate;
  motivo: string;
}

const fmt1 = (v: number) =>
  v.toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const fmtDelta = (d: number) => (d >= 0 ? "+" : "−") + fmt1(Math.abs(d)) + " kg";

export function gatesAutomaticos(
  parametros: Parametros,
  entrada: Pick<EntradaCalculo, "classe" | "pesoKg" | "resultados" | "perfilSuporte" | "referencia">,
): SugestaoGate[] {
  const { g1: r1, g2: r2, g3: r3, g4: r4 } = parametros.regras;

  let g1: SugestaoGate;
  if (entrada.pesoKg == null) {
    g1 = { gate: 1, status: "alerta", motivo: "Sem pesagem registrada" };
  } else {
    const { deltaKg, distanciaRelativa: rel } = distanciaClassFit(entrada.pesoKg, entrada.classe);
    if (rel <= r1.aptoAte)
      g1 = { gate: 1, status: "apto", motivo: `Dentro da faixa da classe (${fmtDelta(deltaKg)} da média)` };
    else if (rel <= r1.condicionalAte)
      g1 = { gate: 1, status: "condicional", motivo: `Leve desvio: ${fmtDelta(deltaKg)} da média da classe` };
    else g1 = { gate: 1, status: "alerta", motivo: `Fora da faixa: ${fmtDelta(deltaKg)} da média da classe` };
  }

  // Mais recente primeiro: find pega o resultado mais recente de cada nível.
  const ordenados = [...entrada.resultados].sort((a, b) => b.data.localeCompare(a.data));
  const internacionais = ordenados.filter((r) => r.internacional);
  const mund = internacionais.find((r) => r.nivel === "mundial");
  const sul = internacionais.find((r) => r.nivel === "sul_americano");
  const bras = ordenados.find((r) => r.nivel === "brasileiro");
  let g2: SugestaoGate;
  if (mund && mund.posicao / mund.tamanhoFrota <= r2.mundialAptoAteFracao)
    g2 = { gate: 2, status: "apto", motivo: `${mund.posicao}º de ${mund.tamanhoFrota} no Mundial da classe` };
  else if (sul && sul.posicao <= r2.sulAmericanoCondicionalAtePosicao)
    g2 = { gate: 2, status: "condicional", motivo: `${sul.posicao}º no Sul-Americano` };
  else if (mund && mund.posicao / mund.tamanhoFrota <= r2.mundialCondicionalAteFracao)
    g2 = { gate: 2, status: "condicional", motivo: `${mund.posicao}º de ${mund.tamanhoFrota} no Mundial` };
  else if (bras && bras.posicao <= r2.brasileiroCondicionalAtePosicao)
    g2 = {
      gate: 2,
      status: "condicional",
      motivo: `${bras.posicao}º no Brasileiro${internacionais.length ? ", com experiência internacional" : ""}`,
    };
  else g2 = { gate: 2, status: "alerta", motivo: "Sem evidência relevante fora do circuito nacional" };

  const fim = dataIso(entrada.referencia);
  const inicio = menosMeses(fim, r3.janelaMeses);
  const n = internacionais.filter((r) => naJanela(r.data, inicio, fim)).length;
  let g3: SugestaoGate;
  if (n >= r3.aptoMinEventos)
    g3 = { gate: 3, status: "apto", motivo: `${n} eventos internacionais em ${r3.janelaMeses} meses` };
  else if (n >= r3.condicionalMinEventos)
    g3 = {
      gate: 3,
      status: "condicional",
      motivo: `${n} ${n > 1 ? "eventos internacionais" : "evento internacional"} em ${r3.janelaMeses} meses`,
    };
  else g3 = { gate: 3, status: "alerta", motivo: `Nenhum evento internacional em ${r3.janelaMeses} meses` };

  const g4: SugestaoGate = entrada.perfilSuporte
    ? { gate: 4, ...r4[entrada.perfilSuporte] }
    : { gate: 4, status: "alerta", motivo: "Financeiro da campanha ainda não informado" };

  return [g1, g2, g3, g4];
}

/** Decisão do gestor substitui o status; motivo e sugestão automática ficam preservados. */
export function aplicarDecisoes(
  sugestoes: SugestaoGate[],
  decisoesGates: (StatusGate | null)[],
): Gate[] {
  return sugestoes.map((s, i) => {
    const decisao = decisoesGates[i] ?? null;
    return {
      gate: s.gate,
      status: decisao ?? s.status,
      motivo: s.motivo,
      sugestaoAutomatica: s.status,
      ajustadoPeloGestor: decisao != null,
    };
  });
}

/** P7: algum alerta → não prioritário; algum condicional → condicional; senão apto. */
export function statusFinal(gates: Pick<Gate, "status">[]): StatusFinal {
  if (gates.some((g) => g.status === "alerta")) return "nao_prioritario";
  if (gates.some((g) => g.status === "condicional")) return "condicional";
  return "apto";
}

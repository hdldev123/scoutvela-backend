import type { PerfilSuporte, StatusFinal } from "./tipos.js";

/** Os cinco textos do plano individual. */
export interface TextosPlano {
  forcas: string;
  lacunas: string;
  meta12m: string;
  meta24m: string;
  recomendacao: string;
}

export interface EntradaSugestaoPlano {
  /** Pilares na ordem de exibição, com a nota calculada (nulo = sem nota). */
  pilares: { nome: string; nota: number | null }[];
  /** Há resultado de nível mundial entre os resultados do atleta. */
  temResultadoMundial: boolean;
  statusFinal: StatusFinal;
  /** Nomes dos gates que não estão aptos. */
  gatesNaoAptos: string[];
  perfilSuporte: PerfilSuporte | null;
  faixaNome: string;
}

const SEM_AVALIACAO = "Aguardando a primeira avaliação";

/**
 * Sugestão de plano individual a partir do cálculo. É só uma sugestão: quem
 * registra o plano é uma pessoa (gestor ou treinador).
 */
export function sugerirPlano(e: EntradaSugestaoPlano): TextosPlano {
  const comNota = e.pilares.filter((p): p is { nome: string; nota: number } => p.nota !== null);
  // Ordenação estável: empate fica na ordem de exibição dos pilares.
  const maiores = [...comNota].sort((a, b) => b.nota - a.nota).slice(0, 2);
  const nomesForcas = new Set(maiores.map((p) => p.nome));
  const menores = comNota
    .filter((p) => !nomesForcas.has(p.nome))
    .sort((a, b) => a.nota - b.nota)
    .slice(0, 2);

  const forcas = comNota.length === 0 ? SEM_AVALIACAO : maiores.map((p) => p.nome).join(", ");
  const lacunas =
    comNota.length === 0
      ? SEM_AVALIACAO
      : menores.length === 0
        ? "Aguardando mais avaliações"
        : menores.map((p) => p.nome).join(", ");

  const meta12m = e.temResultadoMundial ? "Top 10 no Mundial da classe" : "Primeiro Mundial da classe, top 50%";
  const meta24m =
    e.statusFinal === "apto"
      ? "Campanha completa no circuito internacional"
      : `Fechar os gates em aberto: ${e.gatesNaoAptos.join(", ")}`;
  const recomendacao =
    e.perfilSuporte === "C" || e.perfilSuporte === "D"
      ? `${e.faixaNome}, com apoio para viagens e equipamento`
      : e.faixaNome;

  return { forcas, lacunas, meta12m, meta24m, recomendacao };
}

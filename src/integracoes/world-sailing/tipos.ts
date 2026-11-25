import type { PerfilWorldSailing } from "../../domain/world-sailing.js";

export type { PerfilWorldSailing, ResultadoWs, RankingWs } from "../../domain/world-sailing.js";

/** `desligado`: sem busca. `simulado`: dados fictícios (dev e homologação). `real`: API da World Sailing. */
export const MODOS_WORLD_SAILING = ["desligado", "simulado", "real"] as const;
export type ModoWorldSailing = (typeof MODOS_WORLD_SAILING)[number];

export interface OpcoesBusca {
  /** Cancela a busca (tempo limite total de quem chamou). */
  sinal?: AbortSignal;
}

/** Fonte dos dados do perfil: a API real ou o simulador. Os testes injetam uma fonte própria. */
export interface FonteWorldSailing {
  /** Perfil público pelo WS ID; nulo quando o ID não existe. Falha vira `ErroWorldSailing`. */
  buscarPerfil(wsId: string, opcoes?: OpcoesBusca): Promise<PerfilWorldSailing | null>;
}

/**
 * Falha da fonte. `codigo` é curto e seguro para log e banco: `tempo_esgotado`, `http_<status>`,
 * `resposta_invalida` ou `rede`. Nunca carrega o corpo da resposta.
 */
export class ErroWorldSailing extends Error {
  constructor(readonly codigo: string) {
    super(`Falha na World Sailing: ${codigo}`);
  }
}

import { criarFonteReal } from "./cliente.js";
import { criarFetchSimulado, criarFonteSimulada } from "./simulador.js";
import type { FonteWorldSailing, ModoWorldSailing } from "./tipos.js";

export * from "./tipos.js";
export {
  PREFIXO_FOTO_WORLD_SAILING,
  URL_PADRAO_WORLD_SAILING,
  criarFonteReal,
  normalizarPerfil,
} from "./cliente.js";
export { criarFetchSimulado, criarFonteSimulada } from "./simulador.js";
export { baixarFotoWorldSailing, FotoWorldSailingInvalida } from "./foto.js";

/** O que a API usa da World Sailing: o modo, a fonte dos dados e o `fetch` das fotos. */
export interface IntegracaoWorldSailing {
  modo: ModoWorldSailing;
  /** Nula com o modo `desligado`. */
  fonte: FonteWorldSailing | null;
  /** `fetch` da foto do perfil (nos testes, um falso). */
  fetch: typeof fetch;
  /** Tempo limite total da busca feita no cadastro (padrão 15 s). */
  limiteCadastroMs: number;
}

export interface ConfigWorldSailing {
  WORLD_SAILING_MODO: ModoWorldSailing;
  WORLD_SAILING_API_URL: string;
}

/** Escolhe a fonte pelo modo da configuração: `real` chama a API; `simulado` usa dados fictícios. */
export function criarIntegracaoDaConfig(config: ConfigWorldSailing): IntegracaoWorldSailing {
  const base = { limiteCadastroMs: 15_000 };
  switch (config.WORLD_SAILING_MODO) {
    case "real":
      return {
        ...base,
        modo: "real",
        fonte: criarFonteReal({ urlBase: config.WORLD_SAILING_API_URL }),
        fetch,
      };
    case "simulado":
      return {
        ...base,
        modo: "simulado",
        fonte: criarFonteSimulada(),
        fetch: criarFetchSimulado(),
      };
    default:
      return { ...base, modo: "desligado", fonte: null, fetch };
  }
}

/**
 * Integração da aplicação: a da config, com o que o chamador injetou por cima (testes trocam a fonte
 * e o `fetch`). Fonte injetada sem modo vale como `simulado`; `fonte: null`, como `desligado`.
 */
export function resolverIntegracao(
  config: ConfigWorldSailing,
  injetado?: Partial<IntegracaoWorldSailing>,
): IntegracaoWorldSailing {
  const base = criarIntegracaoDaConfig(config);
  if (!injetado) return base;
  const fonte = injetado.fonte === undefined ? base.fonte : injetado.fonte;
  const modo =
    injetado.modo ?? (injetado.fonte === undefined ? base.modo : fonte ? "simulado" : "desligado");
  return { ...base, ...injetado, fonte, modo };
}

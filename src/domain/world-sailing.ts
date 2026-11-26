import type { NivelCompeticao } from "./tipos.js";

/**
 * Perfil público da World Sailing, já normalizado (D19). Só o que pontua ou decide: nome, gênero e
 * nascimento viram sugestão de cadastro; foto e bio, sugestão de perfil; peso e altura autodeclarados,
 * sugestão de medida (D20) que o treinador ou o gestor confirma. Estado civil, local de nascimento,
 * redes sociais e dados de outros velejadores nunca entram aqui.
 */
export interface PerfilWorldSailing {
  /** Identificador do velejador na World Sailing (UUID); chave da busca de ranking. */
  sailorId: string;
  wsId: string;
  nome: string | null;
  genero: "F" | "M" | null;
  /** AAAA-MM-DD. */
  dataNascimento: string | null;
  /** Só `https://assets.sailing.org/...`. */
  fotoUrl: string | null;
  bio: string | null;
  /** Peso autodeclarado no perfil (30 a 160 kg, uma casa); nulo se ausente ou fora da faixa. */
  pesoKg: number | null;
  /** Altura autodeclarada no perfil (120 a 230 cm, uma casa); nula se ausente ou fora da faixa. */
  alturaCm: number | null;
  /** AAAA-MM-DD: quando o velejador atualizou o perfil (`updatedAt`). */
  atualizadoEm: string | null;
  resultados: ResultadoWs[];
  ranking: RankingWs[];
}

/** Um resultado de regata (uma tripulação num evento). */
export interface ResultadoWs {
  /** Identificador do resultado na World Sailing; garante que a importação não duplica. */
  ref: string;
  /** Nome da regata (evento). */
  evento: string;
  classe: string;
  /** Nome do nível do evento na World Sailing; nulo quando o evento não tem nível. */
  nivelWs: string | null;
  /** AAAA-MM-DD (início da regata). */
  data: string;
  posicao: number;
}

/** Uma posição do histórico de ranking. */
export interface RankingWs {
  ref: string;
  /** AAAA-MM-DD. */
  data: string;
  classe: string;
  tipo: string | null;
  posicao: number;
  pontos: number | null;
}

/** Regra provisória P13 (`WS_NIVEIS`): nome do nível na World Sailing -> nível do Scout Vela. */
export interface RegraWsNiveis {
  niveis: Record<string, NivelCompeticao>;
}

/** Linha de `resultados_regata` a gravar para um resultado importado. */
export interface ResultadoParaGravar {
  nivel: NivelCompeticao;
  evento: string;
  data: string;
  edicao: number;
  posicao: number;
  tamanhoFrota: null;
  internacional: boolean;
  linkOficial: string;
  fonte: "world_sailing";
  wsRef: string;
}

/** Níveis que não são internacionais (o resto é). */
const NIVEIS_NACIONAIS: readonly NivelCompeticao[] = ["brasileiro", "estadual", "regional"];

const DATA_ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Corta o texto em até `max` caracteres no fim de uma palavra (a bio sugerida pela World Sailing passa
 * de 500 caracteres). Sem espaço aproveitável na segunda metade, corta seco.
 */
export function cortarNoFimDaPalavra(texto: string, max: number): string {
  const limpo = texto.trim();
  if (limpo.length <= max) return limpo;
  const corte = limpo.slice(0, max);
  const ultimoEspaco = corte.search(/\s\S*$/);
  const base = ultimoEspaco > max / 2 ? corte.slice(0, ultimoEspaco) : corte;
  return base.trimEnd();
}

/** Link do perfil público do atleta na World Sailing (o mesmo padrão usado na ficha). */
export function linkPerfilWorldSailing(wsId: string): string {
  return `https://www.sailing.org/sailor/?ref=${encodeURIComponent(wsId)}`;
}

/**
 * Nível de competição de um evento da World Sailing pela regra `WS_NIVEIS`. Nível nulo ou fora da
 * regra vira `internacional_aberto`: o resultado fica registrado e não gera nota.
 */
export function nivelDaRegata(nivelWs: string | null, regra: RegraWsNiveis): NivelCompeticao {
  if (nivelWs === null) return "internacional_aberto";
  const nome = nivelWs.trim();
  if (nome === "") return "internacional_aberto";
  const direto = Object.hasOwn(regra.niveis, nome) ? regra.niveis[nome] : undefined;
  if (direto) return direto;
  // Sem diferença de caixa: a World Sailing já mudou a grafia de nomes de nível.
  const minusculo = nome.toLowerCase();
  const chave = Object.keys(regra.niveis).find((k) => k.trim().toLowerCase() === minusculo);
  return (chave ? regra.niveis[chave] : undefined) ?? "internacional_aberto";
}

/** Nome do evento gravado: `<regata> (<classe>)`, em até 200 caracteres. */
export function nomeDoEvento(regata: string, classe: string): string {
  const limpo = (t: string) => t.replace(/\s+/g, " ").trim();
  const nome = limpo(regata);
  const sufixo = ` (${limpo(classe)})`;
  const max = 200;
  return nome.length + sufixo.length <= max
    ? nome + sufixo
    : nome.slice(0, Math.max(1, max - sufixo.length)).trimEnd() + sufixo;
}

/**
 * Linhas de `resultados_regata` dos resultados do perfil. Resultado sem data válida ou sem colocação
 * positiva é ignorado (não dá para datar nem pontuar).
 */
export function resultadosParaGravar(
  perfil: Pick<PerfilWorldSailing, "wsId" | "resultados">,
  regra: RegraWsNiveis,
): ResultadoParaGravar[] {
  const link = linkPerfilWorldSailing(perfil.wsId);
  const saida: ResultadoParaGravar[] = [];
  for (const r of perfil.resultados) {
    if (!DATA_ISO.test(r.data) || !Number.isInteger(r.posicao) || r.posicao <= 0) continue;
    const nivel = nivelDaRegata(r.nivelWs, regra);
    saida.push({
      nivel,
      evento: nomeDoEvento(r.evento, r.classe),
      data: r.data,
      edicao: Number(r.data.slice(0, 4)),
      posicao: r.posicao,
      tamanhoFrota: null,
      internacional: !NIVEIS_NACIONAIS.includes(nivel),
      linkOficial: link,
      fonte: "world_sailing",
      wsRef: r.ref,
    });
  }
  return saida;
}

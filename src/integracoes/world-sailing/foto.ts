import { ErroWorldSailing } from "./tipos.js";

const HOST_FOTOS = "assets.sailing.org";
const TAMANHO_MAXIMO_FOTO = 5 * 1024 * 1024;
const TEMPO_LIMITE_MS = 8_000;

/** A foto não pode ser usada (endereço fora da lista, formato ou tamanho). */
export class FotoWorldSailingInvalida extends Error {}

export interface FotoBaixada {
  bytes: Buffer;
  tipoMime: "image/jpeg" | "image/png";
}

/** Só `https://assets.sailing.org/...`, sem usuário, senha nem porta. */
export function enderecoDeFotoPermitido(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === "https:" &&
      u.hostname === HOST_FOTOS &&
      u.port === "" &&
      u.username === "" &&
      u.password === ""
    );
  } catch {
    return false;
  }
}

/** Tipo pela assinatura do arquivo (não pelo cabeçalho): JPEG ou PNG. */
export function tipoPelaAssinatura(bytes: Uint8Array): FotoBaixada["tipoMime"] | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return "image/png";
  }
  return null;
}

/**
 * Baixa a foto de perfil sugerida pela World Sailing, pelo servidor: só do domínio de imagens deles,
 * sem seguir redirecionamento, em até 5 MB, e só JPEG ou PNG conferidos pela assinatura. Quem chama
 * ainda limpa os metadados (EXIF e GPS) antes de guardar.
 */
export async function baixarFotoWorldSailing(
  url: string,
  buscar: typeof fetch = fetch,
): Promise<FotoBaixada> {
  if (!enderecoDeFotoPermitido(url)) throw new FotoWorldSailingInvalida("endereco_fora_da_lista");
  let res: Response;
  try {
    res = await buscar(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "image/jpeg, image/png", "user-agent": "ScoutVela/1.0" },
      signal: AbortSignal.timeout(TEMPO_LIMITE_MS),
    });
  } catch (e) {
    const nome = (e as { name?: unknown })?.name;
    throw new ErroWorldSailing(
      nome === "TimeoutError" || nome === "AbortError" ? "tempo_esgotado" : "rede",
    );
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new ErroWorldSailing(`http_${res.status}`);
  }
  const declarado = Number(res.headers.get("content-length"));
  if ((Number.isFinite(declarado) && declarado > TAMANHO_MAXIMO_FOTO) || !res.body) {
    await res.body?.cancel().catch(() => undefined);
    throw new FotoWorldSailingInvalida("tamanho");
  }
  const partes: Uint8Array[] = [];
  let total = 0;
  try {
    const leitor = res.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
    for (;;) {
      const { done, value } = await leitor.read();
      if (done) break;
      total += value.length;
      if (total > TAMANHO_MAXIMO_FOTO) {
        await leitor.cancel().catch(() => undefined);
        throw new FotoWorldSailingInvalida("tamanho");
      }
      partes.push(value);
    }
  } catch (e) {
    if (e instanceof FotoWorldSailingInvalida) throw e;
    throw new ErroWorldSailing("rede");
  }
  const bytes = Buffer.concat(partes);
  const tipoMime = tipoPelaAssinatura(bytes);
  if (!tipoMime) throw new FotoWorldSailingInvalida("formato");
  return { bytes, tipoMime };
}

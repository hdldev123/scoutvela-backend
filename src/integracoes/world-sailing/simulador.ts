import type { PerfilWorldSailing } from "../../domain/world-sailing.js";
import type { FonteWorldSailing } from "./tipos.js";

/**
 * Fonte simulada: dados FICTÍCIOS (nomes, datas, eventos e posições inventados) para desenvolvimento,
 * homologação e testes. Nunca chama a rede. IDs reconhecidos: BRATESTE01 (perfil completo),
 * BRATESTE02 (perfil sem resultados, ranking, peso nem altura) e BRASPT08 (atleta do seed, mesmo perfil do
 * BRATESTE01). Qualquer outro ID não existe.
 */

const BRATESTE01: PerfilWorldSailing = {
  sailorId: "00000000-0000-4000-8000-0000000000a1",
  wsId: "BRATESTE01",
  nome: "Marina Ventosa Lemos",
  genero: "F",
  dataNascimento: "2003-04-12",
  fotoUrl: "https://assets.sailing.org/simulado/bratesteos01-headshot.png",
  bio: "Velejadora fictícia do simulador. Começou na classe ILCA 6 e hoje compete no circuito internacional.",
  pesoKg: 71.5,
  alturaCm: 176,
  atualizadoEm: "2026-10-15",
  resultados: [
    {
      ref: "sim-b01-r1",
      evento: "Campeonato Mundial Simulado",
      classe: "ILCA 6",
      nivelWs: "World Championships",
      data: "2025-08-04",
      posicao: 7,
    },
    {
      ref: "sim-b01-r2",
      evento: "Mundial Juvenil Simulado",
      classe: "ILCA 6",
      nivelWs: "Youth Sailing World Championships",
      data: "2022-07-10",
      posicao: 3,
    },
    {
      ref: "sim-b01-r3",
      evento: "Campeonato Continental Simulado",
      classe: "ILCA 6",
      nivelWs: "Continental",
      data: "2025-03-15",
      posicao: 2,
    },
    {
      ref: "sim-b01-r4",
      evento: "Copa do Mundo de Vela Simulada",
      classe: "ILCA 6",
      nivelWs: "Sailing World Cup Series",
      data: "2026-01-20",
      posicao: 12,
    },
    {
      ref: "sim-b01-r5",
      evento: "Troféu Simulado de Primavera",
      classe: "ILCA 6",
      nivelWs: null,
      data: "2026-04-05",
      posicao: 5,
    },
  ],
  ranking: [
    {
      ref: "sim-b01-k1",
      data: "2026-06-30",
      classe: "ILCA 6",
      tipo: "Senior",
      posicao: 18,
      pontos: 412.5,
    },
    {
      ref: "sim-b01-k2",
      data: "2025-12-31",
      classe: "ILCA 6",
      tipo: "Senior",
      posicao: 24,
      pontos: 380,
    },
    {
      ref: "sim-b01-k3",
      data: "2025-12-31",
      classe: "ILCA 7",
      tipo: "Senior",
      posicao: 61,
      pontos: 150.25,
    },
    {
      ref: "sim-b01-k4",
      data: "2022-12-31",
      classe: "ILCA 6",
      tipo: "Youth",
      posicao: 9,
      pontos: null,
    },
  ],
};

const BRATESTE02: PerfilWorldSailing = {
  sailorId: "00000000-0000-4000-8000-0000000000a2",
  wsId: "BRATESTE02",
  nome: "Caio Maresia Duarte",
  genero: "M",
  dataNascimento: "2004-09-30",
  fotoUrl: null,
  bio: null,
  pesoKg: null,
  alturaCm: null,
  atualizadoEm: null,
  resultados: [],
  ranking: [],
};

/**
 * Atleta FICTÍCIO do seed com cadastro completo (Davi Moretto, VelaID SP-T08): o mesmo perfil do
 * BRATESTE01, para a ficha completa poder ser vista no dev e no E2E (a ficha de atleta com cadastro
 * incompleto, como o recém-cadastrado BRATESTE01, dá 404 até o primeiro acesso).
 */
const BRASPT08: PerfilWorldSailing = {
  ...structuredClone(BRATESTE01),
  sailorId: "00000000-0000-4000-8000-0000000000a8",
  wsId: "BRASPT08",
  nome: "Davi Moretto",
};

const PERFIS = new Map([BRATESTE01, BRATESTE02, BRASPT08].map((p) => [p.wsId, p]));

export function criarFonteSimulada(): FonteWorldSailing {
  return {
    buscarPerfil(wsId) {
      const perfil = PERFIS.get(wsId.trim().toUpperCase());
      // Cópia: quem recebe pode alterar sem estragar o próximo teste.
      return Promise.resolve(perfil ? structuredClone(perfil) : null);
    },
  };
}

/** PNG 1x1 (fictício) devolvido para qualquer foto do simulador, sem rede. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/** `fetch` simulado das fotos: devolve um PNG mínimo para `assets.sailing.org` e 404 para o resto. */
export function criarFetchSimulado(): typeof fetch {
  return (entrada: Parameters<typeof fetch>[0]) => {
    const url = entrada instanceof Request ? entrada.url : String(entrada);
    if (!url.startsWith("https://assets.sailing.org/")) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    return Promise.resolve(
      new Response(new Uint8Array(PNG_1X1), {
        status: 200,
        headers: { "content-type": "image/png", "content-length": String(PNG_1X1.length) },
      }),
    );
  };
}

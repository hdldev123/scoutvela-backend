/**
 * Respostas FICTÍCIAS no formato da API do datafeed da World Sailing (descoberto em 25/11/2026). Nomes, IDs,
 * datas e posições são inventados; os campos extras (estado civil, local de nascimento, redes sociais,
 * outros velejadores da tripulação) existem de propósito, para provar que o parse os descarta.
 */

export const SAILOR_UUID = "11111111-2222-4333-8444-555555555555";

export function respostaPerfil(sobrescrever: Record<string, unknown> = {}) {
  return {
    data: [
      {
        id: SAILOR_UUID,
        worldSailingId: "BRATESTE09",
        firstName: "Joana",
        lastName: "Brisa Fictícia",
        gender: { name: "Female", id: 2 },
        dateOfBirth: "2002-02-28",
        biography: "Velejadora inventada para os testes.",
        maritalStatus: "SEGREDO-ESTADO-CIVIL",
        placeOfBirth: "SEGREDO-LOCAL-DE-NASCIMENTO",
        height: 199,
        weight: 99,
        updatedAt: "2026-10-15 14:30:00",
        profileQuestions: [{ question: "SEGREDO-PERGUNTA", answer: "SEGREDO-RESPOSTA" }],
        socialMedia: [{ url: "https://exemplo.invalid/SEGREDO-REDE" }],
        categorisation: "SEGREDO-CATEGORIA",
        images: [
          {
            url: "https://assets.sailing.org/sailors/validation_placeholder.jpeg",
            tags: ["headshot"],
          },
          { url: "https://assets.sailing.org/sailors/fake-wide.jpg", tags: ["banner"] },
          { url: "https://assets.sailing.org/sailors/fake-headshot.jpg", tags: ["headshot", "x"] },
        ],
        crews: [
          crew(
            "c-1",
            "3",
            "ILCA 6",
            "  Mundial   Fictício  ",
            "2025-08-04 10:00:00",
            "World Championships",
          ),
          crew(
            "c-2",
            "12",
            "ILCA 6",
            "Copa Fictícia",
            "2026-01-20 09:30:00",
            "Sailing World Cup Series",
          ),
          crew("c-3", "5", "ILCA 6", "Troféu Fictício", "2026-04-05 00:00:00", null),
          crew(
            "c-4",
            "DNF",
            "ILCA 6",
            "Regata sem colocação",
            "2026-05-01 00:00:00",
            "Continental",
          ),
          crew("c-5", "0", "ILCA 6", "Regata com zero", "2026-05-02 00:00:00", "Continental"),
          crew("c-6", "4", "ILCA 6", "Regata sem data", null, "Continental"),
          crew("c-7", "2", "ILCA 6", "Continental Fictício", "2025-03-15 00:00:00", "Continental"),
          { id: "c-8" },
        ],
        ...sobrescrever,
      },
    ],
    included: [{ type: "regatta", id: "x", attributes: { name: "ignorado" } }],
  };
}

function crew(
  id: string,
  position: string,
  classe: string,
  regata: string,
  inicio: string | null,
  nivel: string | null,
) {
  return {
    id,
    position,
    crewMembers: [{ sailorName: "SEGREDO-OUTRO-VELEJADOR" }],
    event: {
      boatClass: { name: classe },
      regatta: { name: regata, startDate: inicio, level: nivel ? { name: nivel } : null },
    },
  };
}

export function respostaRanking() {
  return {
    data: [
      {
        id: "k-1",
        rankPosition: 18,
        rankPoints: "412.50",
        rankingReference: {
          rankDate: "2026-06-30",
          boatClass: { name: "ILCA 6" },
          type: { name: "Senior" },
        },
      },
      {
        id: "k-2",
        rankPosition: 61,
        rankPoints: null,
        rankingReference: { rankDate: "2025-12-31", boatClass: { name: "ILCA 7" }, type: null },
      },
      {
        id: "k-3",
        rankPosition: 9,
        rankPoints: 10,
        rankingReference: { rankDate: "2024-12-31", boatClass: null, type: { name: "Youth" } },
      },
    ],
  };
}

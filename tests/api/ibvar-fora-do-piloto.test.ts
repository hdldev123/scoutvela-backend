import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const INICIO = new Date("2026-11-06T12:00:00-03:00");
const TEXTO =
  "Segunda versão do termo do piloto, com o texto revisado pela CBVela para o ciclo seguinte.";

describe("IBVAR e atleta fora do piloto (TERMO_EXIGE_REACEITE)", () => {
  let p: Piloto;
  let agora = INICIO;
  let id: string;
  let indicador: string;
  beforeAll(async () => {
    p = await criarPiloto(() => agora);
    id = await p.idDe("SC-T01"); // consentiu o compartilhamento com o IBVAR
    indicador = (
      await p.db.query<{ id: string }>(
        `select i.id from indicadores i join pilares pl on pl.id = i.pilar_id
          where i.tipo = 'T' and not i.calculado and not pl.sensivel order by pl.ordem, i.ordem limit 1`,
      )
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const chamar = async (
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    body?: object,
  ) =>
    (
      await p.app.inject({
        method,
        url,
        headers: await p.como(email),
        ...(body ? { payload: body } : {}),
      })
    ).statusCode;
  const ficha = (email: string) => chamar(email, "GET", `/atletas/${id}`);
  const historico = (email: string) =>
    chamar(email, "GET", `/atletas/${id}/indicadores/${indicador}/historico`);

  it("sem a regra, o IBVAR abre a ficha e o histórico de quem consentiu", async () => {
    expect(await ficha(EMAILS_DEMO.ibvar)).toBe(200);
    expect(await historico(EMAILS_DEMO.ibvar)).not.toBe(404);
  });

  it("com a regra ativa e o aceite pendente, o IBVAR recebe 404 e os outros papéis mantêm o acesso", async () => {
    expect(
      await chamar(EMAILS_DEMO.gestor, "POST", "/termos", {
        versao: "Piloto 18+ · v2",
        titulo: "Termo do piloto, segunda versão",
        texto: TEXTO,
        vigenteDesde: "2026-11-20T00:00:00-03:00",
      }),
    ).toBe(201);
    expect(
      await chamar(EMAILS_DEMO.gestor, "PUT", "/parametros", {
        regras: { TERMO_EXIGE_REACEITE: { ativa: true } },
      }),
    ).toBe(200);
    agora = new Date("2026-11-21T12:00:00-03:00");

    expect(await ficha(EMAILS_DEMO.ibvar)).toBe(404);
    expect(await historico(EMAILS_DEMO.ibvar)).toBe(404);
    expect(await ficha(EMAILS_DEMO.gestor)).toBe(200);
    expect(await ficha(EMAILS_DEMO.treinadora)).toBe(200);
    expect(await historico(EMAILS_DEMO.gestor)).not.toBe(404);
    // O próprio atleta (Helena, SP-T07) mantém o acesso à própria ficha.
    expect(await chamar(EMAILS_DEMO.atleta, "GET", `/atletas/${await p.idDe("SP-T07")}`)).toBe(200);
  });
});

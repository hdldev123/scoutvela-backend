import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("400 com campos", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto(AGORA);
  });
  afterAll(() => p.encerrar());

  it("devolve o caminho e a mensagem em pt-BR de cada campo inválido", async () => {
    const id = await p.idDe("RJ-T05");
    const r = await p.app.inject({
      method: "POST",
      url: `/atletas/${id}/avaliacoes`,
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: {
        notas: [{ indicadorId: "perf_mundial", valor: 3, evidencia: "x" }],
        medida: { pesoKg: 20, evidencia: "ok" },
      },
    });
    expect(r.statusCode).toBe(400);
    const corpo = r.json();
    expect(corpo.erro).toBe("requisicao_invalida");
    expect(corpo.campos).toEqual(
      expect.arrayContaining([
        { campo: "notas.0.evidencia", mensagem: "A evidência precisa ter ao menos 3 caracteres." },
        { campo: "medida.pesoKg", mensagem: "O peso deve ficar entre 30 e 160 kg." },
        {
          campo: "medida.evidencia",
          mensagem: "A evidência da medida precisa ter ao menos 3 caracteres.",
        },
      ]),
    );
    expect(JSON.stringify(corpo)).not.toMatch(/stack|select |from /i);
  });

  it("usa o mapa padrão em pt-BR quando o esquema não tem mensagem", async () => {
    const r = await p.app.inject({
      method: "PUT",
      url: "/consentimento",
      headers: await p.como(EMAILS_DEMO.gestor),
      payload: { autoriza: "talvez" },
    });
    expect(r.statusCode).toBe(400);
    for (const c of r.json().campos) {
      expect(c.mensagem).not.toMatch(/Invalid|expected|Too /);
    }
  });
});

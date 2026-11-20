import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { preencherAlturasFicticias } from "../../seed/alturas-ficticias.js";
import type { Db } from "../../src/db/db.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

describe("alturas fictícias das classes (só desenvolvimento)", () => {
  let db: Db;
  beforeAll(async () => {
    db = await criarBancoDeTeste();
  });
  afterAll(() => db.fechar());

  it("a migration não traz valores: a faixa nasce vazia", async () => {
    const r = await db.query("select 1 from classes where altura_min_cm is not null");
    expect(r.rows).toHaveLength(0);
  });

  it("preenche as 14 classes, é idempotente e não sobrescreve faixa já definida", async () => {
    expect(await preencherAlturasFicticias(db)).toBe(14);
    expect(await preencherAlturasFicticias(db)).toBe(0);
    await db.query(
      "update classes set altura_min_cm = 150, altura_media_cm = 160, altura_max_cm = 170 where id = 'ilca7'",
    );
    await db.query(
      "update classes set altura_min_cm = null, altura_media_cm = null, altura_max_cm = null where id = 'ilca6'",
    );
    expect(await preencherAlturasFicticias(db)).toBe(1);
    const ilca7 = await db.query<{ altura_min_cm: string }>(
      "select altura_min_cm from classes where id = 'ilca7'",
    );
    expect(Number(ilca7.rows[0]!.altura_min_cm)).toBe(150);
  });

  it("o check do banco recusa faixa parcial ou fora de 120 a 230", async () => {
    await expect(
      db.query("update classes set altura_media_cm = null where id = '470-helm'"),
    ).rejects.toThrow();
    await expect(
      db.query(
        "update classes set altura_min_cm = 100, altura_media_cm = 170, altura_max_cm = 180 where id = '470-helm'",
      ),
    ).rejects.toThrow();
  });

  it("recusa rodar em produção", async () => {
    const antes = process.env.APP_ENV;
    process.env.APP_ENV = "producao";
    try {
      await expect(preencherAlturasFicticias(db)).rejects.toThrow(/produção/);
    } finally {
      if (antes === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = antes;
    }
  });
});

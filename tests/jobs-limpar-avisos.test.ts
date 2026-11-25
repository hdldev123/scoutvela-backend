import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { limparAvisosAntigos } from "../src/jobs/limpar-avisos.js";
import { EMAILS_DEMO, criarPiloto } from "./apoio/piloto.js";
import type { Piloto } from "./apoio/piloto.js";

const AGORA = new Date("2026-11-25T12:00:00-03:00");
const diasAtras = (d: number) => new Date(AGORA.getTime() - d * 86_400_000);

describe("limpeza de avisos (retenção de 180 dias dos lidos)", () => {
  let p: Piloto;
  let usuarioId: string;
  beforeAll(async () => {
    p = await criarPiloto(() => AGORA);
    usuarioId = (
      await p.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
  });
  afterAll(() => p.encerrar());

  const inserir = (criado: Date, lido: Date | null) =>
    p.db.query(
      `insert into avisos (destinatario_id, tipo, criado_em, lido_em)
       values ($1, 'sugestao_respondida', $2, $3)`,
      [usuarioId, criado, lido],
    );

  it("apaga só os lidos há mais de 180 dias; os lidos recentes e os não lidos ficam", async () => {
    await inserir(diasAtras(400), diasAtras(181)); // sai
    await inserir(diasAtras(400), diasAtras(200)); // sai
    await inserir(diasAtras(400), diasAtras(180)); // no limite: fica
    await inserir(diasAtras(400), diasAtras(10)); // fica
    await inserir(diasAtras(400), null); // antigo, mas não lido: fica
    const info: Record<string, unknown>[] = [];
    const r = await limparAvisosAntigos({
      db: p.db,
      agora: AGORA,
      log: { info: (obj) => info.push(obj) },
    });
    expect(r).toEqual({ removidos: 2 });
    expect(info).toEqual([{ removidos: 2 }]);
    const restam = await p.db.query<{ n: string }>("select count(*)::text as n from avisos");
    expect(restam.rows[0]!.n).toBe("3");
    // Segunda rodada não tem mais o que apagar.
    expect((await limparAvisosAntigos({ db: p.db, agora: AGORA })).removidos).toBe(0);
  });
});

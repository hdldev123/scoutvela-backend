import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria } from "../src/email/index.js";
import { executarLembretes } from "../src/jobs/lembretes.js";
import { EMAILS_DEMO, criarPiloto } from "./apoio/piloto.js";
import type { Piloto } from "./apoio/piloto.js";

// Ciclo aberto do seed: Novembro de 2026, prazo 30/11/2026.
const em = (dia: string) => new Date(`${dia}T12:00:00-03:00`);
const FRONT = "https://app.scoutvela.dev/";

describe("lembretes do ciclo", () => {
  let p: Piloto;
  beforeEach(async () => {
    p = await criarPiloto();
  });
  afterEach(() => p.encerrar());

  const rodar = (dia: string, email = criarProvedorEmailMemoria()) =>
    executarLembretes({ db: p.db, email, agora: em(dia), frontUrl: FRONT }).then((r) => ({
      r,
      email,
    }));

  it("envia nos dias 7, 3, 1 e 0 antes do prazo", async () => {
    for (const dia of ["2026-11-23", "2026-11-27", "2026-11-29", "2026-11-30"]) {
      const { r, email } = await rodar(dia);
      expect(r.treinadores, dia).toBeGreaterThan(0);
      expect(email.enviadas.length, dia).toBe(r.treinadores + r.atletas);
    }
  });

  it("não envia nos outros dias antes do prazo", async () => {
    for (const dia of ["2026-11-09", "2026-11-22", "2026-11-24", "2026-11-26", "2026-11-28"]) {
      const { r, email } = await rodar(dia);
      expect(r, dia).toEqual({ treinadores: 0, atletas: 0, ignorados: 0 });
      expect(email.enviadas).toHaveLength(0);
    }
  });

  it("depois do prazo envia todo dia, uma vez por pessoa", async () => {
    const a = await rodar("2026-12-03");
    expect(a.r.treinadores).toBeGreaterThan(0);
    expect(a.email.enviadas[0]!.assunto).toContain("em atraso");
    const b = await rodar("2026-12-04");
    expect(b.r.treinadores).toBe(a.r.treinadores);
  });

  it("não reenvia no mesmo dia", async () => {
    const primeira = await rodar("2026-11-27");
    const segunda = await rodar("2026-11-27");
    expect(segunda.r.treinadores + segunda.r.atletas).toBe(0);
    expect(segunda.r.ignorados).toBe(primeira.r.treinadores + primeira.r.atletas);
    expect(segunda.email.enviadas).toHaveLength(0);
  });

  it("sem ciclo aberto não envia", async () => {
    await p.db.query("update ciclos_avaliacao set status = 'fechado'");
    const { r, email } = await rodar("2026-11-27");
    expect(r).toEqual({ treinadores: 0, atletas: 0, ignorados: 0 });
    expect(email.enviadas).toHaveLength(0);
  });

  it("falha de envio libera a reserva e a próxima execução tenta de novo", async () => {
    const quebrado = {
      async enviar() {
        throw new Error("smtp fora");
      },
    };
    const falha = await executarLembretes({
      db: p.db,
      email: quebrado,
      agora: em("2026-11-27"),
      frontUrl: FRONT,
    });
    expect(falha.treinadores + falha.atletas).toBe(0);
    expect(falha.ignorados).toBeGreaterThan(0);
    const { r } = await rodar("2026-11-27");
    expect(r.treinadores).toBeGreaterThan(0);
  });

  it("destinatários certos e conteúdo sem dado sensível", async () => {
    const { email } = await rodar("2026-11-27");
    const paras = email.enviadas.map((m) => m.para);
    expect(paras).toContain(EMAILS_DEMO.treinadora);
    expect(paras).not.toContain(EMAILS_DEMO.gestor);
    expect(paras).not.toContain(EMAILS_DEMO.ibvar);

    const nomes = (await p.db.query<{ nome: string }>("select nome from atletas")).rows.map(
      (a) => a.nome,
    );
    for (const m of email.enviadas) {
      const conteudo = `${m.assunto}\n${m.texto}`;
      expect(conteudo).toMatch(/\/(avaliar|painel)/);
      expect(conteudo).toContain("30/11/2026");
      expect(conteudo).not.toMatch(/\d+(,\d)?\s?kg|score|nota \d|peso/i);
      for (const n of nomes) expect(conteudo).not.toContain(n);
      expect(m.html).toBeUndefined();
    }
    const doTreinador = email.enviadas.find((m) => m.para === EMAILS_DEMO.treinadora)!;
    expect(doTreinador.texto).toContain("https://app.scoutvela.dev/avaliar");
  });

  it("treinador sem pendência não recebe", async () => {
    await p.db.query(
      `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em)
       select a.id, i.id, c.id, 3, 'teste', 'avaliacao', a.treinador_id, now()
         from atletas a cross join indicadores i cross join ciclos_avaliacao c
        where i.tipo = 'T' and not i.calculado and c.status = 'aberto' and a.treinador_id is not null`,
    );
    const { email } = await rodar("2026-11-27");
    expect(email.enviadas.map((m) => m.para)).not.toContain(EMAILS_DEMO.treinadora);
  });
});

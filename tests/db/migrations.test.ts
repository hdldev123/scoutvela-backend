import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import { migrar } from "../../src/db/migrar.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

let db: Db;
beforeAll(async () => {
  db = await criarBancoDeTeste();
});
afterAll(async () => {
  await db.fechar();
});

describe("Migrations", () => {
  it("rodar de novo não reaplica nada", async () => {
    expect(await migrar(db)).toEqual([]);
  });

  it("toda tabela do schema public tem RLS ativo", async () => {
    const { rows } = await db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("views usam security_invoker (não furam o RLS)", async () => {
    const { rows } = await db.query<{ relname: string; opcoes: string[] | null }>(
      `select c.relname, c.reloptions as opcoes from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'v'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const v of rows) expect(v.opcoes ?? [], v.relname).toContain("security_invoker=true");
  });

  it("série histórica de notas não aceita UPDATE nem DELETE", async () => {
    await db.exec(`
      insert into pilares (id, nome, nome_curto, peso, evidencia_padrao, ordem) values ('t_pil', 'Teste', 'T', 10, 'Obs', 99);
      insert into indicadores (id, pilar_id, nome, tipo, ordem) values ('t_ind', 't_pil', 'Ind', 'T', 1);
      insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
        values ('t_cls', 'Classe teste', 'Teste', 'ind', 60, 65, 70, 99);
      insert into usuarios (id, email, nome, papel) values ('00000000-0000-0000-0000-0000000000aa', 't@t.dev', 'T', 'gestor');
      insert into atletas (id, velaid_codigo, ws_id, nome, genero, data_nascimento, classe_id)
        values ('00000000-0000-0000-0000-0000000000bb', 'XX-T99', 'BRAXXT99', 'Atleta Teste', 'F', '2000-01-01', 't_cls');
      insert into avaliacoes (atleta_id, indicador_id, valor, evidencia, origem, avaliador_id)
        values ('00000000-0000-0000-0000-0000000000bb', 't_ind', 3, 'Obs', 'avaliacao', '00000000-0000-0000-0000-0000000000aa');
    `);
    await expect(db.exec("update avaliacoes set valor = 5")).rejects.toThrow(/aceita só inserção/);
    await expect(db.exec("delete from avaliacoes")).rejects.toThrow(/aceita só inserção/);
  });

  describe("evidências: update controlado (0010)", () => {
    const ATLETA = "00000000-0000-0000-0000-0000000000cc";
    const USUARIO = "00000000-0000-0000-0000-0000000000dd";
    const hash = "a".repeat(64);
    beforeAll(async () => {
      await db.exec(`
        insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
          values ('t_cls2', 'Classe teste 2', 'Teste', 'ind', 60, 65, 70, 98);
        insert into usuarios (id, email, nome, papel) values ('${USUARIO}', 'ev@t.dev', 'Ev', 'gestor');
        insert into atletas (id, velaid_codigo, ws_id, nome, genero, data_nascimento, classe_id)
          values ('${ATLETA}', 'XX-EV1', 'BRAXXEV1', 'Atleta Ev', 'F', '2000-01-01', 't_cls2');
      `);
    });
    const inserir = async (caminho: string) => {
      const r = await db.query<{ id: string }>(
        `insert into evidencias_anexos (atleta_id, nome_arquivo, tipo_mime, tamanho_bytes, caminho, sha256, enviado_por)
         values ($1, 'laudo.pdf', 'application/pdf', 10, $2, $3, $4) returning id`,
        [ATLETA, caminho, hash, USUARIO],
      );
      return r.rows[0]!.id;
    };

    it("aceita marcar a remoção (removido_em + nome 'removido') e mais nada depois", async () => {
      const id = await inserir("a/1.pdf");
      await db.query(
        `update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido' where id = $1`,
        [id],
      );
      await expect(
        db.query(`update evidencias_anexos set removido_em = null where id = $1`, [id]),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(
        db.query(`update evidencias_anexos set removido_em = now() where id = $1`, [id]),
      ).rejects.toThrow(/aceita só inserção/);
      await expect(db.query(`delete from evidencias_anexos where id = $1`, [id])).rejects.toThrow(
        /aceita só inserção/,
      );
    });

    it("recusa trocar caminho, nome livre, outras colunas ou marcar sem o nome neutro", async () => {
      const id = await inserir("a/2.pdf");
      const recusar = (sql: string) =>
        expect(db.query(sql, [id])).rejects.toThrow(/aceita só inserção/);
      await recusar(`update evidencias_anexos set caminho = 'a/outro.pdf' where id = $1`);
      await recusar(`update evidencias_anexos set nome_arquivo = 'outro.pdf' where id = $1`);
      await recusar(`update evidencias_anexos set sha256 = repeat('b', 64) where id = $1`);
      await recusar(`update evidencias_anexos set removido_em = now() where id = $1`);
      await recusar(
        `update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido', caminho = 'a/x.pdf' where id = $1`,
      );
      await recusar(
        `update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido', indicador_id = null, tamanho_bytes = 11 where id = $1`,
      );
      await recusar(`delete from evidencias_anexos where id = $1`);
    });

    it("recusa removido_em anterior ao envio", async () => {
      const id = await inserir("a/3.pdf");
      await expect(
        db.query(
          `update evidencias_anexos set removido_em = enviado_em - interval '1 second', nome_arquivo = 'removido' where id = $1`,
          [id],
        ),
      ).rejects.toThrow(/aceita só inserção/);
      // No mesmo instante do envio vale.
      await db.query(
        `update evidencias_anexos set removido_em = enviado_em, nome_arquivo = 'removido' where id = $1`,
        [id],
      );
    });

    it("compara o registro inteiro: coluna criada no futuro também fica protegida", async () => {
      await db.exec(`alter table evidencias_anexos add column futura text`);
      try {
        const id = await inserir("a/4.pdf");
        await expect(
          db.query(
            `update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido', futura = 'x' where id = $1`,
            [id],
          ),
        ).rejects.toThrow(/aceita só inserção/);
        await db.query(
          `update evidencias_anexos set removido_em = now(), nome_arquivo = 'removido' where id = $1`,
          [id],
        );
      } finally {
        await db.exec(`alter table evidencias_anexos drop column futura`);
      }
    });
  });

  describe("funções com search_path fixo (0016)", () => {
    it("todas as funções do schema public têm search_path definido", async () => {
      const { rows } = await db.query<{ proname: string }>(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f'
            and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')`,
      );
      expect(rows.map((r) => r.proname)).toEqual([]);
    });
  });

  describe("resultados do Ranking CBVela (índice único)", () => {
    const ATLETA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    beforeAll(async () => {
      await db.exec(`
        insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
          values ('t_cls3', 'Classe teste 3', 'Teste', 'ind', 60, 65, 70, 97);
        insert into atletas (id, velaid_codigo, ws_id, nome, genero, data_nascimento, classe_id)
          values ('${ATLETA}', 'XX-RK1', 'BRAXXRK1', 'Atleta Rk', 'F', '2000-01-01', 't_cls3');
      `);
    });
    const inserir = (evento: string, fonte: "ranking_cbvela" | "manual" = "ranking_cbvela") =>
      db.query(
        `insert into resultados_regata (atleta_id, nivel, evento, data, posicao, tamanho_frota, internacional, pontos_cbvela, fonte, link_oficial)
         values ($1, 'estadual', $2, '2026-05-30', 1, 10, false, ${fonte === "manual" ? "null" : "10"}, $3, ${fonte === "manual" ? "'https://x.invalid'" : "null"})`,
        [ATLETA, evento, fonte],
      );

    const anonimizarResultados = (evento: string) =>
      db.transacao(async (tx) => {
        await tx.query(`select set_config('scoutvela.anonimizando', $1, true)`, [ATLETA]);
        await tx.query(
          `update resultados_regata set evento = 'Evento anonimizado', link_oficial = null, anonimizado = true
            where atleta_id = $1 and evento = $2`,
          [ATLETA, evento],
        );
      });

    it("recusa o mesmo atleta + evento + data (sem diferenciar maiúsculas) na fonte do ranking", async () => {
      await inserir("Copa Unica");
      await expect(inserir("COPA UNICA")).rejects.toThrow(/resultados_ranking_unico/);
    });

    it("não vale para a fonte manual nem para linhas anonimizadas", async () => {
      await inserir("Copa Manual", "manual");
      await inserir("Copa Manual", "manual");
      await inserir("Copa Anon");
      await anonimizarResultados("Copa Anon");
      await inserir("Copa Anon");
      await anonimizarResultados("Copa Anon");
    });
  });
  describe("WS ID como chave e cadastro incompleto (0018)", () => {
    const ins = (cols: string, vals: string) =>
      db.exec(`insert into atletas (${cols}) values (${vals})`);

    beforeAll(async () => {
      await db.exec(`
        insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ordem)
          values ('t_cls4', 'Classe teste 4', 'Teste', 'ind', 60, 65, 70, 96);
      `);
    });

    it("ws_id é obrigatório, único e no formato; velaid_codigo aceita nulo e continua único", async () => {
      await expect(ins("classe_id", "'t_cls4'")).rejects.toThrow(/ws_id/);
      await ins("ws_id, classe_id", "'BRAWS001', 't_cls4'");
      await expect(ins("ws_id, classe_id", "'BRAWS001', 't_cls4'")).rejects.toThrow(
        /atletas_ws_id_unico/,
      );
      for (const ruim of ["bra001", "BR", "1BRA23", "BRA-123", "BRAABCDEFGHIJKLM"]) {
        await expect(ins("ws_id, classe_id", `'${ruim}', 't_cls4'`), ruim).rejects.toThrow(
          /atletas_ws_id_formato/,
        );
      }
      // Dois atletas sem VelaID convivem; o mesmo VelaID preenchido não.
      await ins("ws_id, classe_id", "'BRAWS002', 't_cls4'");
      await ins("ws_id, classe_id", "'BRAWS003', 't_cls4'");
      await ins("ws_id, velaid_codigo, classe_id", "'BRAWS004', 'XX-W04', 't_cls4'");
      await expect(
        ins("ws_id, velaid_codigo, classe_id", "'BRAWS005', 'XX-W04', 't_cls4'"),
      ).rejects.toThrow(/velaid_codigo/);
    });

    it("nome, gênero e nascimento aceitam nulo só com o cadastro incompleto", async () => {
      await ins("ws_id, classe_id", "'BRAWS006', 't_cls4'");
      // Completo exige os três.
      await expect(
        ins(
          "ws_id, classe_id, cadastro_completo_em, nome",
          "'BRAWS007', 't_cls4', now(), 'Só Nome'",
        ),
      ).rejects.toThrow(/atletas_cadastro_completo_dados/);
      await ins(
        "ws_id, classe_id, cadastro_completo_em, nome, genero, data_nascimento",
        "'BRAWS008', 't_cls4', now(), 'Atleta Completo', 'F', '2000-01-01'",
      );
      // Não dá para completar sem os dados, nem recusar quem já completou.
      await expect(
        db.exec("update atletas set cadastro_completo_em = now() where ws_id = 'BRAWS006'"),
      ).rejects.toThrow(/atletas_cadastro_completo_dados/);
      await expect(
        db.exec("update atletas set cadastro_recusado_em = now() where ws_id = 'BRAWS008'"),
      ).rejects.toThrow(/atletas_cadastro_recusado_incompleto/);
    });
  });
});

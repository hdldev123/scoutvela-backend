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
      insert into atletas (id, velaid_codigo, nome, genero, data_nascimento, classe_id)
        values ('00000000-0000-0000-0000-0000000000bb', 'XX-T99', 'Atleta Teste', 'F', '2000-01-01', 't_cls');
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
        insert into atletas (id, velaid_codigo, nome, genero, data_nascimento, classe_id)
          values ('${ATLETA}', 'XX-EV1', 'Atleta Ev', 'F', '2000-01-01', 't_cls2');
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
  });
});

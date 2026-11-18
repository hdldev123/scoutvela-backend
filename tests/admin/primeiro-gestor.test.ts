import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DadosInvalidos,
  GestorJaExiste,
  criarPrimeiroGestor,
} from "../../src/admin/primeiro-gestor.js";
import type { Db } from "../../src/db/db.js";
import { ContaJaExiste, type AdminAuth } from "../../src/integracoes/supabase-admin.js";
import { criarBancoDeTeste } from "../apoio/banco.js";

const AUTH_ID = "11111111-1111-4111-8111-111111111111";
const REDIRECT = "https://scoutvela.example/redefinir-senha";

function adminFake(falha?: Error) {
  const convites: { email: string; redirectTo: string }[] = [];
  const admin: AdminAuth = {
    async convidar(email, redirectTo) {
      convites.push({ email, redirectTo });
      if (falha) throw falha;
      return { authUserId: AUTH_ID };
    },
    async removerConta() {},
  };
  return { admin, convites };
}

let db: Db;
beforeEach(async () => {
  db = await criarBancoDeTeste();
});
afterEach(async () => {
  await db.fechar();
});

const gestores = async () =>
  (
    await db.query<{
      email: string;
      nome: string;
      auth_user_id: string | null;
      convidado: boolean;
    }>(
      `select email, nome, auth_user_id, convidado_em is not null as convidado
       from usuarios where papel = 'gestor'`,
    )
  ).rows;

describe("criarPrimeiroGestor", () => {
  it("grava o gestor, envia o convite e registra na auditoria", async () => {
    const { admin, convites } = adminFake();
    const { usuarioId } = await criarPrimeiroGestor(db, admin, {
      email: "  Gestora@Instituicao.ORG ",
      nome: " Maria Souza ",
      redirectTo: REDIRECT,
    });

    expect(convites).toEqual([{ email: "gestora@instituicao.org", redirectTo: REDIRECT }]);
    expect(await gestores()).toEqual([
      {
        email: "gestora@instituicao.org",
        nome: "Maria Souza",
        auth_user_id: AUTH_ID,
        convidado: true,
      },
    ]);
    const { rows } = await db.query<{ usuario_id: string | null; entidade_id: string }>(
      "select usuario_id, entidade_id from auditoria where acao = 'criar_primeiro_gestor'",
    );
    expect(rows).toEqual([{ usuario_id: null, entidade_id: usuarioId }]);
  });

  it("recusa quando já existe gestor ativo, sem convidar", async () => {
    await db.query("insert into usuarios (email, nome, papel) values ('a@b.org', 'Ana', 'gestor')");
    const { admin, convites } = adminFake();
    await expect(
      criarPrimeiroGestor(db, admin, { email: "c@d.org", nome: "Caio", redirectTo: REDIRECT }),
    ).rejects.toBeInstanceOf(GestorJaExiste);
    expect(convites).toEqual([]);
  });

  it("se o convite falhar, não deixa usuário gravado", async () => {
    const { admin } = adminFake(new ContaJaExiste());
    await expect(
      criarPrimeiroGestor(db, admin, { email: "c@d.org", nome: "Caio", redirectTo: REDIRECT }),
    ).rejects.toBeInstanceOf(ContaJaExiste);
    expect(await gestores()).toEqual([]);
  });

  it("valida e-mail e nome antes de tocar no banco", async () => {
    const { admin, convites } = adminFake();
    await expect(
      criarPrimeiroGestor(db, admin, { email: "sem-arroba", nome: "Caio", redirectTo: REDIRECT }),
    ).rejects.toBeInstanceOf(DadosInvalidos);
    await expect(
      criarPrimeiroGestor(db, admin, { email: "c@d.org", nome: " ", redirectTo: REDIRECT }),
    ).rejects.toBeInstanceOf(DadosInvalidos);
    expect(convites).toEqual([]);
  });
});

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria } from "../../src/email/index.js";
import { criarAdminAuthFalso, type AdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

describe("contas, convites e edição de atleta", () => {
  let p: Piloto;
  let admin: AdminAuthFalso;
  let semAdmin: Piloto;

  beforeAll(async () => {
    admin = criarAdminAuthFalso();
    p = await criarPiloto(undefined, { adminAuth: admin, email: criarProvedorEmailMemoria() });
    semAdmin = await criarPiloto();
  });
  afterAll(async () => {
    await p.encerrar();
    await semAdmin.encerrar();
  });
  beforeEach(() => {
    admin.convites.length = 0;
    admin.contasExistentes.clear();
    admin.falhar = false;
  });

  const chamar = async (
    alvo: Piloto,
    email: string,
    method: "GET" | "POST" | "PUT",
    url: string,
    payload?: unknown,
  ) => {
    const r = await alvo.app.inject({
      method,
      url,
      headers: await alvo.como(email),
      ...(payload === undefined ? {} : { payload: payload as object }),
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const gestor = (method: "GET" | "POST" | "PUT", url: string, payload?: unknown) =>
    chamar(p, EMAILS_DEMO.gestor, method, url, payload);
  const idUsuario = async (alvo: Piloto, email: string) =>
    (await alvo.db.query<{ id: string }>("select id from usuarios where email = $1", [email]))
      .rows[0]!.id;
  const auditoria = async (acao: string) =>
    (
      await p.db.query<{ detalhes: unknown }>(
        "select detalhes from auditoria where acao = $1 order by id",
        [acao],
      )
    ).rows;

  describe("acesso por papel", () => {
    it("só o gestor lista, cria e edita contas", async () => {
      const id = await idUsuario(p, EMAILS_DEMO.ibvar);
      for (const email of [EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta, EMAILS_DEMO.ibvar]) {
        expect((await chamar(p, email, "GET", "/usuarios")).status, email).toBe(403);
        expect(
          (
            await chamar(p, email, "POST", "/usuarios", {
              nome: "X",
              email: "x@x.dev",
              papel: "gestor",
            })
          ).status,
        ).toBe(403);
        expect((await chamar(p, email, "PUT", `/usuarios/${id}`, { ativo: false })).status).toBe(
          403,
        );
        expect((await chamar(p, email, "POST", `/usuarios/${id}/convite`)).status).toBe(403);
        expect(
          (await chamar(p, email, "PUT", `/atletas/${await p.idDe("SC-T01")}`, { ativo: false }))
            .status,
        ).toBe(403);
      }
      expect((await p.app.inject({ method: "GET", url: "/usuarios" })).statusCode).toBe(401);
    });
  });

  describe("GET /usuarios", () => {
    it("lista com atleta vinculado e estado da conta", async () => {
      const { status, corpo } = await gestor("GET", "/usuarios");
      expect(status).toBe(200);
      const g = corpo.find((u: { email: string }) => u.email === EMAILS_DEMO.gestor);
      expect(g).toMatchObject({
        papel: "gestor",
        ativo: true,
        atleta: null,
        contaVinculada: true,
        convidadoEm: null,
      });
      const a = corpo.find((u: { email: string }) => u.email === EMAILS_DEMO.atleta);
      expect(a.atleta).toEqual({ id: expect.any(String), nome: expect.any(String) });
      const marcos = corpo.find((u: { email: string }) => u.email === "marcos.pires@scoutvela.dev");
      expect(marcos.contaVinculada).toBe(false);
    });
  });

  describe("POST /usuarios", () => {
    it("cria o treinador, convida com redirect para /redefinir-senha e audita sem e-mail", async () => {
      const { status, corpo } = await gestor("POST", "/usuarios", {
        nome: "Beatriz Lima",
        email: "  Beatriz.Lima@Exemplo.com ",
        papel: "treinador",
      });
      expect(status).toBe(201);
      expect(corpo.convite).toBe("enviado");
      expect(corpo.usuario).toMatchObject({
        nome: "Beatriz Lima",
        email: "beatriz.lima@exemplo.com",
        papel: "treinador",
        ativo: true,
        contaVinculada: true,
      });
      expect(corpo.usuario.convidadoEm).toEqual(expect.any(String));
      expect(admin.convites).toHaveLength(1);
      expect(admin.convites[0]).toMatchObject({
        email: "beatriz.lima@exemplo.com",
        redirectTo: "http://localhost:8080/redefinir-senha",
      });
      const row = (
        await p.db.query<{ auth_user_id: string }>(
          "select auth_user_id from usuarios where id = $1",
          [corpo.usuario.id],
        )
      ).rows[0]!;
      expect(row.auth_user_id).toBe(admin.convites[0]!.authUserId);
      const aud = JSON.stringify([
        ...(await auditoria("criar_usuario")),
        ...(await auditoria("convidar_usuario")),
      ]);
      expect(aud).not.toContain("exemplo.com");
      expect(aud).not.toContain("Beatriz");
    });

    it("atleta exige atletaId de atleta existente e ainda sem conta", async () => {
      const base = { nome: "Fulano", email: "fulano@exemplo.com", papel: "atleta" };
      expect((await gestor("POST", "/usuarios", base)).status).toBe(400);
      expect(
        (await gestor("POST", "/usuarios", { ...base, atletaId: crypto.randomUUID() })).status,
      ).toBe(404);
      expect((await gestor("POST", "/usuarios", { ...base, atletaId: "nao-uuid" })).status).toBe(
        400,
      );
      const comConta = (
        await p.db.query<{ atleta_id: string }>("select atleta_id from usuarios where email = $1", [
          EMAILS_DEMO.atleta,
        ])
      ).rows[0]!.atleta_id;
      expect((await gestor("POST", "/usuarios", { ...base, atletaId: comConta })).status).toBe(409);

      const livre = await p.idDe("SC-T01");
      const ok = await gestor("POST", "/usuarios", { ...base, atletaId: livre });
      expect(ok.status).toBe(201);
      expect(ok.corpo.usuario.atleta.id).toBe(livre);
    });

    it("atletaId em papel que não é atleta -> 400", async () => {
      const r = await gestor("POST", "/usuarios", {
        nome: "G",
        email: "g@exemplo.com",
        papel: "gestor",
        atletaId: await p.idDe("SP-T07"),
      });
      expect(r.status).toBe(400);
    });

    it("e-mail repetido (também com maiúsculas) -> 409", async () => {
      expect(
        (
          await gestor("POST", "/usuarios", {
            nome: "Dup",
            email: "GESTOR@scoutvela.dev",
            papel: "ibvar",
          })
        ).status,
      ).toBe(409);
      expect(admin.convites).toHaveLength(0);
    });

    it("papel responsavel recusado; dados inválidos -> 400", async () => {
      const r = await gestor("POST", "/usuarios", {
        nome: "Resp",
        email: "resp@exemplo.com",
        papel: "responsavel",
      });
      expect(r.status).toBe(400);
      expect(r.corpo.mensagem).toContain("responsável");
      expect(
        (await gestor("POST", "/usuarios", { nome: "X", email: "sem-arroba", papel: "gestor" }))
          .status,
      ).toBe(400);
      expect(
        (await gestor("POST", "/usuarios", { nome: " ", email: "x@exemplo.com", papel: "gestor" }))
          .status,
      ).toBe(400);
      expect(
        (await gestor("POST", "/usuarios", { nome: "X", email: "x@exemplo.com", papel: "dono" }))
          .status,
      ).toBe(400);
    });

    it("sem adminAuth cria o usuário e devolve convite indisponivel", async () => {
      const r = await chamar(semAdmin, EMAILS_DEMO.gestor, "POST", "/usuarios", {
        nome: "Sem Auth",
        email: "semauth@exemplo.com",
        papel: "ibvar",
      });
      expect(r.status).toBe(201);
      expect(r.corpo.convite).toBe("indisponivel");
      expect(r.corpo.usuario).toMatchObject({ contaVinculada: false, convidadoEm: null });
    });

    it("e-mail que já tem conta no Auth: usuário criado, convite indisponivel", async () => {
      admin.contasExistentes.add("jatem@exemplo.com");
      const r = await gestor("POST", "/usuarios", {
        nome: "Já Tem",
        email: "jatem@exemplo.com",
        papel: "gestor",
      });
      expect(r.status).toBe(201);
      expect(r.corpo.convite).toBe("indisponivel");
      expect(r.corpo.usuario.contaVinculada).toBe(false);
    });

    it("falha do Auth não derruba a criação", async () => {
      admin.falhar = true;
      const r = await gestor("POST", "/usuarios", {
        nome: "Falha",
        email: "falha@exemplo.com",
        papel: "treinador",
      });
      expect(r.status).toBe(201);
      expect(r.corpo.convite).toBe("indisponivel");
    });
  });

  describe("PUT /usuarios/:id", () => {
    it("edita nome e desativa; conta inativa perde o acesso", async () => {
      const id = await idUsuario(p, "marcos.pires@scoutvela.dev");
      const r = await gestor("PUT", `/usuarios/${id}`, { nome: "Marcos P. Pires", ativo: false });
      expect(r.status).toBe(200);
      expect(r.corpo).toMatchObject({ nome: "Marcos P. Pires", ativo: false });
      expect((await auditoria("editar_usuario")).at(-1)!.detalhes).toEqual({
        campos: ["nome", "ativo"],
      });
      expect(
        (await gestor("GET", "/treinadores")).corpo.map((t: { nome: string }) => t.nome),
      ).not.toContain("Marcos P. Pires");
      await gestor("PUT", `/usuarios/${id}`, { ativo: true });
    });

    it("gestor não desativa a si mesmo; corpo vazio, id inválido e inexistente", async () => {
      const eu = await idUsuario(p, EMAILS_DEMO.gestor);
      const r = await gestor("PUT", `/usuarios/${eu}`, { ativo: false });
      expect(r.status).toBe(400);
      expect(r.corpo.mensagem).toContain("própria conta");
      expect((await gestor("PUT", `/usuarios/${eu}`, { nome: "Gestora" })).status).toBe(200);
      expect((await gestor("PUT", `/usuarios/${eu}`, {})).status).toBe(400);
      expect((await gestor("PUT", "/usuarios/xx", { ativo: true })).status).toBe(400);
      expect(
        (await gestor("PUT", `/usuarios/${crypto.randomUUID()}`, { ativo: true })).status,
      ).toBe(404);
    });
  });

  describe("POST /usuarios/:id/convite", () => {
    it("reenvia, atualiza convidado_em e grava o vínculo", async () => {
      const id = await idUsuario(p, "marcos.pires@scoutvela.dev");
      const r = await gestor("POST", `/usuarios/${id}/convite`);
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({ convite: "enviado" });
      expect(admin.convites[0]).toMatchObject({
        email: "marcos.pires@scoutvela.dev",
        redirectTo: "http://localhost:8080/redefinir-senha",
      });
      const row = (
        await p.db.query<{ auth_user_id: string; convidado_em: Date }>(
          "select auth_user_id, convidado_em from usuarios where id = $1",
          [id],
        )
      ).rows[0]!;
      expect(row.auth_user_id).toBe(admin.convites[0]!.authUserId);
      expect(row.convidado_em).toBeInstanceOf(Date);
    });

    it("e-mail que já tem conta -> 409 mandando usar Esqueci a senha", async () => {
      admin.contasExistentes.add(EMAILS_DEMO.treinadora);
      const r = await gestor(
        "POST",
        `/usuarios/${await idUsuario(p, EMAILS_DEMO.treinadora)}/convite`,
      );
      expect(r.status).toBe(409);
      expect(r.corpo.mensagem).toContain("Esqueci a senha");
    });

    it("sem adminAuth -> 503; inexistente -> 404; falha do Auth -> 503", async () => {
      const r = await chamar(
        semAdmin,
        EMAILS_DEMO.gestor,
        "POST",
        `/usuarios/${await idUsuario(semAdmin, EMAILS_DEMO.ibvar)}/convite`,
      );
      expect(r.status).toBe(503);
      expect(r.corpo.erro).toBe("servico_indisponivel");
      expect((await gestor("POST", `/usuarios/${crypto.randomUUID()}/convite`)).status).toBe(404);
      admin.falhar = true;
      expect(
        (await gestor("POST", `/usuarios/${await idUsuario(p, EMAILS_DEMO.ibvar)}/convite`)).status,
      ).toBe(503);
    });
  });

  describe("PUT /atletas/:id", () => {
    it("troca classe, treinador e número de vela; audita só nomes de campo", async () => {
      const id = await p.idDe("SC-T01");
      const marcos = await idUsuario(p, "marcos.pires@scoutvela.dev");
      const r = await gestor("PUT", `/atletas/${id}`, {
        classeId: "ilca6",
        treinadorId: marcos,
        numeroVela: " BRA 1766 ",
      });
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({
        id,
        classeId: "ilca6",
        treinadorId: marcos,
        numeroVela: "BRA 1766",
        ativo: true,
      });
      expect((await auditoria("editar_atleta")).at(-1)!.detalhes).toEqual({
        campos: ["classeId", "treinadorId", "numeroVela"],
      });
      const limpa = await gestor("PUT", `/atletas/${id}`, { numeroVela: "" });
      expect(limpa.corpo.numeroVela).toBeNull();
      expect(limpa.corpo.classeId).toBe("ilca6");
    });

    it("classe inativa/inexistente e treinador inválido -> 400; atleta inexistente -> 404; vazio -> 400", async () => {
      const id = await p.idDe("SC-T01");
      expect((await gestor("PUT", `/atletas/${id}`, { classeId: "nao-existe" })).status).toBe(400);
      await p.db.query("update classes set ativa = false where id = 'ilca7'");
      const inativa = await gestor("PUT", `/atletas/${id}`, { classeId: "ilca7" });
      await p.db.query("update classes set ativa = true where id = 'ilca7'");
      expect(inativa.status).toBe(400);
      expect(inativa.corpo.mensagem).toBe("Classe inválida ou inativa.");
      const ibvar = await idUsuario(p, EMAILS_DEMO.ibvar);
      expect((await gestor("PUT", `/atletas/${id}`, { treinadorId: ibvar })).status).toBe(400);
      expect(
        (await gestor("PUT", `/atletas/${id}`, { treinadorId: crypto.randomUUID() })).status,
      ).toBe(400);
      expect(
        (await gestor("PUT", `/atletas/${crypto.randomUUID()}`, { ativo: false })).status,
      ).toBe(404);
      expect((await gestor("PUT", `/atletas/${id}`, {})).status).toBe(400);
    });

    it("desativa e reativa o atleta", async () => {
      const id = await p.idDe("RJ-T03");
      expect((await gestor("PUT", `/atletas/${id}`, { ativo: false })).corpo.ativo).toBe(false);
      expect((await gestor("PUT", `/atletas/${id}`, { ativo: true })).corpo.ativo).toBe(true);
    });
  });
});

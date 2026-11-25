import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { criarProvedorEmailMemoria, type MensagemEmail } from "../../src/email/index.js";
import { criarAdminAuthFalso, type AdminAuthFalso } from "../apoio/app.js";
import { EMAILS_DEMO, criarPiloto } from "../apoio/piloto.js";
import type { Piloto } from "../apoio/piloto.js";

const AGORA = () => new Date("2026-11-06T12:00:00-03:00");

describe("POST /atletas com conta e e-mail do termo", () => {
  let p: Piloto;
  let admin: AdminAuthFalso;
  let emails: ReturnType<typeof criarProvedorEmailMemoria>;
  let semAdmin: Piloto;
  let emailsSemAdmin: ReturnType<typeof criarProvedorEmailMemoria>;

  beforeAll(async () => {
    admin = criarAdminAuthFalso();
    emails = criarProvedorEmailMemoria();
    p = await criarPiloto(AGORA, { adminAuth: admin, email: emails });
    emailsSemAdmin = criarProvedorEmailMemoria();
    semAdmin = await criarPiloto(AGORA, { email: emailsSemAdmin });
  });
  afterAll(async () => {
    await p.encerrar();
    await semAdmin.encerrar();
  });

  const cadastrar = async (alvo: Piloto, extra: Record<string, unknown> = {}) => {
    const treinadorId = (
      await alvo.db.query<{ id: string }>("select id from usuarios where email = $1", [
        EMAILS_DEMO.treinadora,
      ])
    ).rows[0]!.id;
    const r = await alvo.app.inject({
      method: "POST",
      url: "/atletas",
      headers: await alvo.como(EMAILS_DEMO.gestor),
      payload: {
        wsId: "BRARB51",
        email: "renata@exemplo.com",
        classeId: "ilca7",
        treinadorId,
        confirmaMaioridade: true,
        ...extra,
      },
    });
    return { status: r.statusCode, corpo: r.json() };
  };
  const usuarioDe = async (alvo: Piloto, email: string) =>
    (
      await alvo.db.query<{
        id: string;
        papel: string;
        atleta_id: string | null;
        auth_user_id: string | null;
        convidado_em: Date | null;
      }>("select id, papel, atleta_id, auth_user_id, convidado_em from usuarios where email = $1", [
        email,
      ])
    ).rows[0];

  it("cria a conta de atleta, convida e envia o e-mail do termo; resposta compatível + conta", async () => {
    const { status, corpo } = await cadastrar(p);
    expect(status).toBe(201);
    expect(corpo).toEqual({
      id: expect.any(String),
      wsId: "BRARB51",
      velaid: null,
      cadastroCompleto: false,
      termo: { status: "aguardando_aceite", versao: "Piloto 18+ · v1" },
      conta: "convite_enviado",
    });
    const u = (await usuarioDe(p, "renata@exemplo.com"))!;
    expect(u).toMatchObject({ papel: "atleta", atleta_id: corpo.id });
    expect(u.auth_user_id).toBe(admin.convites[0]!.authUserId);
    expect(u.convidado_em).toBeInstanceOf(Date);
    expect(admin.convites[0]).toMatchObject({
      email: "renata@exemplo.com",
      redirectTo: "http://localhost:8080/redefinir-senha",
    });

    expect(emails.enviadas).toHaveLength(1);
    const m: MensagemEmail = emails.enviadas[0]!;
    expect(m.para).toBe("renata@exemplo.com");
    expect(m.texto).toContain("http://localhost:8080");
    expect(m.texto).toContain("Piloto 18+ · v1");
    expect(m.texto).toContain("complete seu cadastro");

    const aud = await p.db.query<{ acao: string; detalhes: unknown }>(
      "select acao, detalhes from auditoria where acao in ('criar_usuario', 'convidar_usuario') order by id",
    );
    expect(aud.rows.map((a) => a.acao)).toEqual(["criar_usuario", "convidar_usuario"]);
    expect(JSON.stringify(aud.rows)).not.toContain("exemplo.com");
  });

  it("criarConta=false: só cadastra, sem usuário nem convite, mas o e-mail do termo vai", async () => {
    const antes = emails.enviadas.length;
    const { status, corpo } = await cadastrar(p, {
      wsId: "BRAFG77",
      email: "felipe@exemplo.com",
      criarConta: false,
    });
    expect(status).toBe(201);
    expect(corpo.conta).toBe("sem_email");
    expect(await usuarioDe(p, "felipe@exemplo.com")).toBeUndefined();
    expect(emails.enviadas).toHaveLength(antes + 1);
    expect(emails.enviadas.at(-1)!.para).toBe("felipe@exemplo.com");
  });

  it("a conta nasce com nome provisório (parte local do e-mail)", async () => {
    const { status, corpo } = await cadastrar(p, {
      wsId: "BRAXY12",
      email: "Maria.Souza@Exemplo.com",
    });
    expect(status).toBe(201);
    const u = (await usuarioDe(p, "maria.souza@exemplo.com"))!;
    expect(u).toMatchObject({ papel: "atleta", atleta_id: corpo.id });
    const nome = (
      await p.db.query<{ nome: string }>("select nome from usuarios where id = $1", [u.id])
    ).rows[0]!.nome;
    expect(nome).toBe("maria.souza");
  });

  it("e-mail já usado por outro usuário: cadastra o atleta sem criar conta", async () => {
    const { status, corpo } = await cadastrar(p, { wsId: "BRADUP1", email: EMAILS_DEMO.ibvar });
    expect(status).toBe(201);
    expect(corpo.conta).toBe("sem_email");
    expect(
      (await p.db.query("select 1 from usuarios where atleta_id = $1", [corpo.id])).rows,
    ).toHaveLength(0);
  });

  it("sem adminAuth: usuário criado, conta indisponivel; o termo ainda é enviado", async () => {
    const { status, corpo } = await cadastrar(semAdmin);
    expect(status).toBe(201);
    expect(corpo.conta).toBe("indisponivel");
    expect(await usuarioDe(semAdmin, "renata@exemplo.com")).toMatchObject({
      papel: "atleta",
      auth_user_id: null,
      convidado_em: null,
    });
    expect(emailsSemAdmin.enviadas).toHaveLength(1);
  });

  it("e-mail que já tem conta no Auth: indisponivel (login será vinculado pelo e-mail)", async () => {
    admin.contasExistentes.add("existente@exemplo.com");
    const { corpo } = await cadastrar(p, { wsId: "BRAEX99", email: "existente@exemplo.com" });
    expect(corpo.conta).toBe("indisponivel");
  });

  it("falha no envio do e-mail do termo não desfaz o cadastro", async () => {
    const falho = await criarPiloto(AGORA, {
      email: {
        async enviar() {
          throw new Error("smtp fora do ar");
        },
      },
    });
    try {
      const { status, corpo } = await cadastrar(falho);
      expect(status).toBe(201);
      expect(corpo.termo.status).toBe("aguardando_aceite");
    } finally {
      await falho.encerrar();
    }
  });
});

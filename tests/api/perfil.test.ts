import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../../src/db/db.js";
import type { Papel } from "../../src/domain/tipos.js";
import {
  cabecalhoAuth,
  criarAppDeTeste,
  criarAtletaDeTeste,
  criarUsuarioDeTeste,
  tokenPara,
  type UsuarioDeTeste,
} from "../apoio/app.js";
import { criarArmazenamentoFake, type ArmazenamentoFake } from "../apoio/armazenamento.js";
import { criarBancoDeTeste } from "../apoio/banco.js";
import { jpegValido, pngValido } from "../apoio/imagens.js";
import { EMAILS_DEMO, criarPiloto, type Piloto } from "../apoio/piloto.js";

const jpeg = (tamanho = 64) =>
  tamanho > 1024 * 1024
    ? Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(tamanho - 4)]) // só p/ o teste de tamanho
    : jpegValido({ tamanho });
const png = () => pngValido({ tamanho: 64 });

describe("perfil do usuário (/me/perfil e /me/foto)", () => {
  let db: Db;
  let app: FastifyInstance;
  let armazenamento: ArmazenamentoFake;

  beforeAll(async () => {
    db = await criarBancoDeTeste();
    armazenamento = criarArmazenamentoFake();
    app = await criarAppDeTeste(db, { armazenamento });
  });
  afterAll(async () => {
    await app.close();
    await db.fechar();
  });

  const novo = (papel: Papel, nome?: string) =>
    criarUsuarioDeTeste(db, { papel, ...(nome ? { nome } : {}) });
  const chamar = async (
    u: UsuarioDeTeste,
    method: "GET" | "PUT" | "POST" | "DELETE",
    url: string,
    payload?: object,
    aal?: "aal1" | "aal2",
  ) => {
    const r = await app.inject({
      method,
      url,
      headers: cabecalhoAuth(await tokenPara(u.authUserId, aal ? { aal } : {})),
      ...(payload ? { payload } : {}),
    });
    return { status: r.statusCode, corpo: r.body ? r.json() : null };
  };
  const auditoria = async (usuarioId: string) =>
    (
      await db.query<{ acao: string; detalhes: Record<string, unknown> }>(
        `select acao, detalhes from auditoria where usuario_id = $1 order by id`,
        [usuarioId],
      )
    ).rows;
  const fotoDe = async (usuarioId: string) =>
    (
      await db.query<{ foto_caminho: string | null }>(
        `select foto_caminho from usuarios where id = $1`,
        [usuarioId],
      )
    ).rows[0]!.foto_caminho;
  const enviarFoto = (u: UsuarioDeTeste, tipoMime: string, bytes: Buffer) =>
    chamar(u, "POST", "/me/foto", { tipoMime, conteudoBase64: bytes.toString("base64") });

  describe("GET /me/perfil", () => {
    it("gestor: dados comuns, sem foto, mfaAtivo pela sessão", async () => {
      const u = await novo("gestor", "Gestora Teste");
      const r = await chamar(u, "GET", "/me/perfil");
      expect(r.status).toBe(200);
      expect(r.corpo).toEqual({
        nome: "Gestora Teste",
        email: expect.stringMatching(/@teste\.dev$/),
        papel: "gestor",
        fotoUrl: null,
        mfaAtivo: false,
        atleta: null,
        treinador: null,
      });
      expect((await chamar(u, "GET", "/me/perfil", undefined, "aal2")).corpo.mfaAtivo).toBe(true);
    });

    it("treinador: quantidade de atletas ativos sob sua responsabilidade", async () => {
      const t = await novo("treinador");
      for (const ativo of [true, true, false]) {
        const id = await criarAtletaDeTeste(db);
        await db.query(`update atletas set treinador_id = $1, ativo = $2 where id = $3`, [
          t.id,
          ativo,
          id,
        ]);
      }
      const r = await chamar(t, "GET", "/me/perfil");
      expect(r.corpo.treinador).toEqual({ quantidadeAtletas: 2 });
      expect(r.corpo.atleta).toBeNull();
    });

    it("atleta: dados de cadastro, termo e consentimento do IBVAR", async () => {
      const t = await novo("treinador", "Treinador do Atleta");
      const a = await novo("atleta", "Atleta Perfil");
      await db.query(
        `update atletas set treinador_id = $1, clube = 'Clube X', cidade = 'Niterói', uf = 'RJ',
                numero_vela = 'BRA 7', email_contato = 'contato@exemplo.dev' where id = $2`,
        [t.id, a.atletaId],
      );
      await db.query(
        `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
         values ($1, 'termo_piloto', true, 'v1', '2026-10-01T12:00:00Z', $2),
                ($1, 'compartilhar_ibvar', true, 'v1', '2026-10-01T12:00:00Z', $2)`,
        [a.atletaId, a.id],
      );
      const r = await chamar(a, "GET", "/me/perfil");
      expect(r.status).toBe(200);
      expect(r.corpo.atleta).toEqual({
        velaid: expect.stringMatching(/^VELA-/),
        classe: { id: "classe_teste", nome: "Classe Teste" },
        numeroVela: "BRA 7",
        dataNascimento: "2000-01-01",
        clube: "Clube X",
        cidade: "Niterói",
        uf: "RJ",
        treinador: { id: t.id, nome: "Treinador do Atleta" },
        emailContato: "contato@exemplo.dev",
        termoAceitoEm: "2026-10-01T12:00:00.000Z",
        compartilharIbvar: true,
      });
      expect(r.corpo.treinador).toBeNull();
    });

    it("IBVAR recebe 403 em todas as rotas de perfil", async () => {
      const u = await novo("ibvar");
      expect((await chamar(u, "GET", "/me/perfil")).status).toBe(403);
      expect((await chamar(u, "PUT", "/me/perfil", { nome: "Outro" })).status).toBe(403);
      expect((await enviarFoto(u, "image/jpeg", jpeg())).status).toBe(403);
      expect((await chamar(u, "DELETE", "/me/foto")).status).toBe(403);
    });
  });

  describe("PUT /me/perfil", () => {
    it("treinador e gestor editam o nome; auditoria só com o nome do campo", async () => {
      for (const papel of ["treinador", "gestor"] as const) {
        const u = await novo(papel);
        const r = await chamar(u, "PUT", "/me/perfil", { nome: "  Nome Novo  " });
        expect(r.status).toBe(200);
        expect(r.corpo.nome).toBe("Nome Novo");
        expect(await auditoria(u.id)).toEqual([
          { acao: "editar_perfil", detalhes: { campos: ["nome"] } },
        ]);
      }
    });

    it("atleta edita o e-mail de contato; o valor não vai para a auditoria", async () => {
      const a = await novo("atleta");
      const r = await chamar(a, "PUT", "/me/perfil", { emailContato: "novo@exemplo.dev" });
      expect(r.status).toBe(200);
      expect(r.corpo.atleta.emailContato).toBe("novo@exemplo.dev");
      const log = await auditoria(a.id);
      expect(log).toEqual([{ acao: "editar_perfil", detalhes: { campos: ["emailContato"] } }]);
      expect(JSON.stringify(log)).not.toContain("novo@exemplo.dev");
    });

    it("recusa campo de outro papel, dado do VelaID, corpo vazio e valores inválidos", async () => {
      const a = await novo("atleta");
      const g = await novo("gestor");
      const casos: [UsuarioDeTeste, object][] = [
        [a, { nome: "Trocar Nome" }],
        [g, { emailContato: "x@exemplo.dev" }],
        [a, { clube: "Outro clube" }],
        [a, { emailContato: "nao-e-email" }],
        [g, {}],
        [g, { nome: "A" }],
        [g, { nome: "x".repeat(121) }],
      ];
      for (const [u, corpo] of casos) {
        const r = await chamar(u, "PUT", "/me/perfil", corpo);
        expect(r.status, JSON.stringify(corpo)).toBe(400);
      }
      expect(await auditoria(a.id)).toEqual([]);
    });
  });

  describe("POST e DELETE /me/foto", () => {
    it("envia, troca (removendo a anterior) e aparece em GET /me e no perfil", async () => {
      const u = await novo("treinador");
      const r1 = await enviarFoto(u, "image/jpeg", jpeg());
      expect(r1.status).toBe(200);
      const primeira = await fotoDe(u.id);
      expect(primeira).toMatch(new RegExp(`^fotos/${u.id}/[0-9a-f-]{36}\\.jpg$`));
      expect(r1.corpo.fotoUrl).toContain(primeira);
      expect(armazenamento.arquivos.get(primeira!)?.tipoMime).toBe("image/jpeg");

      const r2 = await enviarFoto(u, "image/png", png());
      expect(r2.status).toBe(200);
      const segunda = await fotoDe(u.id);
      expect(segunda).toMatch(/\.png$/);
      expect(armazenamento.arquivos.has(primeira!)).toBe(false);
      expect(armazenamento.arquivos.has(segunda!)).toBe(true);

      expect((await chamar(u, "GET", "/me")).corpo.usuario.fotoUrl).toContain(segunda);
      expect((await chamar(u, "GET", "/me/perfil")).corpo.fotoUrl).toContain(segunda);
      expect((await auditoria(u.id)).map((x) => x.detalhes)).toEqual([
        { tipoMime: "image/jpeg", tamanhoBytes: 64 },
        { tipoMime: "image/png", tamanhoBytes: 64 },
      ]);
    });

    it("recusa arquivo grande, tipo fora da lista e assinatura que não bate", async () => {
      const u = await novo("gestor");
      const grande = await enviarFoto(u, "image/jpeg", jpeg(2 * 1024 * 1024 + 1));
      expect(grande.status).toBe(400);
      expect(grande.corpo.mensagem).toBe("A foto passa de 2 MB.");
      expect((await enviarFoto(u, "application/pdf", jpeg())).status).toBe(400);
      expect((await enviarFoto(u, "image/jpeg", png())).status).toBe(400);
      expect(await fotoDe(u.id)).toBeNull();
    });

    it("Storage fora do ar: 503 e nada muda no banco", async () => {
      const u = await novo("gestor");
      armazenamento.falhar = true;
      const r = await enviarFoto(u, "image/jpeg", jpeg());
      armazenamento.falhar = false;
      expect(r.status).toBe(503);
      expect(await fotoDe(u.id)).toBeNull();
      expect(await auditoria(u.id)).toEqual([]);
    });

    it("limite de 10 envios por minuto por usuário", async () => {
      const u = await novo("gestor");
      const outro = await novo("gestor");
      for (let i = 0; i < 10; i++) {
        expect((await enviarFoto(u, "image/jpeg", png())).status).toBe(400);
      }
      expect((await enviarFoto(u, "image/jpeg", png())).status).toBe(429);
      expect((await enviarFoto(outro, "image/jpeg", png())).status).toBe(400);
    });

    it("DELETE remove do Storage e do banco; sem foto responde 204", async () => {
      const u = await novo("atleta");
      await enviarFoto(u, "image/jpeg", jpeg());
      const caminho = (await fotoDe(u.id))!;
      const r = await chamar(u, "DELETE", "/me/foto");
      expect(r).toEqual({ status: 204, corpo: null });
      expect(await fotoDe(u.id)).toBeNull();
      expect(armazenamento.arquivos.has(caminho)).toBe(false);
      expect((await chamar(u, "DELETE", "/me/foto")).status).toBe(204);
      expect((await auditoria(u.id)).map((x) => x.acao)).toEqual(["enviar_foto", "remover_foto"]);
    });
  });
});

describe("foto do atleta na ficha (GET /atletas/:id)", () => {
  let p: Piloto;
  beforeAll(async () => {
    p = await criarPiloto();
  });
  afterAll(() => p.encerrar());

  const fotoNaFicha = async (email: string, atletaId: string) => {
    const r = await p.app.inject({
      method: "GET",
      url: `/atletas/${atletaId}`,
      headers: await p.como(email),
    });
    expect(r.statusCode).toBe(200);
    return r.json().atleta.fotoUrl as string | null;
  };

  it("gestor, treinador do atleta e o próprio atleta veem; IBVAR, não", async () => {
    const conta = await p.db.query<{ atleta_id: string }>(
      `select atleta_id from usuarios where email = $1`,
      [EMAILS_DEMO.atleta],
    );
    const atletaId = conta.rows[0]!.atleta_id;
    const foto = `fotos/${crypto.randomUUID()}/${crypto.randomUUID()}.jpg`;
    await p.db.query(`update usuarios set foto_caminho = $1 where email = $2`, [
      foto,
      EMAILS_DEMO.atleta,
    ]);
    await p.db.query(
      `update atletas set treinador_id = (select id from usuarios where email = $1) where id = $2`,
      [EMAILS_DEMO.treinadora, atletaId],
    );
    await p.db.query(
      `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_por)
       values ($1, 'compartilhar_ibvar', true, 'v1', (select id from usuarios where email = $2))`,
      [atletaId, EMAILS_DEMO.atleta],
    );

    for (const email of [EMAILS_DEMO.gestor, EMAILS_DEMO.treinadora, EMAILS_DEMO.atleta]) {
      expect(await fotoNaFicha(email, atletaId)).toContain(foto);
    }
    expect(await fotoNaFicha(EMAILS_DEMO.ibvar, atletaId)).toBeNull();
  });

  it("atleta sem conta ou sem foto: nulo", async () => {
    expect(await fotoNaFicha(EMAILS_DEMO.gestor, await p.idDe("SP-T08"))).toBeNull();
  });
});

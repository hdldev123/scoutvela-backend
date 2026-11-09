import type { FastifyInstance } from "fastify";
import { semear } from "../../seed/semear.js";
import type { Db } from "../../src/db/db.js";
import { cabecalhoAuth, criarAppDeTeste, tokenPara } from "./app.js";
import { criarArmazenamentoFake, type ArmazenamentoFake } from "./armazenamento.js";
import { criarBancoDeTeste } from "./banco.js";

export const EMAILS_DEMO = {
  gestor: "gestor@scoutvela.dev",
  treinadora: "treinadora@scoutvela.dev",
  atleta: "atleta@scoutvela.dev",
  ibvar: "ibvar@scoutvela.dev",
} as const;

export interface Piloto {
  db: Db;
  app: FastifyInstance;
  armazenamento: ArmazenamentoFake;
  /** Cabeçalho de autenticação do usuário do seed. */
  como(email: string): Promise<{ authorization: string }>;
  /** id do atleta pelo código VelaID (ex.: SP-T07). */
  idDe(velaid: string): Promise<string>;
  encerrar(): Promise<void>;
}

/** Banco de teste com o seed do protótipo e as contas do seed vinculadas a UUIDs de login. */
export async function criarPiloto(agora?: () => Date): Promise<Piloto> {
  const db = await criarBancoDeTeste();
  await semear(db);
  const auth = new Map<string, string>();
  for (const email of Object.values(EMAILS_DEMO)) {
    const id = crypto.randomUUID();
    auth.set(email, id);
    await db.query("update usuarios set auth_user_id = $1 where email = $2", [id, email]);
  }
  const armazenamento = criarArmazenamentoFake();
  const app = await criarAppDeTeste(db, { armazenamento, ...(agora ? { agora } : {}) });
  return {
    db,
    app,
    armazenamento,
    async como(email) {
      return cabecalhoAuth(await tokenPara(auth.get(email)!));
    },
    async idDe(velaid) {
      const r = await db.query<{ id: string }>("select id from atletas where velaid_codigo = $1", [velaid]);
      return r.rows[0]!.id;
    },
    async encerrar() {
      await app.close();
      await db.fechar();
    },
  };
}

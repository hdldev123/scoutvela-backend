import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";
import type { Db } from "../db/db.js";
import type { Papel } from "../domain/tipos.js";
import { naoAutenticado, semAcesso } from "../erros.js";
import { buscarUsuarioPorAuthId } from "../repositories/usuarios.js";
import { acessoDoPapel } from "./acesso.js";
import type { VerificadorToken } from "./jwt.js";

export interface UsuarioAutenticado {
  id: string;
  authUserId: string;
  nome: string;
  email: string;
  papel: Papel;
  atletaId: string | null;
}

declare module "fastify" {
  interface FastifyInstance {
    db: Db;
    agora: () => Date;
    /** preHandler: exige token válido e usuário cadastrado e ativo. */
    autenticar: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
  interface FastifyRequest {
    usuario: UsuarioAutenticado;
  }
}

/** Log estruturado de acesso negado. Nunca registra token, cabeçalhos, e-mail nem corpo. */
function logarAcessoNegado(req: FastifyRequest, motivo: string, usuario?: { id: string; papel: Papel }): void {
  req.log.warn(
    {
      evento: "acesso_negado",
      motivo,
      rota: req.routeOptions.url,
      metodo: req.method,
      ...(usuario ? { usuarioId: usuario.id, papel: usuario.papel } : {}),
    },
    "acesso negado",
  );
}

/** Registra `app.autenticar` e `request.usuario` (sem encapsulamento: vale para todas as rotas). */
export function registrarAutenticacao(app: FastifyInstance, verificarToken: VerificadorToken): void {
  app.decorateRequest("usuario");

  app.decorate("autenticar", async (req: FastifyRequest) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? "");
    if (!m?.[1]) {
      logarAcessoNegado(req, "token_ausente");
      throw naoAutenticado();
    }

    let sub: string;
    try {
      ({ sub } = await verificarToken(m[1]));
    } catch {
      logarAcessoNegado(req, "token_invalido");
      throw naoAutenticado("Sessão inválida ou expirada.");
    }

    const u = await buscarUsuarioPorAuthId(app.db, sub);
    if (!u) {
      logarAcessoNegado(req, "sem_cadastro");
      throw semAcesso();
    }
    if (!u.ativo || !acessoDoPapel(u.papel)) {
      logarAcessoNegado(req, u.ativo ? "papel_sem_acesso" : "usuario_inativo", u);
      throw semAcesso();
    }

    req.usuario = {
      id: u.id,
      authUserId: u.authUserId,
      nome: u.nome,
      email: u.email,
      papel: u.papel,
      atletaId: u.atletaId,
    };
  });
}

/** preHandler que libera só os papéis listados. Use depois de `app.autenticar`. */
export function exigirPapel(...papeis: Papel[]): preHandlerAsyncHookHandler {
  return async (req) => {
    if (!papeis.includes(req.usuario.papel)) {
      logarAcessoNegado(req, "papel_nao_permitido", req.usuario);
      throw semAcesso();
    }
  };
}

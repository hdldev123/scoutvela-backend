import type { FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { z } from "zod";

export const codigosDeErro = [
  "nao_autenticado",
  "sem_acesso",
  "nao_encontrado",
  "requisicao_invalida",
  "erro_interno",
  "limite_excedido",
] as const;
export type CodigoDeErro = (typeof codigosDeErro)[number];

/** Formato único de erro da API. As rotas usam este schema para documentar 4xx/5xx. */
export const esquemaErro = z.object({
  erro: z.enum(codigosDeErro),
  mensagem: z.string(),
});

/** Erro esperado, com status e mensagem seguros para o cliente. */
export class ErroApi extends Error {
  constructor(
    readonly status: number,
    readonly codigo: CodigoDeErro,
    mensagem: string,
  ) {
    super(mensagem);
  }
}

export const naoAutenticado = (m = "Faça login para continuar.") => new ErroApi(401, "nao_autenticado", m);
export const semAcesso = (m = "Você não tem acesso a este recurso.") => new ErroApi(403, "sem_acesso", m);
export const naoEncontrado = (m = "Recurso não encontrado.") => new ErroApi(404, "nao_encontrado", m);

export function registrarTratamentoDeErros(app: FastifyInstance): void {
  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send({ erro: "nao_encontrado", mensagem: "Rota não encontrada." });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ErroApi) {
      return reply.code(err.status).send({ erro: err.codigo, mensagem: err.message });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.code(400).send({ erro: "requisicao_invalida", mensagem: "Requisição inválida." });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 429) {
      return reply.code(429).send({ erro: "limite_excedido", mensagem: "Muitas requisições. Aguarde um pouco e tente de novo." });
    }
    // Erros 4xx do próprio Fastify (JSON malformado, corpo grande demais etc.).
    if (typeof status === "number" && status >= 400 && status < 500) {
      return reply.code(status).send({ erro: "requisicao_invalida", mensagem: "Requisição inválida." });
    }
    // Loga só o erro (sem cabeçalhos nem corpo); o cliente não recebe detalhes.
    req.log.error({ err }, "erro interno");
    return reply.code(500).send({ erro: "erro_interno", mensagem: "Erro interno. Tente novamente mais tarde." });
  });
}

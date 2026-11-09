import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import Fastify, { type FastifyInstance } from "fastify";
import { jsonSchemaTransform, serializerCompiler, validatorCompiler } from "fastify-type-provider-zod";
import pacote from "../package.json" with { type: "json" };
import type { VerificadorToken } from "./auth/jwt.js";
import { registrarAutenticacao } from "./auth/plugin.js";
import type { Config } from "./config.js";
import type { Db } from "./db/db.js";
import { criarProvedorEmailLog, type ProvedorEmail } from "./email/index.js";
import { registrarTratamentoDeErros } from "./erros.js";
import { rotasHealth } from "./routes/health.js";
import { rotasAtletas } from "./routes/atletas.js";
import { rotasAuditoria } from "./routes/auditoria.js";
import { rotasAvaliacoes } from "./routes/avaliacoes.js";
import { rotasCadastro } from "./routes/cadastro.js";
import { rotasCampanha } from "./routes/campanha.js";
import { rotasCiclos } from "./routes/ciclos.js";
import { rotasInvestimento } from "./routes/investimento.js";
import { rotasMe } from "./routes/me.js";
import { rotasPainel } from "./routes/painel.js";
import { rotasParametros } from "./routes/parametros.js";
import { rotasRanking } from "./routes/ranking.js";

export interface DepsApp {
  db: Db;
  config: Config;
  verificarToken: VerificadorToken;
  agora?: () => Date;
  /** Passe false nos testes para não poluir a saída. */
  logger?: boolean;
  /** Limite global por IP. Padrão: 300 requisições por minuto. */
  limiteRequisicoes?: { max: number; janelaMs: number };
  /** Provedor de e-mail. Padrão: provedor `log` (não envia). O server.ts escolhe pela config. */
  email?: ProvedorEmail;
}

declare module "fastify" {
  interface FastifyInstance {
    config: Config;
    email: ProvedorEmail;
  }
}

type PluginDeRotas = (app: FastifyInstance) => Promise<void>;

/**
 * Rotas da API. PONTO DE EXTENSÃO: para criar uma rota nova, escreva
 * `export async function rotasXxx(app: FastifyInstance)` em src/routes/xxx.ts
 * e acrescente aqui .
 * Rota protegida: `preHandler: [app.autenticar, exigirPapel(...)]` e `schema` zod
 * (o schema vira OpenAPI). Use `app.db`, `app.agora`, `app.config` e `app.email`.
 */
const PLUGINS_DE_ROTAS: PluginDeRotas[] = [
  rotasHealth,
  rotasMe,
  rotasRanking,
  rotasAtletas,
  rotasAvaliacoes,
  rotasCadastro,
  rotasPainel,
  rotasInvestimento,
  rotasParametros,
  rotasCiclos,
  rotasCampanha,
  rotasAuditoria,
];

export async function criarApp(deps: DepsApp): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    trustProxy: true, // atrás do proxy do Render: IP real do cliente
    bodyLimit: 1024 * 1024,
    logger:
      deps.logger === false
        ? false
        : {
            level: "info",
            // Nunca registrar credenciais. O corpo da requisição não é logado.
            redact: ["req.headers.authorization", "req.headers.cookie"],
          },
  });

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registrarTratamentoDeErros(app);

  app.decorate("db", deps.db);
  app.decorate("config", config);
  app.decorate("email", deps.email ?? criarProvedorEmailLog(app.log));
  app.decorate("agora", deps.agora ?? (() => new Date()));
  registrarAutenticacao(app, deps.verificarToken);

  // API só JSON: CSP restritiva. O /docs (só fora de produção) ganha CSP própria do swagger-ui.
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
    strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
  });
  await app.register(rateLimit, {
    global: true,
    max: deps.limiteRequisicoes?.max ?? 300,
    timeWindow: deps.limiteRequisicoes?.janelaMs ?? 60_000,
  });

  await app.register(cors, {
    origin: config.CORS_ORIGINS,
    methods: ["GET", "POST", "PUT"],
    allowedHeaders: ["Authorization", "Content-Type"],
  });

  await app.register(swagger, {
    openapi: {
      info: { title: "Scout Vela API", version: pacote.version },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer", bearerFormat: "JWT" } },
      },
    },
    transform: jsonSchemaTransform,
  });
  if (config.APP_ENV !== "producao") {
    await app.register(swaggerUi, { routePrefix: "/docs", staticCSP: true });
  }

  for (const plugin of PLUGINS_DE_ROTAS) await app.register(plugin);

  return app;
}

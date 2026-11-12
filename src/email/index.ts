/**
 * Envio de e-mail. As rotas e os jobs usam só a interface `ProvedorEmail`
 * (`app.email` nas rotas); o provedor concreto vem da config (`EMAIL_PROVEDOR`).
 *
 * PONTO DE EXTENSÃO: provedor novo = função que devolve `ProvedorEmail`,
 * escolhida em `criarProvedorEmail`.
 */

import type { Config } from "../config.js";
import { criarProvedorEmailSmtp } from "./smtp.js";

export interface MensagemEmail {
  para: string;
  assunto: string;
  /** Texto puro, sempre presente (cliente sem HTML e leitores de tela). */
  texto: string;
  html?: string;
}

export interface ProvedorEmail {
  enviar(mensagem: MensagemEmail): Promise<void>;
}

/** Logger mínimo (o do Fastify/pino serve). */
export interface LoggerEmail {
  info(obj: Record<string, unknown>, msg: string): void;
}

/**
 * Provedor de desenvolvimento e testes: não envia nada, só registra que houve envio.
 * Não loga o endereço nem o corpo (logs sem dado pessoal).
 */
export function criarProvedorEmailLog(log: LoggerEmail): ProvedorEmail {
  return {
    enviar(m) {
      log.info(
        { evento: "email_registrado", assunto: m.assunto, dominio: m.para.split("@")[1] ?? null },
        "e-mail (provedor log)",
      );
      return Promise.resolve();
    },
  };
}

/** Provedor que guarda as mensagens em memória. Só para testes. */
export function criarProvedorEmailMemoria(): ProvedorEmail & { enviadas: MensagemEmail[] } {
  const enviadas: MensagemEmail[] = [];
  return {
    enviadas,
    enviar(m) {
      enviadas.push(m);
      return Promise.resolve();
    },
  };
}

/** Escolhe o provedor pela config: `log` (padrão) ou `smtp`. */
export function criarProvedorEmail(
  config: Pick<
    Config,
    "EMAIL_PROVEDOR" | "EMAIL_REMETENTE" | "SMTP_HOST" | "SMTP_PORT" | "SMTP_USUARIO" | "SMTP_SENHA"
  >,
  log: LoggerEmail,
): ProvedorEmail {
  if (config.EMAIL_PROVEDOR === "log") return criarProvedorEmailLog(log);
  if (!config.SMTP_HOST) throw new Error("SMTP_HOST é obrigatório com EMAIL_PROVEDOR=smtp.");
  return criarProvedorEmailSmtp({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    usuario: config.SMTP_USUARIO,
    senha: config.SMTP_SENHA,
    remetente: config.EMAIL_REMETENTE,
  });
}

/** Logger JSON de uma linha no stdout, para o server.ts e os jobs (antes ou fora do Fastify). */
export const loggerConsole: LoggerEmail = {
  info(obj, msg) {
    process.stdout.write(`${JSON.stringify({ level: "info", msg, ...obj })}\n`);
  },
};

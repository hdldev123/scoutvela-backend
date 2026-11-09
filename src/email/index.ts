/**
 * Envio de e-mail. As rotas e os jobs usam só a interface `ProvedorEmail`
 * (`app.email` nas rotas); o provedor concreto vem da config (`EMAIL_PROVEDOR`).
 *
 * PONTO DE EXTENSÃO: provedor novo = função que devolve `ProvedorEmail`,
 * escolhida em `criarProvedorEmail`.
 */

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
    async enviar(m) {
      log.info({ evento: "email_registrado", assunto: m.assunto, dominio: m.para.split("@")[1] ?? null }, "e-mail (provedor log)");
    },
  };
}

/** Provedor que guarda as mensagens em memória. Só para testes. */
export function criarProvedorEmailMemoria(): ProvedorEmail & { enviadas: MensagemEmail[] } {
  const enviadas: MensagemEmail[] = [];
  return {
    enviadas,
    async enviar(m) {
      enviadas.push(m);
    },
  };
}

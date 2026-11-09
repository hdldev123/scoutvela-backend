import nodemailer from "nodemailer";
import type { ProvedorEmail } from "./index.js";

export interface OpcoesSmtp {
  host: string;
  port: number;
  usuario?: string | undefined;
  senha?: string | undefined;
  remetente: string;
}

/**
 * Provedor SMTP (nodemailer). Porta 465 usa TLS direto; as demais exigem STARTTLS.
 * Falha de envio sobe como exceção (quem chama decide); a mensagem de erro não vai para o log aqui.
 */
export function criarProvedorEmailSmtp(opcoes: OpcoesSmtp): ProvedorEmail {
  const transporte = nodemailer.createTransport({
    host: opcoes.host,
    port: opcoes.port,
    secure: opcoes.port === 465,
    requireTLS: opcoes.port !== 465,
    ...(opcoes.usuario ? { auth: { user: opcoes.usuario, pass: opcoes.senha ?? "" } } : {}),
  });
  return {
    async enviar(m) {
      await transporte.sendMail({
        from: opcoes.remetente,
        to: m.para,
        subject: m.assunto,
        text: m.texto,
        ...(m.html ? { html: m.html } : {}),
      });
    },
  };
}

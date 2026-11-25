import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { acessoDoPapel } from "../auth/acesso.js";
import { esquemaErro, semAcesso } from "../erros.js";
import { buscarCadastroPendente } from "../repositories/cadastro-atleta.js";
import { buscarNomeDoAtleta } from "../repositories/usuarios.js";
import { caminhoDaFotoDoUsuario, linkDaFoto } from "../servicos/foto-perfil.js";

const esquemaMe = z.object({
  usuario: z.object({
    id: z.string(),
    nome: z.string(),
    email: z.string(),
    papel: z.enum(["gestor", "treinador", "atleta", "ibvar", "responsavel"]),
    fotoUrl: z.string().nullable().describe("Link assinado curto; nulo = sem foto"),
  }),
  atleta: z
    .object({
      id: z.string(),
      nome: z.string().nullable().describe("Nulo até o atleta completar o cadastro"),
    })
    .nullable(),
  cadastroPendente: z
    .object({
      wsId: z.string(),
      velaid: z.string().nullable(),
      sugestao: z
        .object({
          nome: z.string(),
          genero: z.enum(["F", "M"]).nullable().describe("Nulo se a World Sailing não informa"),
          dataNascimento: z
            .string()
            .nullable()
            .describe("AAAA-MM-DD; nula se a World Sailing não informa"),
        })
        .nullable()
        .describe(
          "Dados do VelaID ou, sem eles, do perfil da World Sailing, para o atleta confirmar ou corrigir; nula sem nenhum dos dois",
        ),
      origemSugestao: z
        .enum(["velaid", "world_sailing"])
        .nullable()
        .describe(
          "De onde veio a sugestão (o VelaID vale antes da World Sailing); nula sem sugestão",
        ),
    })
    .nullable()
    .describe(
      "Só para o atleta que ainda não completou o cadastro: ele informa nome, gênero e data de nascimento em PUT /me/cadastro antes do painel. Nulo nos demais casos.",
    ),
  telas: z.array(z.string()),
  telaInicial: z.string(),
});

export async function rotasMe(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/me",
    {
      preHandler: [app.autenticar],
      schema: {
        tags: ["sessao"],
        summary: "Quem sou eu: papel, telas liberadas e atleta vinculado",
        security: [{ bearerAuth: [] }],
        response: { 200: esquemaMe, 401: esquemaErro, 403: esquemaErro },
      },
    },
    async (req) => {
      const u = req.usuario;
      const acesso = acessoDoPapel(u.papel);
      if (!acesso) throw semAcesso();
      const atleta = u.atletaId ? await buscarNomeDoAtleta(app.db, u.atletaId) : null;
      const cadastroPendente = u.atletaId ? await buscarCadastroPendente(app.db, u.atletaId) : null;
      const caminho = await caminhoDaFotoDoUsuario(app.db, u.id);
      const fotoUrl = await linkDaFoto(app.armazenamento, caminho, req.log);
      return {
        usuario: { id: u.id, nome: u.nome, email: u.email, papel: u.papel, fotoUrl },
        atleta,
        cadastroPendente,
        telas: acesso.telas,
        telaInicial: acesso.telaInicial,
      };
    },
  );
}

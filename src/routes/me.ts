import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { acessoDoPapel } from "../auth/acesso.js";
import { esquemaErro, semAcesso } from "../erros.js";
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
  atleta: z.object({ id: z.string(), nome: z.string() }).nullable(),
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
      const caminho = await caminhoDaFotoDoUsuario(app.db, u.id);
      const fotoUrl = await linkDaFoto(app.armazenamento, caminho, req.log);
      return {
        usuario: { id: u.id, nome: u.nome, email: u.email, papel: u.papel, fotoUrl },
        atleta,
        telas: acesso.telas,
        telaInicial: acesso.telaInicial,
      };
    },
  );
}

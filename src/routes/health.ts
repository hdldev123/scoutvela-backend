import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

export async function rotasHealth(app: FastifyInstance): Promise<void> {
  app.withTypeProvider<ZodTypeProvider>().get(
    "/health",
    {
      config: { rateLimit: false },
      schema: {
        tags: ["sessao"],
        summary: "Verificação de saúde (sem autenticação, não toca dados)",
        response: { 200: z.object({ ok: z.literal(true) }) },
      },
    },
    () => ({ ok: true as const }),
  );
}

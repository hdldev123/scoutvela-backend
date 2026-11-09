/**
 * Contas de teste do piloto. Só para desenvolvimento e homologação, com dados
 * fictícios; nunca criar estas contas em produção.
 */
export interface ContaDemo {
  email: string;
  senha: string;
}

export const CONTAS_DEMO: ContaDemo[] = [
  { email: "gestor@scoutvela.dev", senha: "gestor123" },
  { email: "treinadora@scoutvela.dev", senha: "treino123" },
  { email: "atleta@scoutvela.dev", senha: "atleta123" },
  { email: "ibvar@scoutvela.dev", senha: "ibvar123" },
];

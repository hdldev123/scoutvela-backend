import type { Papel } from "../domain/tipos.js";

export interface AcessoDoPapel {
  telas: string[];
  telaInicial: string;
}

/** Telas liberadas por papel e tela em que a pessoa entra. O front só espelha isto. */
const ACESSO: Partial<Record<Papel, AcessoDoPapel>> = {
  gestor: {
    telas: ["ranking", "avaliar", "cadastro", "ciclos", "revisoes", "investimento", "usuarios", "parametros", "auditoria"],
    telaInicial: "ranking",
  },
  // No front, "ranking" do treinador aparece como "Meus atletas". Revisões: só leitura dos próprios atletas.
  treinador: { telas: ["ranking", "avaliar", "revisoes"], telaInicial: "ranking" },
  atleta: { telas: ["painel", "ficha"], telaInicial: "painel" },
  ibvar: { telas: ["investimento", "ranking"], telaInicial: "investimento" },
};

/** Responsável (fluxo de menores) não tem acesso no piloto 18+. */
export function acessoDoPapel(papel: Papel): AcessoDoPapel | null {
  const a = ACESSO[papel];
  return a ? { telas: [...a.telas], telaInicial: a.telaInicial } : null;
}

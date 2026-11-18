import type { Db } from "../db/db.js";

/** Um lançamento da série histórica de um indicador, do jeito que o banco guarda. */
export interface LancamentoNota {
  valor: number;
  evidencia: string;
  origem: "avaliacao" | "resposta_confirmada" | "resposta_sugerida";
  avaliador: { id: string; nome: string } | null;
  cicloNome: string | null;
  lancadoEm: string;
  anexo: { id: string; nomeArquivo: string } | null;
}

export interface Pesagem {
  pesoKg: number;
  evidencia: string;
  medidoEm: string;
  registradoPor: { id: string; nome: string };
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

/**
 * Notas lançadas de um indicador, da mais nova para a mais antiga. Inclui só a sugestão do atleta
 * que ainda está pendente (view sugestao_pendente); as já confirmadas viraram outro lançamento.
 * O atleta deve vir de `buscarAtletaVisivel` (filtro de acesso já aplicado).
 */
export async function historicoDeNotas(
  db: Db,
  atletaId: string,
  indicadorId: string,
): Promise<LancamentoNota[]> {
  const r = await db.query<{
    valor: number;
    evidencia: string;
    origem: LancamentoNota["origem"];
    avaliador_id: string | null;
    avaliador_nome: string | null;
    ciclo_nome: string | null;
    lancado_em: Date;
    anexo_id: string | null;
    anexo_nome: string | null;
  }>(
    `select n.valor, n.evidencia, n.origem, n.avaliador_id, u.nome as avaliador_nome,
            c.nome as ciclo_nome, n.lancado_em, n.anexo_id, ea.nome_arquivo as anexo_nome
       from avaliacoes n
       left join usuarios u on u.id = n.avaliador_id
       left join ciclos_avaliacao c on c.id = n.ciclo_id
       left join evidencias_anexos ea on ea.id = n.anexo_id
      where n.atleta_id = $1::uuid and n.indicador_id = $2
        and (n.origem <> 'resposta_sugerida'
             or exists (select 1 from sugestao_pendente sp where sp.id = n.id))
      order by n.lancado_em desc, n.id desc`,
    [atletaId, indicadorId],
  );
  return r.rows.map((l) => ({
    valor: Number(l.valor),
    evidencia: l.evidencia,
    origem: l.origem,
    avaliador: l.avaliador_id ? { id: l.avaliador_id, nome: l.avaliador_nome ?? "" } : null,
    cicloNome: l.ciclo_nome,
    lancadoEm: iso(l.lancado_em),
    anexo: l.anexo_id ? { id: l.anexo_id, nomeArquivo: l.anexo_nome ?? "" } : null,
  }));
}

/** Pesagens do atleta (medidas com peso), da mais nova para a mais antiga. */
export async function historicoDePesagens(db: Db, atletaId: string): Promise<Pesagem[]> {
  const r = await db.query<{
    peso_kg: string;
    evidencia: string;
    medido_em: Date;
    registrado_por: string;
    registrador_nome: string;
  }>(
    `select m.peso_kg, m.evidencia, m.medido_em, m.registrado_por, u.nome as registrador_nome
       from medidas_corporais m join usuarios u on u.id = m.registrado_por
      where m.atleta_id = $1::uuid and m.peso_kg is not null
      order by m.medido_em desc, m.id desc`,
    [atletaId],
  );
  return r.rows.map((l) => ({
    pesoKg: Number(l.peso_kg),
    evidencia: l.evidencia,
    medidoEm: iso(l.medido_em),
    registradoPor: { id: l.registrado_por, nome: l.registrador_nome },
  }));
}

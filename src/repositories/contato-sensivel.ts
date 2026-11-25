import type { UsuarioAutenticado } from "../auth/plugin.js";
import type { Db } from "../db/db.js";
import { filtroVisibilidade } from "./atletas.js";

type UsuarioDeAcesso = Pick<UsuarioAutenticado, "id" | "papel" | "atletaId">;

export interface ContatoSensivel {
  telefone: string | null;
  /** AAAA-MM */
  passaporteValidoAte: string | null;
  aptidao: { apto: boolean; conferidoEm: string; conferidoPor: { nome: string } } | null;
}

interface Linha {
  telefone: string | null;
  passaporte: string | null;
  apto: boolean | null;
  conferido_em: Date | null;
  conferido_por_nome: string | null;
}

/**
 * Telefone, validade do passaporte e aptidão conferida (D15). Matriz de acesso (contato e saúde): gestor,
 * treinador do atleta e o próprio atleta; o IBVAR nunca (devolve nulo sem consultar o banco). O filtro de
 * quem vê o atleta vai no SQL. A leitura da aptidão por gestor ou treinador, por ser dado de saúde, vai
 * para a auditoria (`ler_aptidao`, só ids). O atleta lendo o próprio dado não gera registro.
 * Atleta fora do acesso: nulo.
 */
export async function lerContatoSensivel(
  db: Db,
  usuario: UsuarioDeAcesso,
  atletaId: string,
  em: Date,
): Promise<ContatoSensivel | null> {
  if (usuario.papel === "ibvar") return null;
  const vis = filtroVisibilidade(usuario, "a", 2);
  const r = await db.query<Linha>(
    `select a.telefone, to_char(a.passaporte_valido_ate, 'YYYY-MM') as passaporte,
            ap.apto, ap.conferido_em, u.nome as conferido_por_nome
       from atletas a
       left join aptidao_atual ap on ap.atleta_id = a.id
       left join usuarios u on u.id = ap.conferido_por
      where a.id = $1::uuid and (${vis.sql})`,
    [atletaId, ...vis.params],
  );
  const l = r.rows[0];
  if (!l) return null;
  const aptidao =
    l.apto !== null && l.conferido_em
      ? {
          apto: l.apto,
          conferidoEm: new Date(l.conferido_em).toISOString(),
          conferidoPor: { nome: l.conferido_por_nome ?? "" },
        }
      : null;
  if (aptidao && (usuario.papel === "gestor" || usuario.papel === "treinador")) {
    await db.query(
      `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
       values ($1::uuid, 'ler_aptidao', 'atletas', $2, '{}'::jsonb, $3)`,
      [usuario.id, atletaId, em],
    );
  }
  return { telefone: l.telefone, passaporteValidoAte: l.passaporte, aptidao };
}

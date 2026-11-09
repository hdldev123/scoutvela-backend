import type { Db } from "../src/db/db.js";
import { ATLETAS_PROTOTIPO, MESES_ASSEGURADOS, PATROCINIO, VELAID_EXTRAS, autonomiaComponente } from "./prototipo.js";

const NIVEIS: Record<string, string> = {
  Mundial: "mundial",
  "Sul-Americano": "sul_americano",
  "Europeu aberto": "internacional_aberto",
  Brasileiro: "brasileiro",
  Estadual: "estadual",
  Regional: "regional",
};

const CICLOS = [
  { nome: "Setembro de 2026", inicio: "2026-09-01", prazo: "2026-09-30", status: "fechado" },
  { nome: "Outubro de 2026", inicio: "2026-10-01", prazo: "2026-10-31", status: "fechado" },
  { nome: "Novembro de 2026", inicio: "2026-11-01", prazo: "2026-11-30", status: "aberto" },
] as const;

const CICLO_DO_MES: Record<string, string> = { "09": "Setembro de 2026", "10": "Outubro de 2026", "11": "Novembro de 2026" };
const CICLO_DO_HISTORICO: Record<string, string> = { Set: "Setembro de 2026", Out: "Outubro de 2026" };

/** 'DD/MM/AAAA' do protótipo -> timestamptz ao meio-dia em Brasília. */
function aoMeioDia(dataBr: string): string {
  const [d, m, a] = dataBr.split("/");
  return `${a}-${m}-${d}T12:00:00-03:00`;
}

function mesDe(dataBr: string): string {
  return dataBr.split("/")[1]!;
}

function slug(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function inserirUsuario(
  tx: Db,
  u: { email: string; nome: string; papel: string; atletaId?: string },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    "insert into usuarios (email, nome, papel, atleta_id) values ($1, $2, $3, $4) returning id",
    [u.email, u.nome, u.papel, u.atletaId ?? null],
  );
  return rows[0]!.id;
}

/**
 * Semeia dados fictícios do protótipo (14 atletas, 5 usuários, 3 ciclos).
 * Só para desenvolvimento e homologação: recusa produção e banco que já tem atletas.
 */
export async function semear(db: Db): Promise<void> {
  if (process.env.APP_ENV === "producao") {
    throw new Error("O seed de dados fictícios é proibido em produção (APP_ENV=producao).");
  }

  await db.transacao(async (tx) => {
    const existentes = await tx.query<{ n: string }>("select count(*)::text as n from atletas");
    if (Number(existentes.rows[0]!.n) > 0) {
      throw new Error("O banco já tem atletas; o seed só roda em banco sem atletas.");
    }

    const gestorId = await inserirUsuario(tx, { email: "gestor@scoutvela.dev", nome: "Gestor CBVela", papel: "gestor" });
    const treinadores: Record<string, string> = {
      "Ana Ribeiro": await inserirUsuario(tx, { email: "treinadora@scoutvela.dev", nome: "Ana Ribeiro", papel: "treinador" }),
      "Marcos Pires": await inserirUsuario(tx, { email: "marcos.pires@scoutvela.dev", nome: "Marcos Pires", papel: "treinador" }),
    };
    await inserirUsuario(tx, { email: "ibvar@scoutvela.dev", nome: "IBVAR", papel: "ibvar" });

    const ciclos: Record<string, string> = {};
    for (const c of CICLOS) {
      const { rows } = await tx.query<{ id: string }>(
        "insert into ciclos_avaliacao (nome, inicio, prazo, status) values ($1, $2, $3, $4) returning id",
        [c.nome, c.inicio, c.prazo, c.status],
      );
      ciclos[c.nome] = rows[0]!.id;
    }

    for (const v of VELAID_EXTRAS) {
      await tx.query(
        `insert into velaid_registros (codigo, nome, genero, data_nascimento, clube, cidade, uf, ws_id, email, fonte)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'simulado')`,
        [v.codigo, v.nome, v.genero, v.nascimento, v.clube, v.cidade, v.uf, v.wsId, v.email],
      );
    }

    const componentes = (await tx.query<{ id: string }>("select id from componentes_custo order by ordem")).rows;

    for (const a of ATLETAS_PROTOTIPO) {
      const treinadorId = treinadores[a.treinador];
      if (!treinadorId) throw new Error(`Treinador ${a.treinador} sem usuário no seed`);

      const { rows } = await tx.query<{ id: string }>(
        `insert into atletas (velaid_codigo, nome, genero, data_nascimento, classe_id, clube, cidade, uf, numero_vela,
                              treinador_id, email_contato, criado_por)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
        [a.velaId, a.nome, a.genero, a.nascimento, a.classeId, a.clube, a.cidade, a.uf, a.numeroVela, treinadorId, a.emailContato, gestorId],
      );
      const atletaId = rows[0]!.id;

      await tx.query(
        `insert into velaid_registros (codigo, nome, genero, data_nascimento, clube, cidade, uf, email, fonte)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'simulado')`,
        [a.velaId, a.nome, a.genero, a.nascimento, a.clube, a.cidade, a.uf, a.emailContato],
      );

      if (a.velaId === "SP-T07") {
        await inserirUsuario(tx, { email: "atleta@scoutvela.dev", nome: a.nome, papel: "atleta", atletaId });
      }

      await tx.query(
        `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
         values ($1, 'termo_piloto', true, 'Piloto 18+ · v1', '2026-10-14T12:00:00-03:00', $2),
                ($1, 'compartilhar_ibvar', $3, null, '2026-10-14T12:00:00-03:00', $2)`,
        [atletaId, gestorId, a.consentIbvar],
      );

      const notaPeso = a.notas["cf_peso_kg"];
      if (!notaPeso) throw new Error(`Atleta ${a.velaId} sem data de pesagem`);
      await tx.query(
        `insert into medidas_corporais (atleta_id, peso_kg, altura_cm, medido_em, evidencia, registrado_por)
         values ($1, $2, $3, $4, $5, $6)`,
        [atletaId, a.pesoKg, a.alturaCm, aoMeioDia(notaPeso.data), notaPeso.evidencia, treinadorId],
      );

      for (const [indicadorId, n] of Object.entries(a.notas)) {
        const cicloId = ciclos[CICLO_DO_MES[mesDe(n.data)]!]!;
        // cf_peso_kg é calculado pelo sistema (P3): não tem lançamento.
        if (n.valor !== null && indicadorId !== "cf_peso_kg") {
          await tx.query(
            `insert into avaliacoes (atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em)
             values ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [atletaId, indicadorId, cicloId, n.valor, n.evidencia, n.tipo === "A" ? "resposta_confirmada" : "avaliacao", treinadorId, aoMeioDia(n.data)],
          );
        }
        const resposta = a.respostas[indicadorId];
        if (resposta != null) {
          await tx.query(
            `insert into respostas_atleta (atleta_id, indicador_id, ciclo_id, resposta, respondido_em)
             values ($1, $2, $3, $4, $5)`,
            [atletaId, indicadorId, cicloId, resposta, aoMeioDia(n.data)],
          );
        }
      }

      for (const r of a.resultados) {
        const nivel = NIVEIS[r.nivel];
        if (!nivel) throw new Error(`Nível ${r.nivel} desconhecido`);
        await tx.query(
          `insert into resultados_regata (atleta_id, nivel, evento, data, posicao, tamanho_frota, internacional,
                                          pontos_cbvela, fonte, link_oficial, registrado_por)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            atletaId, nivel, r.evento, r.data, r.posicao, r.tamanhoFrota, r.internacional,
            r.internacional ? null : r.pontos,
            r.internacional ? "manual" : "ranking_cbvela",
            r.internacional ? `https://resultados.exemplo.invalid/${slug(r.evento)}` : null,
            treinadorId,
          ],
        );
      }

      const fin = await tx.query<{ id: string }>(
        `insert into financeiro_campanha (atleta_id, perfil_suporte, meses_assegurados, patrocinio_privado, informado_por)
         values ($1, $2, $3, $4, $5) returning id`,
        [atletaId, a.perfilSuporte, MESES_ASSEGURADOS[a.perfilSuporte], PATROCINIO[a.perfilSuporte], gestorId],
      );
      for (const [i, comp] of componentes.entries()) {
        const x = autonomiaComponente(a.perfilSuporte, i);
        await tx.query(
          "insert into financeiro_componentes (financeiro_id, componente_id, autonomia, apoio_cbvela) values ($1, $2, $3, $4)",
          [fin.rows[0]!.id, comp.id, x.autonomia, x.apoioCbvela],
        );
      }

      for (const h of a.historico) {
        const faixa = await tx.query<{ id: string }>(
          "select id from faixas_score where score_min <= $1 order by score_min desc limit 1",
          [h.score],
        );
        await tx.query("insert into scores_ciclo (atleta_id, ciclo_id, score, faixa_id) values ($1, $2, $3, $4)", [
          atletaId,
          ciclos[CICLO_DO_HISTORICO[h.ciclo]!],
          h.score,
          faixa.rows[0]!.id,
        ]);
      }
    }
  });
}

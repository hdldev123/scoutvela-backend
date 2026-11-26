import type { Db } from "../db/db.js";
import { resultadosParaGravar } from "../domain/world-sailing.js";
import type { PerfilWorldSailing } from "../domain/world-sailing.js";
import { naoEncontrado } from "../erros.js";
import { ErroWorldSailing } from "../integracoes/world-sailing/tipos.js";
import type {
  FonteWorldSailing,
  IntegracaoWorldSailing,
} from "../integracoes/world-sailing/index.js";
import { erroAtletaAnonimizado } from "../repositories/anonimizado.js";
import { lerRegra } from "../repositories/evolucao.js";

export type StatusImportacao = "ok" | "nao_encontrado" | "falhou";

export interface ResumoImportacao {
  status: StatusImportacao;
  resultadosNovos: number;
  rankingNovos: number;
}

export interface OpcoesImportacao {
  /** `real` ou `simulado`: fica no histórico da busca. */
  modo: "real" | "simulado";
  /** Tempo limite total da busca (padrão 15 s). */
  limiteMs?: number;
}

const LIMITE_PADRAO_MS = 15_000;

/** Busca na fonte com tempo limite total; a falha vira um código curto (nunca o corpo da resposta). */
async function buscarComLimite(
  fonte: FonteWorldSailing,
  wsId: string,
  limiteMs: number,
): Promise<{ perfil: PerfilWorldSailing | null } | { erro: string }> {
  const controle = new AbortController();
  let temporizador: NodeJS.Timeout | undefined;
  try {
    const perfil = await Promise.race([
      fonte.buscarPerfil(wsId, { sinal: controle.signal }),
      new Promise<never>((_, rejeitar) => {
        temporizador = setTimeout(() => {
          controle.abort();
          rejeitar(new ErroWorldSailing("tempo_esgotado"));
        }, limiteMs);
      }),
    ]);
    return { perfil };
  } catch (e) {
    return { erro: e instanceof ErroWorldSailing ? e.codigo.slice(0, 40) : "erro_inesperado" };
  } finally {
    clearTimeout(temporizador);
  }
}

/**
 * Importa o perfil World Sailing do atleta (D19): resultados (fonte `world_sailing`, valem direto),
 * histórico de ranking (só informação) e a sugestão de cadastro, foto e bio. A busca na rede acontece
 * FORA da transação. Idempotente: o que já foi importado não duplica. Falha ou ID não encontrado grava o
 * status e não lança: o cadastro e a ficha seguem normais. Atleta anonimizado: 409.
 */
export async function importarWorldSailing(
  db: Db,
  fonte: FonteWorldSailing,
  atletaId: string,
  porUsuarioId: string | null,
  agora: Date,
  opcoes: OpcoesImportacao,
): Promise<ResumoImportacao> {
  const a = await db.query<{ ws_id: string; anonimizado_em: Date | null }>(
    `select ws_id, anonimizado_em from atletas where id = $1::uuid`,
    [atletaId],
  );
  const atleta = a.rows[0];
  if (!atleta) throw naoEncontrado("Atleta não encontrado.");
  if (atleta.anonimizado_em) throw erroAtletaAnonimizado();

  const regra = await lerRegra(db, "WS_NIVEIS");
  const busca = await buscarComLimite(fonte, atleta.ws_id, opcoes.limiteMs ?? LIMITE_PADRAO_MS);

  return db.transacao(async (tx) => {
    // Trava o atleta: espera uma anonimização em andamento e serializa duas buscas simultâneas.
    const t = await tx.query<{ anonimizado_em: Date | null }>(
      `select anonimizado_em from atletas where id = $1::uuid for update`,
      [atletaId],
    );
    if (t.rows[0]?.anonimizado_em) throw erroAtletaAnonimizado();

    const registrar = async (resumo: ResumoImportacao, erro: string | null): Promise<void> => {
      await tx.query(
        `insert into world_sailing_importacoes
           (atleta_id, executada_em, por, modo, status, resultados_novos, ranking_novos, erro)
         values ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8)`,
        [
          atletaId,
          agora,
          porUsuarioId,
          opcoes.modo,
          resumo.status,
          resumo.resultadosNovos,
          resumo.rankingNovos,
          erro,
        ],
      );
      // Só o modo, o status e as contagens: nada do conteúdo vindo da World Sailing.
      await tx.query(
        `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
         values ($1::uuid, 'importar_world_sailing', 'atleta', $2, $3::jsonb, $4)`,
        [
          porUsuarioId,
          atletaId,
          JSON.stringify({
            modo: opcoes.modo,
            status: resumo.status,
            resultadosNovos: resumo.resultadosNovos,
            rankingNovos: resumo.rankingNovos,
            automatica: porUsuarioId === null,
          }),
          agora,
        ],
      );
    };

    if ("erro" in busca) {
      const resumo = { status: "falhou" as const, resultadosNovos: 0, rankingNovos: 0 };
      await registrar(resumo, busca.erro);
      return resumo;
    }
    const perfil = busca.perfil;
    if (!perfil) {
      const resumo = { status: "nao_encontrado" as const, resultadosNovos: 0, rankingNovos: 0 };
      await registrar(resumo, null);
      return resumo;
    }

    let resultadosNovos = 0;
    for (const r of resultadosParaGravar(perfil, regra)) {
      const ins = await tx.query(
        `insert into resultados_regata
           (atleta_id, nivel, evento, data, edicao, posicao, tamanho_frota, internacional,
            pontos_cbvela, fonte, link_oficial, ws_ref, registrado_por, registrado_em)
         values ($1::uuid, $2, $3, $4::date, $5, $6, null, $7, null, 'world_sailing', $8, $9, $10::uuid, $11)
         on conflict (atleta_id, ws_ref) where ws_ref is not null do nothing
         returning id`,
        [
          atletaId,
          r.nivel,
          r.evento,
          r.data,
          r.edicao,
          r.posicao,
          r.internacional,
          r.linkOficial,
          r.wsRef,
          porUsuarioId,
          agora,
        ],
      );
      resultadosNovos += ins.rows.length;
    }

    let rankingNovos = 0;
    for (const k of perfil.ranking) {
      const ins = await tx.query(
        `insert into world_sailing_ranking (atleta_id, ws_ref, data, classe, tipo, posicao, pontos, importado_em)
         values ($1::uuid, $2, $3::date, $4, $5, $6, $7, $8)
         on conflict (atleta_id, ws_ref) do nothing
         returning id`,
        [atletaId, k.ref, k.data, k.classe, k.tipo, k.posicao, k.pontos, agora],
      );
      rankingNovos += ins.rows.length;
    }

    // Sugestão de cadastro, foto, bio e medida (D20). As decisões (`foto_bio_decidida_em` e as colunas
    // `medida_*`) não mudam: a medida volta a ser oferecida só se `perfil_atualizado_em` mudar.
    await tx.query(
      `insert into world_sailing_perfis
         (atleta_id, ws_sailor_id, nome, genero, data_nascimento, foto_url, bio, importado_em,
          peso_kg, altura_cm, perfil_atualizado_em)
       values ($1::uuid, $2, $3, $4, $5::date, $6, $7, $8, $9, $10, $11::date)
       on conflict (atleta_id) do update
         set ws_sailor_id = excluded.ws_sailor_id, nome = excluded.nome, genero = excluded.genero,
             data_nascimento = excluded.data_nascimento, foto_url = excluded.foto_url,
             bio = excluded.bio, importado_em = excluded.importado_em, peso_kg = excluded.peso_kg,
             altura_cm = excluded.altura_cm, perfil_atualizado_em = excluded.perfil_atualizado_em`,
      [
        atletaId,
        perfil.sailorId,
        perfil.nome,
        perfil.genero,
        perfil.dataNascimento,
        perfil.fotoUrl,
        perfil.bio,
        agora,
        perfil.pesoKg,
        perfil.alturaCm,
        perfil.atualizadoEm,
      ],
    );

    const resumo = { status: "ok" as const, resultadosNovos, rankingNovos };
    await registrar(resumo, null);
    return resumo;
  });
}

/**
 * Importa sem nunca lançar: usada no cadastro do atleta (que não pode falhar por causa da World Sailing) e
 * na busca manual. Integração desligada devolve `desligado`; erro inesperado vira `falhou`, registrado só com
 * o tipo do erro (sem dado pessoal nem conteúdo da resposta).
 */
export async function importarSemLancar(
  db: Db,
  integracao: IntegracaoWorldSailing,
  atletaId: string,
  porUsuarioId: string | null,
  agora: Date,
  log: { warn: (obj: Record<string, unknown>, msg: string) => void },
): Promise<ResumoImportacao | { status: "desligado"; resultadosNovos: 0; rankingNovos: 0 }> {
  if (integracao.fonte === null || integracao.modo === "desligado") {
    return { status: "desligado", resultadosNovos: 0, rankingNovos: 0 };
  }
  try {
    return await importarWorldSailing(db, integracao.fonte, atletaId, porUsuarioId, agora, {
      modo: integracao.modo,
      limiteMs: integracao.limiteCadastroMs,
    });
  } catch (e) {
    const f = e as { code?: unknown; name?: unknown };
    log.warn(
      {
        evento: "world_sailing_importacao_falhou",
        erro: typeof f?.code === "string" ? f.code : typeof f?.name === "string" ? f.name : "Error",
      },
      "importação da World Sailing falhou",
    );
    return { status: "falhou", resultadosNovos: 0, rankingNovos: 0 };
  }
}

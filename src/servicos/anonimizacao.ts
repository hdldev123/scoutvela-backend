import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { conflito, naoEncontrado, requisicaoInvalida } from "../erros.js";
import type { AdminAuth } from "../integracoes/supabase-admin.js";
import type { ArmazenamentoEvidencias } from "../storage/index.js";

/**
 * Anonimização do atleta por pedido de exclusão (LGPD, art. 18).
 *
 * Some: nome, contato, clube, cidade, número de vela, ID World Sailing, código VelaID, a linha do
 * VelaID, os dados pessoais da conta de login, a conta no Supabase Auth e os arquivos de evidência.
 * Fica: a série histórica (notas, respostas, medidas, gates, financeiro, plano, auditoria), ligada
 * ao atleta_id e sem identificação direta.
 *
 * TODO(B5): quando a foto de perfil existir, a remoção dela entra aqui, junto das evidências.
 */

export const NOME_ANONIMIZADO = "Atleta anonimizado";

export interface DepsAnonimizacao {
  db: Db;
  armazenamento: ArmazenamentoEvidencias;
  adminAuth: AdminAuth | null;
  agora: () => Date;
  /** Recebe só tipo e nome/código do erro: nunca caminho, id nem dado da pessoa. */
  log: { warn: (obj: Record<string, unknown>, msg: string) => void };
}

export interface ResultadoAnonimizacao {
  atletaId: string;
  anonimizadoEm: string;
  evidenciasRemovidas: number;
  pendencias: { arquivos: number; conta: boolean };
}

interface LinhaAtleta {
  anonimizado_em: Date | null;
  anonimizado_pedido_id: string | null;
}

const dataBr = (d: Date): string =>
  new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(d);

const nomeDoErro = (e: unknown): string => {
  const f = e as { code?: unknown; name?: unknown };
  return typeof f?.code === "string" ? f.code : typeof f?.name === "string" ? f.name : "Error";
};

async function novoCodigoAnonimo(tx: Db): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const codigo = `ANON-${randomBytes(4).toString("hex").toUpperCase()}`;
    const r = await tx.query(
      `select 1 from atletas where velaid_codigo = $1
       union all select 1 from velaid_registros where codigo = $1`,
      [codigo],
    );
    if (r.rows.length === 0) return codigo;
  }
  throw new Error("Não foi possível gerar um código anônimo único.");
}

export async function anonimizarAtleta(
  deps: DepsAnonimizacao,
  entrada: { atletaId: string; pedidoTitularId: string; gestorId: string },
): Promise<ResultadoAnonimizacao> {
  const { db, agora } = deps;
  const { atletaId, pedidoTitularId, gestorId } = entrada;

  const a = await db.query<LinhaAtleta>(
    `select anonimizado_em, anonimizado_pedido_id::text as anonimizado_pedido_id
       from atletas where id = $1::uuid`,
    [atletaId],
  );
  const atleta = a.rows[0];
  if (!atleta) throw naoEncontrado("Atleta não encontrado.");

  const p = await db.query<{ atleta_id: string; tipo: string; status: string }>(
    `select atleta_id::text as atleta_id, tipo, status from pedidos_titular where id = $1::bigint`,
    [pedidoTitularId],
  );
  const pedido = p.rows[0];
  if (!pedido || pedido.atleta_id !== atletaId || pedido.tipo !== "exclusao") {
    throw requisicaoInvalida("Informe o pedido de exclusão deste atleta.");
  }

  let anonimizadoEm: Date;
  if (atleta.anonimizado_em) {
    // Retomada: só repete o que depende de serviço externo.
    if (atleta.anonimizado_pedido_id !== pedidoTitularId) {
      throw conflito("Este atleta já foi anonimizado por outro pedido.");
    }
    anonimizadoEm = new Date(atleta.anonimizado_em);
  } else {
    if (pedido.status !== "aberto") throw conflito("Este pedido já foi respondido.");
    anonimizadoEm = agora();
    await db.transacao((tx) =>
      anonimizarNoBanco(tx, { atletaId, pedidoTitularId, gestorId, em: anonimizadoEm }),
    );
  }

  const pendencias = await concluirPendencias(deps, atletaId);
  return { atletaId, anonimizadoEm: anonimizadoEm.toISOString(), ...pendencias };
}

async function anonimizarNoBanco(
  tx: Db,
  e: { atletaId: string; pedidoTitularId: string; gestorId: string; em: Date },
): Promise<void> {
  const { atletaId, pedidoTitularId, gestorId, em } = e;

  // Trava o atleta: duas anonimizações ao mesmo tempo não passam juntas.
  const lock = await tx.query<{ anonimizado_em: Date | null; velaid_codigo: string }>(
    `select anonimizado_em, velaid_codigo from atletas where id = $1::uuid for update`,
    [atletaId],
  );
  const linha = lock.rows[0];
  if (!linha) throw naoEncontrado("Atleta não encontrado.");
  if (linha.anonimizado_em) throw conflito("Este atleta já foi anonimizado.");

  const respondeu = await tx.query(
    `update pedidos_titular
        set status = 'respondido', resposta = $2, respondido_por = $3::uuid, respondido_em = $4
      where id = $1::bigint and status = 'aberto'
  returning id`,
    [
      pedidoTitularId,
      `Dados pessoais anonimizados em ${dataBr(em)}. A série histórica de avaliações foi mantida sem identificação direta.`,
      gestorId,
      em,
    ],
  );
  if (respondeu.rows.length === 0) throw conflito("Este pedido já foi respondido.");

  const codigoAnonimo = await novoCodigoAnonimo(tx);
  await tx.query(
    `update atletas
        set nome = $2, clube = null, cidade = null, uf = null, numero_vela = null, ws_id = null,
            email_contato = null, velaid_codigo = $3, ativo = false,
            anonimizado_em = $4, anonimizado_pedido_id = $5::bigint
      where id = $1::uuid`,
    [atletaId, NOME_ANONIMIZADO, codigoAnonimo, em, pedidoTitularId],
  );
  await tx.query(`delete from velaid_registros where codigo = $1`, [linha.velaid_codigo]);

  // Contas de login do atleta. O id do Auth fica guardado até a conta ser apagada de fato.
  const contas = await tx.query<{ id: string; auth_user_id: string | null }>(
    `select id::text as id, auth_user_id::text as auth_user_id
       from usuarios where papel = 'atleta' and atleta_id = $1::uuid for update`,
    [atletaId],
  );
  let temContaAuth = false;
  for (const c of contas.rows) {
    if (c.auth_user_id) {
      temContaAuth = true;
      await tx.query(
        `insert into anonimizacoes_pendentes (atleta_id, auth_user_id, criado_em)
         values ($1::uuid, $2::uuid, $3) on conflict do nothing`,
        [atletaId, c.auth_user_id, em],
      );
    }
    await tx.query(
      `update usuarios set nome = $2, email = $3, ativo = false, auth_user_id = null where id = $1::uuid`,
      [c.id, NOME_ANONIMIZADO, `anonimizado+${randomUUID()}@anonimizado.invalid`],
    );
  }

  // Revoga os consentimentos (histórico preservado: linhas novas, mesma versão do termo).
  await tx.query(
    `insert into consentimentos (atleta_id, tipo, concedido, versao_termo, registrado_em, registrado_por)
     select $1::uuid, t.tipo, false,
            (select c.versao_termo from consentimento_atual c where c.atleta_id = $1::uuid and c.tipo = t.tipo),
            $2, $3::uuid
       from (values ('termo_piloto'), ('compartilhar_ibvar')) as t(tipo)`,
    [atletaId, em, gestorId],
  );

  const evidencias = await tx.query(
    `update evidencias_anexos set removido_em = $2, nome_arquivo = 'removido'
      where atleta_id = $1::uuid and removido_em is null
  returning id`,
    [atletaId, em],
  );

  // Só ids e contagens: nada de nome, e-mail nem código VelaID.
  await tx.query(
    `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
     values ($1::uuid, 'anonimizar_atleta', 'atleta', $2, $3::jsonb, $4)`,
    [
      gestorId,
      atletaId,
      JSON.stringify({
        pedidoTitularId,
        evidencias: evidencias.rows.length,
        contaAuth: temContaAuth,
      }),
      em,
    ],
  );
}

/** Remove arquivos e contas fora do banco. Falha aqui não desfaz a anonimização: vira pendência. */
async function concluirPendencias(
  deps: DepsAnonimizacao,
  atletaId: string,
): Promise<Pick<ResultadoAnonimizacao, "evidenciasRemovidas" | "pendencias">> {
  const { db, armazenamento, adminAuth, log } = deps;

  const arquivos = await db.query<{ caminho: string }>(
    `select caminho from evidencias_anexos
      where atleta_id = $1::uuid and removido_em is not null order by enviado_em, id`,
    [atletaId],
  );
  let falhasArquivo = 0;
  for (const { caminho } of arquivos.rows) {
    try {
      await armazenamento.remover(caminho);
    } catch (e) {
      falhasArquivo++;
      log.warn(
        { evento: "anonimizacao_pendencia", tipo: "arquivo", erro: nomeDoErro(e) },
        "falha ao remover arquivo na anonimização",
      );
    }
  }

  const contas = await db.query<{ auth_user_id: string }>(
    `select auth_user_id::text as auth_user_id from anonimizacoes_pendentes where atleta_id = $1::uuid`,
    [atletaId],
  );
  let contaPendente = false;
  for (const { auth_user_id: authUserId } of contas.rows) {
    try {
      if (!adminAuth) throw new Error("AdminAuth não configurado");
      await adminAuth.removerConta(authUserId);
      await db.query(
        `delete from anonimizacoes_pendentes where atleta_id = $1::uuid and auth_user_id = $2::uuid`,
        [atletaId, authUserId],
      );
    } catch (e) {
      contaPendente = true;
      log.warn(
        { evento: "anonimizacao_pendencia", tipo: "conta", erro: nomeDoErro(e) },
        "falha ao remover conta na anonimização",
      );
    }
  }

  return {
    evidenciasRemovidas: arquivos.rows.length - falhasArquivo,
    pendencias: { arquivos: falhasArquivo, conta: contaPendente },
  };
}

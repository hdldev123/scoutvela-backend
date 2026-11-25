import { randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import { conflito, naoEncontrado, requisicaoInvalida } from "../erros.js";
import type { AdminAuth } from "../integracoes/supabase-admin.js";
import type { ArmazenamentoEvidencias } from "../storage/index.js";

/**
 * Anonimização do atleta por pedido de exclusão (LGPD, art. 18).
 *
 * Some: nome, contato, clube, cidade, UF, número de vela, ID World Sailing (vira `ANON` + 8 hexadecimais,
 * porque o campo é obrigatório e único), código VelaID (vira `ANON-xxxxxxxx`), a linha
 * do VelaID, os dados pessoais da conta de login, a conta no Supabase Auth, a foto de perfil, os
 * arquivos de evidência, os textos livres da série histórica (evidência das notas e das medidas,
 * justificativa de gate, plano individual, pedidos de revisão, de ajuste e do titular, avisos, nome do evento e link
 * dos resultados de regata) e as chaves com dado pessoal da trilha de auditoria. A data de
 * nascimento vira 1º de julho do mesmo ano.
 * Fica: a série histórica (valores, datas, status), ligada ao atleta_id e sem identificação direta.
 *
 * Os gatilhos de só-inserção aceitam essas trocas de texto apenas dentro da transação abaixo, que
 * marca `scoutvela.anonimizando` com o id do atleta (migration 0015).
 */

export const NOME_ANONIMIZADO = "Atleta anonimizado";
export const MARCADOR_REMOVIDO = "[removido na anonimização]";
export const EVENTO_ANONIMIZADO = "Evento anonimizado";

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

/**
 * ID World Sailing neutro e único: `ANON` + 8 hexadecimais (respeita o formato do banco, que exige
 * 3 letras e 2 a 12 letras ou números). O campo é obrigatório e único, então nunca fica nulo.
 */
async function novoWsIdAnonimo(tx: Db): Promise<string> {
  for (let i = 0; i < 10; i++) {
    const wsId = `ANON${randomBytes(4).toString("hex").toUpperCase()}`;
    const r = await tx.query("select 1 from atletas where ws_id = $1", [wsId]);
    if (r.rows.length === 0) return wsId;
  }
  throw new Error("Não foi possível gerar um ID World Sailing anônimo único.");
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

  // Libera, só nesta transação, a exceção dos gatilhos de só-inserção para ESTE atleta.
  await tx.query(`select set_config('scoutvela.anonimizando', lower($1), true)`, [atletaId]);

  // Trava o atleta: duas anonimizações ao mesmo tempo não passam juntas.
  const lock = await tx.query<{ anonimizado_em: Date | null; velaid_codigo: string | null }>(
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
    [pedidoTitularId, textoDaResposta(em), gestorId, em],
  );
  if (respondeu.rows.length === 0) throw conflito("Este pedido já foi respondido.");

  const codigoAnonimo = await novoCodigoAnonimo(tx);
  const wsIdAnonimo = await novoWsIdAnonimo(tx);
  await tx.query(
    `update atletas
        set nome = $2, clube = null, cidade = null, uf = null, numero_vela = null, ws_id = $6,
            email_contato = null, telefone = null, passaporte_valido_ate = null,
            velaid_codigo = $3, ativo = false,
            data_nascimento = make_date(extract(year from data_nascimento)::int, 7, 1),
            anonimizado_em = $4, anonimizado_pedido_id = $5::bigint
      where id = $1::uuid`,
    [atletaId, NOME_ANONIMIZADO, codigoAnonimo, em, pedidoTitularId, wsIdAnonimo],
  );
  if (linha.velaid_codigo) {
    await tx.query(`delete from velaid_registros where codigo = $1`, [linha.velaid_codigo]);
  }

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

  const evidencias = await marcarEvidenciasRemovidas(tx, atletaId, em);
  await removerTextosLivres(tx, atletaId, pedidoTitularId);

  // Só ids e contagens: nada de nome, e-mail nem código VelaID.
  await tx.query(
    `insert into auditoria (usuario_id, acao, entidade, entidade_id, detalhes, em)
     values ($1::uuid, 'anonimizar_atleta', 'atleta', $2, $3::jsonb, $4)`,
    [
      gestorId,
      atletaId,
      JSON.stringify({
        pedidoTitularId,
        evidencias,
        contaAuth: temContaAuth,
      }),
      em,
    ],
  );
}

/** Texto da resposta ao titular: diz exatamente o que sumiu e o que ficou. */
export function textoDaResposta(em: Date): string {
  return [
    `Dados pessoais anonimizados em ${dataBr(em)}.`,
    "Removidos: nome, e-mail de contato, telefone, validade do passaporte, clube, cidade, UF, número de vela, ID World Sailing e código VelaID (trocado por um código anônimo); o registro no VelaID; os dados da conta de login (nome, e-mail e acesso) e a conta no serviço de login; a foto de perfil e os arquivos de evidência; as aptidões conferidas (dado de saúde); os pedidos de ajuste e os avisos sobre o atleta; os textos livres da série histórica (evidências das notas e das medidas, justificativas de gates, plano individual, pedidos de revisão e do titular, nome e link dos resultados de regata e o motivo da recusa de resultados); e os dados pessoais da trilha de auditoria. O compartilhamento com o IBVAR e o aceite do termo foram revogados.",
    "Alterado: a data de nascimento foi generalizada para 1º de julho do mesmo ano.",
    "Mantidos, sem identificação direta e ligados apenas a um identificador interno: notas, respostas do questionário, medidas corporais, resultados de regata (nível, data, edição, posição, tamanho da frota, pontos e a situação da validação), status e datas das decisões de gate, financeiro da campanha, pontuações dos ciclos e a trilha de auditoria (quem fez o quê e quando, sem dados pessoais).",
  ].join(" ");
}

/**
 * Marca como removidas todas as evidências do atleta ainda disponíveis (também as que chegaram
 * durante a anonimização). Devolve quantas foram marcadas agora. O arquivo sai do Storage depois.
 */
async function marcarEvidenciasRemovidas(tx: Db, atletaId: string, em: Date): Promise<number> {
  const r = await tx.query(
    `update evidencias_anexos set removido_em = greatest($2::timestamptz, enviado_em), nome_arquivo = 'removido'
      where atleta_id = $1::uuid and removido_em is null
  returning id`,
    [atletaId, em],
  );
  return r.rows.length;
}

/** Troca os textos livres pelo marcador (ou nulo/limpo, conforme a coluna) e limpa a auditoria. */
async function removerTextosLivres(
  tx: Db,
  atletaId: string,
  pedidoTitularId: string,
): Promise<void> {
  const m = MARCADOR_REMOVIDO;
  const q = (sql: string, params: unknown[] = []) => tx.query(sql, [atletaId, m, ...params]);

  // Aptidão é dado de saúde: as linhas saem (a tabela é só de inserção; o gatilho aceita este DELETE
  // só com a variável da anonimização igual ao atleta).
  await tx.query(`delete from aptidoes where atleta_id = $1::uuid`, [atletaId]);
  // Pedidos de ajuste (texto livre sobre o atleta) e avisos que citam o atleta (do treinador e dele).
  // `pedidos_ajuste` é só de inserção; o gatilho aceita este DELETE pela mesma variável da aptidão.
  await tx.query(`delete from pedidos_ajuste where atleta_id = $1::uuid`, [atletaId]);
  await tx.query(`delete from avisos where atleta_id = $1::uuid`, [atletaId]);
  // Pesagens informadas pelo atleta (peso é dado sensível): as linhas saem; a tabela só aceita este
  // DELETE com a variável da anonimização igual ao atleta. A medida validada fica em `medidas_corporais`.
  await tx.query(`delete from pesagens_atleta where atleta_id = $1::uuid`, [atletaId]);
  // Evidência e justificativa do treinador na mesma atualização (o gatilho confere a linha inteira).
  await q(
    `update avaliacoes
        set evidencia = case when evidencia is null then null else $2 end,
            justificativa = case when justificativa is null then null else $2 end
      where atleta_id = $1::uuid
        and ((evidencia is not null and evidencia <> $2)
             or (justificativa is not null and justificativa <> $2))`,
  );
  await q(
    `update medidas_corporais set evidencia = $2 where atleta_id = $1::uuid and evidencia <> $2`,
  );
  await q(
    `update gates_decisoes set justificativa = $2
      where atleta_id = $1::uuid and justificativa is not null and justificativa <> $2`,
  );
  await q(
    `update plano_individual set forcas = $2, lacunas = $2, meta_12m = $2, meta_24m = $2, recomendacao = $2
      where atleta_id = $1::uuid
        and not (forcas = $2 and lacunas = $2 and meta_12m = $2 and meta_24m = $2 and recomendacao = $2)`,
  );
  await q(
    `update pedidos_revisao
        set motivo = $2, resposta = case when resposta is null then null else $2 end,
            resposta_1 = case when resposta_1 is null then null else $2 end,
            recurso_texto = case when recurso_texto is null then null else $2 end
      where atleta_id = $1::uuid`,
  );
  // A resposta do pedido de exclusão é o registro da anonimização: fica. Só a descrição sai.
  await q(
    `update pedidos_titular
        set descricao = $2,
            resposta = case when resposta is null or id = $3::bigint then resposta else $2 end
      where atleta_id = $1::uuid`,
    [pedidoTitularId],
  );
  // Motivo da recusa de um resultado (texto livre do treinador sobre o atleta); a tabela de validações
  // só aceita este UPDATE com a variável da anonimização igual ao atleta.
  await q(
    `update validacoes_resultado v set motivo = $2
       from resultados_regata r
      where r.id = v.resultado_id and r.atleta_id = $1::uuid
        and v.motivo is not null and v.motivo <> $2`,
  );
  await tx.query(
    `update resultados_regata set evento = $2, link_oficial = null, anonimizado = true
      where atleta_id = $1::uuid`,
    [atletaId, EVENTO_ANONIMIZADO],
  );
  await tx.query(
    `update auditoria set detalhes = anonimiza_detalhes_auditoria(detalhes)
      where entidade_id = $1 and detalhes is distinct from anonimiza_detalhes_auditoria(detalhes)`,
    [atletaId],
  );
}

/** Remove arquivos e contas fora do banco. Falha aqui não desfaz a anonimização: vira pendência. */
async function concluirPendencias(
  deps: DepsAnonimizacao,
  atletaId: string,
): Promise<Pick<ResultadoAnonimizacao, "evidenciasRemovidas" | "pendencias">> {
  const { db, armazenamento, adminAuth, log, agora } = deps;

  // Evidência que ainda estava disponível (chegou durante a anonimização, ou numa retomada) também
  // é marcada como removida. As travas do banco impedem novos envios depois da anonimização.
  await db.transacao(async (tx) => {
    await tx.query(`select set_config('scoutvela.anonimizando', lower($1), true)`, [atletaId]);
    await marcarEvidenciasRemovidas(tx, atletaId, agora());
  });

  const registradas = await db.query<{ caminho: string }>(
    `select caminho from evidencias_anexos
      where atleta_id = $1::uuid and removido_em is not null order by enviado_em, id`,
    [atletaId],
  );
  const contasDeLogin = await db.query<{ id: string; foto_caminho: string | null }>(
    `select id::text as id, foto_caminho from usuarios where papel = 'atleta' and atleta_id = $1::uuid`,
    [atletaId],
  );

  // Tudo o que existe no Storage sob os prefixos do atleta: o registro do banco pode não ter
  // apontado para o arquivo (falha no rollback, troca de foto, envio que chegou tarde).
  const prefixos = [
    `${atletaId.toLowerCase()}/`,
    ...contasDeLogin.rows.map((c) => `fotos/${c.id}/`),
  ];
  const alvos = new Set<string>(registradas.rows.map((r) => r.caminho));
  for (const c of contasDeLogin.rows) if (c.foto_caminho) alvos.add(c.foto_caminho);
  const falhas = new Set<string>();
  let listagemFalhou = 0;
  for (const prefixo of prefixos) {
    try {
      for (const caminho of await armazenamento.listar(prefixo)) alvos.add(caminho);
    } catch (e) {
      listagemFalhou++;
      log.warn(
        { evento: "anonimizacao_pendencia", tipo: "listagem", erro: nomeDoErro(e) },
        "falha ao listar arquivos na anonimização",
      );
    }
    const pend = await db.query<{ caminho: string }>(
      `select caminho from arquivos_pendentes where left(caminho, length($1)) = $1`,
      [prefixo],
    );
    for (const { caminho } of pend.rows) alvos.add(caminho);
  }

  for (const caminho of alvos) {
    try {
      await armazenamento.remover(caminho);
      await db.query(`delete from arquivos_pendentes where caminho = $1`, [caminho]);
    } catch (e) {
      falhas.add(caminho);
      log.warn(
        { evento: "anonimizacao_pendencia", tipo: "arquivo", erro: nomeDoErro(e) },
        "falha ao remover arquivo na anonimização",
      );
      // Fica registrado (só o caminho): o estado da pendência vale também depois da resposta
      // e a retentativa da anonimização o encontra pelo prefixo.
      await db.query(
        `insert into arquivos_pendentes (caminho, motivo, criado_em) values ($1, 'anonimizacao', $2)
         on conflict (caminho) do nothing`,
        [caminho, agora()],
      );
    }
  }
  // A conta já está inativa: a foto não aparece mais e o caminho só sai do banco depois de removida.
  for (const c of contasDeLogin.rows) {
    if (c.foto_caminho && !falhas.has(c.foto_caminho)) {
      await db.query(`update usuarios set foto_caminho = null where id = $1::uuid`, [c.id]);
    }
  }
  const falhasEvidencia = registradas.rows.filter((r) => falhas.has(r.caminho)).length;
  const falhasArquivos = falhas.size + listagemFalhou;

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
    evidenciasRemovidas: registradas.rows.length - falhasEvidencia,
    pendencias: { arquivos: falhasArquivos, conta: contaPendente },
  };
}

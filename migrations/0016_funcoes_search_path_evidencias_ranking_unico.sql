-- Rodada 2 da revisão: funções com search_path fixo, trigger de evidências mais estrito e
-- índice único do Ranking CBVela importado.

-- ---------------------------------------------------------------------------------------------
-- 1. search_path fixo nas funções (aviso "function_search_path_mutable" do linter do Supabase).
--    ALTER FUNCTION mantém corpo, assinatura e volatilidade: só acrescenta `set search_path`.
--    As funções de gatilho e as de termo (0011 e 0015) leem só tabelas e views de `public`.
-- ---------------------------------------------------------------------------------------------
alter function impede_alteracao() set search_path = public;
alter function serie_historica_controle() set search_path = public;
alter function anonimiza_detalhes_auditoria(jsonb) set search_path = public;
alter function auditoria_controle() set search_path = public;
alter function bloqueia_atleta_anonimizado() set search_path = public;
alter function termo_vigente_versao(timestamptz) set search_path = public;
alter function termo_aceito_vigente(uuid, timestamptz) set search_path = public;
alter function termo_aceito_alguma(uuid) set search_path = public;
alter function termo_aceito_no_piloto(uuid, timestamptz) set search_path = public;
alter function termo_proxima_versao(timestamptz) set search_path = public;
alter function termo_aceito_versao(uuid, text) set search_path = public;

-- ---------------------------------------------------------------------------------------------
-- 2. evidencias_anexos: única alteração aceita é marcar a remoção (uma vez), e agora
--    - `removido_em` não pode ser anterior ao envio;
--    - o resto do registro é comparado inteiro (colunas futuras ficam protegidas sem editar
--      esta função): só `removido_em` e `nome_arquivo` podem mudar, e o nome vira 'removido'.
--    Vale para as duas saídas de remoção: anonimização e DELETE /evidencias/:id (anexo não vinculado).
-- ---------------------------------------------------------------------------------------------
create or replace function evidencias_anexos_controle() returns trigger
language plpgsql
set search_path = public
as $$
begin
  if tg_op = 'UPDATE'
     and old.removido_em is null
     and new.removido_em is not null
     and new.removido_em >= old.enviado_em
     and new.nome_arquivo = 'removido'
     and (to_jsonb(new) - 'removido_em' - 'nome_arquivo')
         = (to_jsonb(old) - 'removido_em' - 'nome_arquivo') then
    return new;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

-- ---------------------------------------------------------------------------------------------
-- 3. Ranking CBVela importado: um resultado por atleta + evento + data (sem diferenciar
--    maiúsculas). É a mesma identidade que a importação já conferia por select; agora o banco
--    garante, e dois envios simultâneos não duplicam. Parcial: só a fonte do ranking e fora das
--    linhas anonimizadas (a anonimização troca o evento de todas por "Evento anonimizado").
--    Duplicatas que já existam saem antes (fica a de menor id; são cópias exatas da mesma importação).
-- ---------------------------------------------------------------------------------------------
delete from resultados_regata a
 using resultados_regata b
 where a.fonte = 'ranking_cbvela' and not a.anonimizado
   and b.fonte = 'ranking_cbvela' and not b.anonimizado
   and a.atleta_id = b.atleta_id and lower(a.evento) = lower(b.evento) and a.data = b.data
   and b.id < a.id;

create unique index resultados_ranking_unico
  on resultados_regata (atleta_id, lower(evento), data)
  where fonte = 'ranking_cbvela' and not anonimizado;

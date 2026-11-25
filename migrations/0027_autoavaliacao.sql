-- D9: autoavaliação. O atleta sugere a nota de cada indicador; o treinador aprova (mesma nota) ou
-- corrige (outra nota, com justificativa). A sugestão nunca entra no score, nos gates, no
-- congelamento do ciclo, no ranking nem no investimento: só a nota do treinador conta.

-- 1. Parâmetro por indicador: o gestor liga e desliga em Parâmetros. Valor inicial: os indicadores
--    tipo T não calculados (A e R já têm o questionário; cf_peso_kg é medida, não nota).
alter table indicadores add column autoavaliacao boolean not null default false;
update indicadores set autoavaliacao = true where tipo = 'T' and not calculado;

-- 2. Origens novas em `avaliacoes`:
--    autoavaliacao           sugestão do atleta (sem avaliador)
--    autoavaliacao_aprovada  nota do treinador igual à sugestão do atleta
--    Fora a sugestão, toda nota tem avaliador. A autoavaliação nunca tem.
alter table avaliacoes drop constraint avaliacoes_origem_check;
alter table avaliacoes add constraint avaliacoes_origem_check
  check (origem in ('avaliacao', 'resposta_confirmada', 'resposta_sugerida', 'autoavaliacao', 'autoavaliacao_aprovada'));

alter table avaliacoes drop constraint avaliacoes_check;
alter table avaliacoes add constraint avaliacoes_avaliador_check
  check (
    case when origem = 'autoavaliacao' then avaliador_id is null
         when origem = 'resposta_sugerida' then true
         else avaliador_id is not null end
  );

-- 3. Justificativa do treinador ao corrigir a sugestão (texto livre: sai na anonimização).
alter table avaliacoes add column justificativa text
  check (justificativa is null or (length(trim(justificativa)) > 0 and length(justificativa) <= 500));

-- A anonimização troca `evidencia` e `justificativa` pelo marcador, as duas na mesma atualização.
drop trigger avaliacoes_somente_insercao on avaliacoes;
create trigger avaliacoes_somente_insercao before update or delete on avaliacoes
  for each row execute function serie_historica_controle('evidencia', 'justificativa');

-- 4. Notas confirmadas: a sugestão (do questionário ou da autoavaliação) não vale no score.
create or replace view avaliacao_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id)
    id, atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em, anexo_id, link,
    justificativa
  from avaliacoes
  where origem not in ('resposta_sugerida', 'autoavaliacao')
  order by atleta_id, indicador_id, lancado_em desc, id desc;

-- Última sugestão do atleta mais nova que a última nota confirmada do indicador.
create or replace view sugestao_pendente with (security_invoker = true) as
  select distinct on (s.atleta_id, s.indicador_id)
    s.id, s.atleta_id, s.indicador_id, s.ciclo_id, s.valor, s.lancado_em
  from avaliacoes s
  where s.origem in ('resposta_sugerida', 'autoavaliacao')
    and not exists (
      select 1 from avaliacoes c
      where c.atleta_id = s.atleta_id and c.indicador_id = s.indicador_id
        and c.origem not in ('resposta_sugerida', 'autoavaliacao') and c.lancado_em >= s.lancado_em
    )
  order by s.atleta_id, s.indicador_id, s.lancado_em desc, s.id desc;

-- 5. Avisos novos: o atleta autoavaliou (ao treinador) e o treinador corrigiu a sugestão (ao atleta).
alter table avisos drop constraint avisos_tipo_check;
alter table avisos add constraint avisos_tipo_check check (tipo in (
  'atleta_respondeu', 'atleta_anexou', 'atleta_atualizou_perfil',
  'atleta_completou_cadastro', 'pedido_ajuste', 'sugestao_respondida',
  'atleta_autoavaliou', 'autoavaliacao_corrigida',
  'atleta_enviou_pesagem', 'pesagem_validada', 'pesagem_recusada'));

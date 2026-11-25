-- D5: evidência por indicador (decisão F) e vídeo por link.
-- `evidencia` diz se a nota do indicador exige texto de evidência; `exige_anexo` marca o indicador cuja
-- nota depende de um arquivo (a pesagem do atleta, com a foto do visor da balança).
alter table indicadores
  add column evidencia text not null default 'obrigatoria' check (evidencia in ('obrigatoria', 'opcional')),
  add column exige_anexo boolean not null default false;

update indicadores set evidencia = 'opcional' where id ~ '^(tec|tat|pot)_';
update indicadores set exige_anexo = true where id = 'cf_peso_kg';

-- A evidência da nota passa a poder faltar (a API confere a regra do indicador). Preenchida, não pode ser vazia.
alter table avaliacoes alter column evidencia drop not null;
alter table avaliacoes drop constraint avaliacoes_evidencia_check;
alter table avaliacoes add constraint avaliacoes_evidencia_check
  check (evidencia is null or length(trim(evidencia)) > 0);

-- Link de vídeo (ou outro conteúdo externo) da nota. A API nunca acessa o endereço.
alter table avaliacoes add column link text
  check (link is null or (link ~ '^https://' and length(link) <= 500));

-- Mesma definição da 0007, com link no fim da lista de colunas.
create or replace view avaliacao_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id)
    id, atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em, anexo_id, link
  from avaliacoes
  where origem <> 'resposta_sugerida'
  order by atleta_id, indicador_id, lancado_em desc, id desc;

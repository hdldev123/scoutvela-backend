-- Séries históricas que ainda aceitavam UPDATE e DELETE: scores_ciclo e resultados_regata.
-- Verificado no código: nada altera scores_ciclo (só insert no fechamento do ciclo e no seed); e
-- resultados_regata só é alterada pela anonimização (evento, link_oficial, anonimizado).

-- scores_ciclo: o score congelado do ciclo nunca é reescrito.
create trigger scores_ciclo_somente_insercao before update or delete on scores_ciclo
  for each row execute function impede_alteracao();

-- resultados_regata: só a anonimização do próprio atleta (set local scoutvela.anonimizando = '<atleta_id>'),
-- e só trocando evento, link_oficial e anonimizado (que passa a true e deixa o link nulo).
-- Qualquer outro UPDATE e todo DELETE são recusados.
create function resultados_regata_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'UPDATE'
     and alvo is not null and alvo = old.atleta_id::text
     and new.anonimizado and new.link_oficial is null
     and (to_jsonb(new) - 'evento' - 'link_oficial' - 'anonimizado')
         = (to_jsonb(old) - 'evento' - 'link_oficial' - 'anonimizado') then
    return new;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

create trigger resultados_regata_somente_insercao before update or delete on resultados_regata
  for each row execute function resultados_regata_controle();

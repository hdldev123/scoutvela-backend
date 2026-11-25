-- D10: o atleta informa os próprios resultados, evento por evento, com a súmula ou o link oficial.
-- O treinador (ou o gestor) valida; só o resultado validado entra na nota (PERF_RESULTADOS) e nos gates.

-- 1. resultados_regata ganha a fonte `atleta`, a edição (ano), a súmula anexada e a frota opcional.
--    A tabela só aceita inserção (0017): por isso a situação do resultado fica em outra tabela.
--    Linhas antigas ficam sem `edicao`: a leitura usa o ano da data.
alter table resultados_regata
  add column edicao smallint check (edicao is null or edicao between 2000 and 2100),
  add column anexo_id uuid references evidencias_anexos(id);

-- A frota passa a ser opcional (a colocação vale sem ela). A posição só é conferida com a frota.
do $$
declare
  nome text;
begin
  for nome in
    select conname from pg_constraint
     where conrelid = 'resultados_regata'::regclass and contype = 'c'
       and (pg_get_constraintdef(oid) like '%posicao <= tamanho_frota%'
            or conname = 'resultados_regata_fonte_check')
  loop
    execute format('alter table resultados_regata drop constraint %I', nome);
  end loop;
end;
$$;

alter table resultados_regata alter column tamanho_frota drop not null;
alter table resultados_regata
  add constraint resultados_posicao_na_frota check (tamanho_frota is null or posicao <= tamanho_frota),
  add constraint resultados_fonte_check check (fonte in ('ranking_cbvela', 'manual', 'atleta')),
  -- Resultado do atleta: súmula anexada ou link oficial https (a anonimização zera o link).
  add constraint resultados_atleta_com_prova
    check (fonte <> 'atleta' or anexo_id is not null or coalesce(link_oficial ~ '^https://', false) or anonimizado);

create index resultados_anexo_idx on resultados_regata (anexo_id) where anexo_id is not null;

-- 2. Validação: só inserção. A situação vigente é a da validação mais recente; sem validação, pendente.
--    Só resultado do atleta (fonte = 'atleta') é validado: os lançados por gestor e treinador e os do
--    Ranking CBVela já valem.
create table validacoes_resultado (
  id            bigint generated always as identity primary key,
  resultado_id  bigint not null references resultados_regata(id),
  status        text not null check (status in ('validado', 'recusado')),
  motivo        text check (motivo is null or (length(trim(motivo)) > 0 and length(motivo) <= 300)),
  validado_por  uuid not null references usuarios(id),
  validado_em   timestamptz not null default now(),
  check ((status = 'recusado') = (motivo is not null))
);

create index validacoes_resultado_idx on validacoes_resultado (resultado_id, validado_em desc, id desc);
alter table validacoes_resultado enable row level security;

create function validacoes_resultado_insercao() returns trigger
language plpgsql set search_path = public as $$
declare
  de text;
  em timestamptz;
begin
  select r.fonte, a.anonimizado_em into de, em
    from resultados_regata r join atletas a on a.id = r.atleta_id
   where r.id = new.resultado_id for share of a;
  if de is distinct from 'atleta' then
    raise exception 'Só resultado informado pelo atleta passa por validação';
  end if;
  if em is not null then
    raise exception 'Atleta anonimizado: o registro está fechado para alterações'
      using errcode = 'SV409';
  end if;
  return new;
end;
$$;

create trigger validacoes_resultado_valida_insercao before insert on validacoes_resultado
  for each row execute function validacoes_resultado_insercao();

-- Só inserção, com uma exceção: a anonimização do PRÓPRIO atleta (set local scoutvela.anonimizando)
-- troca o `motivo` (texto livre do treinador sobre o atleta) pelo marcador. Nada mais muda; DELETE nunca.
create function validacoes_resultado_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
  dono uuid;
begin
  if tg_op = 'UPDATE' and alvo is not null then
    select atleta_id into dono from resultados_regata where id = old.resultado_id;
    if dono::text = alvo
       and (to_jsonb(new) - 'motivo') = (to_jsonb(old) - 'motivo') then
      return new;
    end if;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

create trigger validacoes_resultado_somente_insercao before update or delete on validacoes_resultado
  for each row execute function validacoes_resultado_controle();

-- Validação mais recente de cada resultado.
create view validacao_resultado_atual with (security_invoker = true) as
  select distinct on (resultado_id)
    id, resultado_id, status, motivo, validado_por, validado_em
  from validacoes_resultado
  order by resultado_id, validado_em desc, id desc;

-- 3. Avisos novos: o atleta informou um resultado (ao treinador) e o treinador decidiu (ao atleta).
alter table avisos drop constraint avisos_tipo_check;
alter table avisos add constraint avisos_tipo_check check (tipo in (
  'atleta_respondeu', 'atleta_anexou', 'atleta_atualizou_perfil',
  'atleta_completou_cadastro', 'pedido_ajuste', 'sugestao_respondida',
  'atleta_autoavaliou', 'autoavaliacao_corrigida',
  'atleta_enviou_pesagem', 'pesagem_validada', 'pesagem_recusada',
  'atleta_lancou_resultado', 'resultado_validado', 'resultado_recusado'));

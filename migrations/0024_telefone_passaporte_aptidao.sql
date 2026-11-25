-- D15 (decisão A): telefone, validade do passaporte (só mês e ano) e aptidão conferida pelo gestor.
-- Não guarda número nem cópia do passaporte, atestado, laudo, CPF, endereço, filiação ou IR.

-- Telefone em E.164 (+5511999998888); o atleta informa e pode apagar.
-- Passaporte: sempre o último dia do mês (o dia não é dado; serve para avisar que vence).
alter table atletas
  add column telefone text
    check (telefone is null or telefone ~ '^\+[1-9][0-9]{7,14}$'),
  add column passaporte_valido_ate date
    check (passaporte_valido_ate is null or extract(day from (passaporte_valido_ate + 1)) = 1);

-- Aptidão para a prática esportiva: o gestor confere o atestado FORA do sistema e registra só o resultado.
-- Série histórica (só inserção): o valor atual é a última linha. Dado de saúde (LGPD, art. 11):
-- sem texto livre e sem arquivo; cada leitura por gestor ou treinador vai para a auditoria.
create table aptidoes (
  id             bigint generated always as identity primary key,
  atleta_id      uuid not null references atletas(id),
  apto           boolean not null,
  conferido_por  uuid not null references usuarios(id),
  conferido_em   timestamptz not null default now()
);

create index aptidoes_atleta_idx on aptidoes (atleta_id, conferido_em desc, id desc);

alter table aptidoes enable row level security;

create view aptidao_atual with (security_invoker = true) as
  select distinct on (atleta_id) id, atleta_id, apto, conferido_por, conferido_em
    from aptidoes
   order by atleta_id, conferido_em desc, id desc;

-- Só inserção, com uma exceção: a anonimização do PRÓPRIO atleta (set local scoutvela.anonimizando)
-- apaga as linhas dele, porque a aptidão é dado de saúde e não pode ficar depois da anonimização.
-- UPDATE e qualquer outro DELETE são recusados.
create function aptidoes_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'DELETE' and alvo is not null and alvo = old.atleta_id::text then
    return old;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

create trigger aptidoes_somente_insercao before update or delete on aptidoes
  for each row execute function aptidoes_controle();

-- Atleta anonimizado não recebe registro novo.
create trigger aptidoes_atleta_anonimizado before insert on aptidoes
  for each row execute function bloqueia_atleta_anonimizado();

-- D9 (decisão F): peso informado pelo atleta. O envio fica numa tabela própria, porque
-- `medidas_corporais` guarda só medida validada. O peso entra no Class Fit e no G1 só depois da
-- validação do treinador (ou do gestor), que cria a medida; a foto da balança sai do Storage.
-- Peso é dado sensível: o IBVAR nunca lê esta tabela.
create table pesagens_atleta (
  id            bigint generated always as identity primary key,
  atleta_id     uuid not null references atletas(id),
  peso_kg       numeric(5,1) not null check (peso_kg between 30 and 160),
  anexo_id      uuid not null references evidencias_anexos(id),
  enviado_em    timestamptz not null default now(),
  status        text not null default 'pendente' check (status in ('pendente', 'validada', 'recusada')),
  motivo        text check (motivo is null or (length(trim(motivo)) > 0 and length(motivo) <= 300)),
  decidido_por  uuid references usuarios(id),
  decidido_em   timestamptz,
  medida_id     bigint references medidas_corporais(id),
  check (
    case status
      when 'pendente' then motivo is null and decidido_por is null and decidido_em is null and medida_id is null
      when 'validada' then motivo is null and decidido_por is not null and decidido_em is not null and medida_id is not null
      else motivo is not null and decidido_por is not null and decidido_em is not null and medida_id is null
    end
  )
);

-- Uma pesagem pendente por atleta.
create unique index pesagens_atleta_uma_pendente on pesagens_atleta (atleta_id) where status = 'pendente';
create index pesagens_atleta_idx on pesagens_atleta (atleta_id, enviado_em desc, id desc);
create index pesagens_atleta_anexo_idx on pesagens_atleta (anexo_id);

alter table pesagens_atleta enable row level security;

-- O envio nunca muda. A única alteração aceita é a decisão: pendente vira validada ou recusada, e
-- só `status`, `motivo`, `decidido_por`, `decidido_em` e `medida_id` mudam. DELETE só na
-- anonimização do PRÓPRIO atleta (set local scoutvela.anonimizando), como aptidões e avisos.
create function pesagens_atleta_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'DELETE' and alvo is not null and alvo = old.atleta_id::text then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'pendente'
     and new.status in ('validada', 'recusada')
     and (to_jsonb(new) - 'status' - 'motivo' - 'decidido_por' - 'decidido_em' - 'medida_id')
         = (to_jsonb(old) - 'status' - 'motivo' - 'decidido_por' - 'decidido_em' - 'medida_id') then
    return new;
  end if;
  raise exception 'Pesagem: só a decisão da pesagem pendente pode mudar o registro';
end;
$$;

create trigger pesagens_atleta_so_decisao before update or delete on pesagens_atleta
  for each row execute function pesagens_atleta_controle();

-- Atleta anonimizado não recebe pesagem nova.
create trigger pesagens_atleta_anonimizado before insert on pesagens_atleta
  for each row execute function bloqueia_atleta_anonimizado();

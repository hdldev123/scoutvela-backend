-- D8: avisos entre treinador e atleta, e pedido de ajuste do treinador ao atleta.
--
-- `avisos` guarda só o fato (tipo, quem, ids na referência): sem nota, peso, texto livre do atleta nem
-- nome de arquivo. O front monta a frase a partir do tipo. Não é série histórica: o destinatário marca
-- como lido (UPDATE de `lido_em`) e um job apaga os lidos há mais de 180 dias (DELETE).
-- A lista de tipos é fechada; tipo novo (D9, D10, D16) entra por migration que troca o check.
create table avisos (
  id              bigint generated always as identity primary key,
  destinatario_id uuid not null references usuarios(id),
  tipo            text not null check (tipo in (
                    'atleta_respondeu', 'atleta_anexou', 'atleta_atualizou_perfil',
                    'atleta_completou_cadastro', 'pedido_ajuste', 'sugestao_respondida')),
  atleta_id       uuid references atletas(id),
  referencia      jsonb not null default '{}'::jsonb
                    check (jsonb_typeof(referencia) = 'object' and length(referencia::text) <= 300),
  criado_por      uuid references usuarios(id),
  criado_em       timestamptz not null default now(),
  lido_em         timestamptz
);

create index avisos_destinatario_idx on avisos (destinatario_id, criado_em desc, id desc);
create index avisos_nao_lidos_idx on avisos (destinatario_id) where lido_em is null;
create index avisos_lidos_idx on avisos (lido_em) where lido_em is not null;
create index avisos_atleta_idx on avisos (atleta_id) where atleta_id is not null;

alter table avisos enable row level security;

-- Pedido de ajuste: o treinador (ou o gestor) pede ao atleta que revise algo. Só inserção.
-- `indicador_id` nulo = sobre o perfil ou algo geral. A mensagem é texto livre (dado do atleta): sai
-- na anonimização.
create table pedidos_ajuste (
  id           bigint generated always as identity primary key,
  atleta_id    uuid not null references atletas(id),
  indicador_id text references indicadores(id),
  mensagem     text not null check (length(trim(mensagem)) between 1 and 300),
  criado_por   uuid not null references usuarios(id),
  criado_em    timestamptz not null default now()
);

create index pedidos_ajuste_atleta_idx on pedidos_ajuste (atleta_id, criado_em desc);

alter table pedidos_ajuste enable row level security;

-- Só inserção, com uma exceção: a anonimização do PRÓPRIO atleta (set local scoutvela.anonimizando)
-- apaga as linhas dele. UPDATE e qualquer outro DELETE são recusados.
create function pedidos_ajuste_controle() returns trigger
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

create trigger pedidos_ajuste_somente_insercao before update or delete on pedidos_ajuste
  for each row execute function pedidos_ajuste_controle();

-- Atleta anonimizado não recebe registro novo.
create trigger pedidos_ajuste_atleta_anonimizado before insert on pedidos_ajuste
  for each row execute function bloqueia_atleta_anonimizado();

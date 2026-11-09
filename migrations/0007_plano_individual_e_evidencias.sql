-- Plano individual registrado por uma pessoa (a sugestão do sistema é calculada na API)
-- e evidências anexadas às notas (arquivo no Storage; aqui só os metadados).
-- Ambas as tabelas são série histórica: só inserção.

create table plano_individual (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  forcas          text not null check (length(trim(forcas)) between 1 and 1000),
  lacunas         text not null check (length(trim(lacunas)) between 1 and 1000),
  meta_12m        text not null check (length(trim(meta_12m)) between 1 and 1000),
  meta_24m        text not null check (length(trim(meta_24m)) between 1 and 1000),
  recomendacao    text not null check (length(trim(recomendacao)) between 1 and 1000),
  registrado_por  uuid not null references usuarios(id),
  registrado_em   timestamptz not null default now()
);

create index plano_atual_idx on plano_individual (atleta_id, registrado_em desc, id desc);
create trigger plano_somente_insercao before update or delete on plano_individual
  for each row execute function impede_alteracao();

create view plano_atual with (security_invoker = true) as
  select distinct on (atleta_id)
    id, atleta_id, forcas, lacunas, meta_12m, meta_24m, recomendacao, registrado_por, registrado_em
  from plano_individual
  order by atleta_id, registrado_em desc, id desc;

alter table plano_individual enable row level security;

-- Metadados das evidências anexadas. O arquivo fica no Storage (bucket privado), em `caminho`.
create table evidencias_anexos (
  id             uuid primary key default gen_random_uuid(),
  atleta_id      uuid not null references atletas(id),
  indicador_id   text references indicadores(id),
  nome_arquivo   text not null check (length(nome_arquivo) between 1 and 200),
  tipo_mime      text not null check (tipo_mime in ('application/pdf', 'image/jpeg', 'image/png')),
  tamanho_bytes  integer not null check (tamanho_bytes > 0 and tamanho_bytes <= 5242880),
  caminho        text not null unique,
  sha256         text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  enviado_por    uuid not null references usuarios(id),
  enviado_em     timestamptz not null default now()
);

create index evidencias_atleta_idx on evidencias_anexos (atleta_id, enviado_em desc);
create trigger evidencias_somente_insercao before update or delete on evidencias_anexos
  for each row execute function impede_alteracao();
alter table evidencias_anexos enable row level security;

alter table avaliacoes add column anexo_id uuid references evidencias_anexos(id);

-- Mesma definição da 0005, com anexo_id no fim da lista de colunas.
create or replace view avaliacao_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id)
    id, atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em, anexo_id
  from avaliacoes
  where origem <> 'resposta_sugerida'
  order by atleta_id, indicador_id, lancado_em desc, id desc;

-- Bucket privado das evidências. Só roda no Supabase (no Postgres puro/PGlite não há schema storage).
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('evidencias', 'evidencias', false, 5242880, array['application/pdf', 'image/jpeg', 'image/png'])
    on conflict (id) do nothing;
  end if;
end;
$$;

-- D7: sugestões do treinador ao gestor (faixas do Class Fit, parâmetros, sistema).
-- Aprovar NÃO muda o parâmetro: a mudança segue por PUT /parametros, com a auditoria de sempre.
create table sugestoes (
  id             bigint generated always as identity primary key,
  autor_id       uuid not null references usuarios(id),
  tipo           text not null check (tipo in ('class_fit', 'parametro', 'sistema')),
  classe_id      text references classes(id),
  proposta       jsonb,
  texto          text not null check (length(trim(texto)) between 1 and 1000),
  status         text not null default 'aberta' check (status in ('aberta', 'aprovada', 'recusada')),
  resposta       text check (resposta is null or length(trim(resposta)) between 1 and 1000),
  respondido_por uuid references usuarios(id),
  respondido_em  timestamptz,
  criado_em      timestamptz not null default now(),
  check ((tipo = 'class_fit') = (classe_id is not null and proposta is not null)),
  check (tipo = 'class_fit' or (classe_id is null and proposta is null)),
  check ((status = 'aberta') = (respondido_por is null and respondido_em is null)),
  check (status <> 'recusada' or resposta is not null),
  check (status <> 'aberta' or resposta is null)
);

create index sugestoes_autor_idx on sugestoes (autor_id, criado_em desc);
create index sugestoes_abertas_idx on sugestoes (criado_em) where status = 'aberta';

alter table sugestoes enable row level security;

-- Lembretes do ciclo enviados por e-mail (evita reenvio no mesmo dia) e
-- pedidos do titular de dados (LGPD, art. 18).

-- Um registro por pessoa, ciclo, tipo de lembrete e dia. Sem e-mail nem texto: só ids.
create table lembretes_enviados (
  id          bigint generated always as identity primary key,
  ciclo_id    uuid not null references ciclos_avaliacao(id),
  usuario_id  uuid not null references usuarios(id),
  tipo        text not null check (tipo in ('treinador', 'atleta')),
  enviado_em  timestamptz not null default now(),
  dia         date not null,
  unique (ciclo_id, usuario_id, tipo, dia)
);

-- Pedido do atleta sobre os próprios dados. A exclusão em si é procedimento manual do gestor
-- (a série histórica só aceita inserção); aqui fica o pedido e a resposta.
create table pedidos_titular (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  tipo            text not null check (tipo in ('acesso', 'correcao', 'exclusao', 'revogacao')),
  descricao       text not null check (length(trim(descricao)) between 10 and 2000),
  status          text not null default 'aberto' check (status in ('aberto', 'respondido')),
  resposta        text,
  criado_por      uuid not null references usuarios(id),
  criado_em       timestamptz not null default now(),
  respondido_por  uuid references usuarios(id),
  respondido_em   timestamptz,
  check ((status = 'respondido') = (resposta is not null and respondido_por is not null and respondido_em is not null))
);

create index pedidos_titular_atleta_idx on pedidos_titular (atleta_id, criado_em desc);
create index pedidos_titular_abertos_idx on pedidos_titular (status) where status = 'aberto';

alter table lembretes_enviados enable row level security;
alter table pedidos_titular enable row level security;

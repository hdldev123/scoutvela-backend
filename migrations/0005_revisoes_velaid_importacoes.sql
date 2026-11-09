-- Nota sugerida pela resposta do atleta não vale no score até o avaliador confirmar.
-- avaliacao_atual passa a considerar só notas confirmadas; a sugestão pendente fica à parte.
create or replace view avaliacao_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id)
    id, atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em
  from avaliacoes
  where origem <> 'resposta_sugerida'
  order by atleta_id, indicador_id, lancado_em desc, id desc;

-- Última sugestão do atleta mais nova que a última nota confirmada do indicador.
create view sugestao_pendente with (security_invoker = true) as
  select distinct on (s.atleta_id, s.indicador_id)
    s.id, s.atleta_id, s.indicador_id, s.ciclo_id, s.valor, s.lancado_em
  from avaliacoes s
  where s.origem = 'resposta_sugerida'
    and not exists (
      select 1 from avaliacoes c
      where c.atleta_id = s.atleta_id and c.indicador_id = s.indicador_id
        and c.origem <> 'resposta_sugerida' and c.lancado_em >= s.lancado_em
    )
  order by s.atleta_id, s.indicador_id, s.lancado_em desc, s.id desc;

-- Pedido de revisão de nota pelo atleta (LGPD, art. 20).
create table pedidos_revisao (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  pilar_id        text references pilares(id),
  indicador_id    text references indicadores(id),
  motivo          text not null check (length(trim(motivo)) between 10 and 2000),
  status          text not null default 'aberto' check (status in ('aberto', 'respondido')),
  resposta        text,
  criado_por      uuid not null references usuarios(id),
  criado_em       timestamptz not null default now(),
  respondido_por  uuid references usuarios(id),
  respondido_em   timestamptz,
  check ((status = 'respondido') = (resposta is not null and respondido_por is not null and respondido_em is not null))
);

create index pedidos_revisao_atleta_idx on pedidos_revisao (atleta_id, criado_em desc);
create index pedidos_revisao_abertos_idx on pedidos_revisao (status) where status = 'aberto';

-- Cadastro único da CBVela (VelaID). Sem API no MVP: vem por importação de CSV (ou simulado no seed).
-- Só os campos que o Scout Vela usa: nada de CPF, documento ou endereço completo.
create table velaid_registros (
  codigo           text primary key check (codigo = upper(codigo)),
  nome             text not null,
  genero           text not null check (genero in ('F', 'M')),
  data_nascimento  date not null,
  clube            text,
  cidade           text,
  uf               char(2),
  ws_id            text,
  email            text,
  fonte            text not null check (fonte in ('simulado', 'csv')),
  atualizado_em    timestamptz not null default now()
);

-- Registro de cada importação de CSV (VelaID ou Ranking CBVela).
create table importacoes (
  id             bigint generated always as identity primary key,
  tipo           text not null check (tipo in ('velaid', 'ranking_cbvela')),
  arquivo_nome   text,
  linhas_ok      integer not null default 0,
  linhas_erro    integer not null default 0,
  erros          jsonb not null default '[]'::jsonb,
  importado_por  uuid not null references usuarios(id),
  importado_em   timestamptz not null default now()
);

alter table pedidos_revisao enable row level security;
alter table velaid_registros enable row level security;
alter table importacoes enable row level security;

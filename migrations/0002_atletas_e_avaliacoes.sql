-- Cadastro do atleta, consentimentos, ciclos, série histórica de notas, medidas,
-- resultados de regata, gates, financeiro da campanha e trilha de auditoria.
--
-- Série histórica: tabelas de lançamento só aceitam INSERT. O valor atual é o
-- último lançamento (views *_atual). Nada é sobrescrito.

create function impede_alteracao() returns trigger
language plpgsql as $$
begin
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

-- Atleta do piloto. Identificado pelo código VelaID. Não guarda CPF, documento,
-- endereço completo nem renda (LGPD: só o que pontua ou apoia decisão).
create table atletas (
  id               uuid primary key default gen_random_uuid(),
  velaid_codigo    text not null unique,
  nome             text not null,
  genero           text not null check (genero in ('F', 'M')),
  data_nascimento  date not null,
  classe_id        text not null references classes(id),
  clube            text,
  cidade           text,
  uf               char(2),
  numero_vela      text,
  ws_id            text,  -- ID World Sailing, quando vier do VelaID
  treinador_id     uuid references usuarios(id),
  email_contato    text,
  ativo            boolean not null default true,
  criado_em        timestamptz not null default now(),
  criado_por       uuid references usuarios(id)
);

create index atletas_treinador_idx on atletas (treinador_id);

alter table usuarios
  add constraint usuarios_atleta_fk foreign key (atleta_id) references atletas(id),
  add constraint usuarios_atleta_vinculado check (papel <> 'atleta' or atleta_id is not null);

-- Consentimentos (histórico). Atual = último registro por atleta e tipo.
create table consentimentos (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  tipo            text not null check (tipo in ('termo_piloto', 'compartilhar_ibvar')),
  concedido       boolean not null,
  versao_termo    text,
  registrado_em   timestamptz not null default now(),
  registrado_por  uuid references usuarios(id)
);

create index consentimentos_atual_idx on consentimentos (atleta_id, tipo, registrado_em desc, id desc);
create trigger consentimentos_somente_insercao before update or delete on consentimentos
  for each row execute function impede_alteracao();

create view consentimento_atual with (security_invoker = true) as
  select distinct on (atleta_id, tipo) atleta_id, tipo, concedido, versao_termo, registrado_em
  from consentimentos
  order by atleta_id, tipo, registrado_em desc, id desc;

-- Ciclo de avaliação: rodada mensal com prazo. Só um aberto por vez.
create table ciclos_avaliacao (
  id      uuid primary key default gen_random_uuid(),
  nome    text not null unique,
  inicio  date not null,
  prazo   date not null,
  status  text not null check (status in ('aberto', 'fechado')),
  check (prazo >= inicio)
);

create unique index ciclos_um_aberto on ciclos_avaliacao (status) where status = 'aberto';

-- Notas lançadas (série histórica). origem:
--   avaliacao            nota do treinador ou do gestor
--   resposta_confirmada  resposta do atleta pontuada pelo avaliador
--   resposta_sugerida    nota sugerida pela resposta do atleta, aguardando avaliador
-- Indicadores calculados (ex.: cf_peso_kg) não têm lançamento aqui.
create table avaliacoes (
  id            bigint generated always as identity primary key,
  atleta_id     uuid not null references atletas(id),
  indicador_id  text not null references indicadores(id),
  ciclo_id      uuid references ciclos_avaliacao(id),
  valor         smallint not null check (valor between 0 and 5),
  evidencia     text not null check (length(trim(evidencia)) > 0),
  origem        text not null check (origem in ('avaliacao', 'resposta_confirmada', 'resposta_sugerida')),
  avaliador_id  uuid references usuarios(id),
  lancado_em    timestamptz not null default now(),
  check (origem = 'resposta_sugerida' or avaliador_id is not null)
);

create index avaliacoes_atual_idx on avaliacoes (atleta_id, indicador_id, lancado_em desc, id desc);
create trigger avaliacoes_somente_insercao before update or delete on avaliacoes
  for each row execute function impede_alteracao();

create view avaliacao_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id)
    id, atleta_id, indicador_id, ciclo_id, valor, evidencia, origem, avaliador_id, lancado_em
  from avaliacoes
  order by atleta_id, indicador_id, lancado_em desc, id desc;

-- Respostas do atleta aos questionários (série histórica).
create table respostas_atleta (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  indicador_id    text not null references perguntas_atleta(indicador_id),
  ciclo_id        uuid references ciclos_avaliacao(id),
  resposta        text not null,
  respondido_em   timestamptz not null default now(),
  respondido_por  uuid references usuarios(id)
);

create index respostas_atual_idx on respostas_atleta (atleta_id, indicador_id, respondido_em desc, id desc);
create trigger respostas_somente_insercao before update or delete on respostas_atleta
  for each row execute function impede_alteracao();

create view resposta_atual with (security_invoker = true) as
  select distinct on (atleta_id, indicador_id) id, atleta_id, indicador_id, ciclo_id, resposta, respondido_em
  from respostas_atleta
  order by atleta_id, indicador_id, respondido_em desc, id desc;

-- Medidas corporais (dado sensível). Peso alimenta Class Fit (P3 e gate G1).
create table medidas_corporais (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  peso_kg         numeric(5,1) check (peso_kg between 30 and 160),
  altura_cm       numeric(5,1) check (altura_cm between 120 and 230),
  medido_em       timestamptz not null,
  evidencia       text not null,
  registrado_por  uuid not null references usuarios(id),
  registrado_em   timestamptz not null default now(),
  check (peso_kg is not null or altura_cm is not null)
);

create index medidas_atual_idx on medidas_corporais (atleta_id, medido_em desc, id desc);
create trigger medidas_somente_insercao before update or delete on medidas_corporais
  for each row execute function impede_alteracao();

-- Resultados de regata. Nacionais vêm do Ranking CBVela (com os pontos oficiais);
-- internacionais são lançados à mão, com link do resultado oficial.
create table resultados_regata (
  id              bigint generated always as identity primary key,
  atleta_id       uuid not null references atletas(id),
  nivel           text not null check (nivel in ('mundial', 'sul_americano', 'continental', 'internacional_aberto', 'brasileiro', 'estadual', 'regional')),
  evento          text not null,
  data            date not null,
  posicao         integer not null check (posicao > 0),
  tamanho_frota   integer not null check (tamanho_frota > 0),
  internacional   boolean not null,
  pontos_cbvela   numeric(7,2),
  fonte           text not null check (fonte in ('ranking_cbvela', 'manual')),
  link_oficial    text,
  registrado_por  uuid references usuarios(id),
  registrado_em   timestamptz not null default now(),
  check (posicao <= tamanho_frota),
  check (fonte <> 'manual' or link_oficial is not null),
  check (not internacional or pontos_cbvela is null)
);

create index resultados_atleta_idx on resultados_regata (atleta_id, data desc);

-- Decisões do gestor sobre os gates. Sem decisão vale a sugestão automática.
-- status nulo = o gestor devolveu o gate à sugestão automática.
create table gates_decisoes (
  id             bigint generated always as identity primary key,
  atleta_id      uuid not null references atletas(id),
  gate           smallint not null check (gate between 1 and 4),
  status         text check (status in ('apto', 'condicional', 'alerta')),
  justificativa  text,
  decidido_por   uuid not null references usuarios(id),
  decidido_em    timestamptz not null default now()
);

create index gates_atual_idx on gates_decisoes (atleta_id, gate, decidido_em desc, id desc);
create trigger gates_somente_insercao before update or delete on gates_decisoes
  for each row execute function impede_alteracao();

create view gate_decisao_atual with (security_invoker = true) as
  select distinct on (atleta_id, gate) atleta_id, gate, status, justificativa, decidido_por, decidido_em
  from gates_decisoes
  order by atleta_id, gate, decidido_em desc, id desc;

-- Financeiro da campanha. Não entra no score. Perfil de suporte informado pelo gestor (P8).
create table financeiro_campanha (
  id                  bigint generated always as identity primary key,
  atleta_id           uuid not null references atletas(id),
  perfil_suporte      char(1) not null check (perfil_suporte in ('A', 'B', 'C', 'D')),
  meses_assegurados   smallint check (meses_assegurados >= 0),
  patrocinio_privado  text check (patrocinio_privado in ('sim', 'em_negociacao', 'nao')),
  informado_por       uuid not null references usuarios(id),
  informado_em        timestamptz not null default now()
);

create index financeiro_atual_idx on financeiro_campanha (atleta_id, informado_em desc, id desc);
create trigger financeiro_somente_insercao before update or delete on financeiro_campanha
  for each row execute function impede_alteracao();

create table financeiro_componentes (
  financeiro_id  bigint not null references financeiro_campanha(id),
  componente_id  text not null references componentes_custo(id),
  autonomia      text not null check (autonomia in ('alta', 'parcial', 'baixa')),
  apoio_cbvela   text not null check (apoio_cbvela in ('baixa', 'media', 'alta')),
  primary key (financeiro_id, componente_id)
);

create view financeiro_atual with (security_invoker = true) as
  select distinct on (atleta_id) id, atleta_id, perfil_suporte, meses_assegurados, patrocinio_privado, informado_por, informado_em
  from financeiro_campanha
  order by atleta_id, informado_em desc, id desc;

-- Score fechado de cada ciclo (calculado pelo sistema no fechamento do ciclo).
create table scores_ciclo (
  atleta_id     uuid not null references atletas(id),
  ciclo_id      uuid not null references ciclos_avaliacao(id),
  score         numeric(6,3) not null check (score between 0 and 100),
  faixa_id      text not null references faixas_score(id),
  calculado_em  timestamptz not null default now(),
  primary key (atleta_id, ciclo_id)
);

-- Trilha de auditoria: quem fez o quê, quando. Sem dado sensível em detalhes.
create table auditoria (
  id           bigint generated always as identity primary key,
  usuario_id   uuid references usuarios(id),
  acao         text not null,
  entidade     text not null,
  entidade_id  text,
  detalhes     jsonb,
  em           timestamptz not null default now()
);

create trigger auditoria_somente_insercao before update or delete on auditoria
  for each row execute function impede_alteracao();

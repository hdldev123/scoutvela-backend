-- Usuários, papéis e parâmetros da metodologia.
-- Parâmetros (pesos, classes, faixas, rubricas, regras provisórias) ficam no banco,
-- editáveis pelo gestor. Nada disso é constante no código.

-- Usuário do Scout Vela. O login é do Supabase Auth (auth.users); aqui fica o papel.
-- auth_user_id nulo = pessoa cadastrada sem login (ex.: treinador ainda sem conta).
create table usuarios (
  id            uuid primary key default gen_random_uuid(),
  auth_user_id  uuid unique,
  email         text not null unique check (email = lower(email)),
  nome          text not null,
  papel         text not null check (papel in ('gestor', 'treinador', 'atleta', 'ibvar', 'responsavel')),
  atleta_id     uuid,  -- FK criada em 0002; obrigatório para papel atleta
  ativo         boolean not null default true,
  criado_em     timestamptz not null default now()
);

comment on column usuarios.papel is 'responsavel: fluxo de menores, previsto e desligado no piloto 18+';

-- 9 pilares da avaliação multidimensional. peso = pontos no score de 100.
create table pilares (
  id                text primary key,
  nome              text not null,
  nome_curto        text not null,
  peso              numeric(5,2) not null check (peso >= 0 and peso <= 100),
  sensivel          boolean not null default false,
  evidencia_padrao  text not null,
  ordem             smallint not null unique
);

-- Catálogo de indicadores. tipo:
--   T = treinador avalia
--   A = atleta responde, treinador pontua
--   R = registrado, não pontua (P5)
-- calculado = a nota é derivada pelo sistema (ex.: cf_peso_kg pela regra P3), nunca digitada.
create table indicadores (
  id         text primary key,
  pilar_id   text not null references pilares(id),
  nome       text not null,
  tipo       text not null check (tipo in ('T', 'A', 'R')),
  calculado  boolean not null default false,
  ordem      smallint not null,
  unique (pilar_id, ordem),
  check (not (calculado and tipo <> 'T'))
);

-- Perguntas que o atleta responde (indicadores tipo A e R).
create table perguntas_atleta (
  indicador_id  text primary key references indicadores(id),
  enunciado     text not null
);

create table opcoes_resposta (
  indicador_id   text not null references perguntas_atleta(indicador_id),
  ordem          smallint not null,
  texto          text not null,
  nota_sugerida  smallint check (nota_sugerida between 0 and 5),  -- nulo = não pontua
  primary key (indicador_id, ordem)
);

-- Faixas de score: 85+ prioridade, 75+ alto potencial, 65+ em desenvolvimento, abaixo no radar.
create table faixas_score (
  id          text primary key,
  nome        text not null,
  nome_curto  text not null,
  score_min   numeric(5,2) not null check (score_min >= 0 and score_min <= 100),
  ordem       smallint not null unique
);

-- Rubricas de 0 a 5. pilar_id nulo = escala geral (P1: só Experiência tem rubrica própria).
create table rubricas (
  id         bigint generated always as identity primary key,
  pilar_id   text references pilares(id),
  nota       smallint not null check (nota between 0 and 5),
  descricao  text not null,
  unique nulls not distinct (pilar_id, nota)
);

-- Classes e posições com a faixa de peso de referência (Class Fit).
create table classes (
  id             text primary key,
  nome           text not null,
  evento         text not null,
  posicao        text not null check (posicao in ('helm', 'crew', 'ind')),
  peso_min_kg    numeric(5,1) not null,
  peso_medio_kg  numeric(5,1) not null,
  peso_max_kg    numeric(5,1) not null,
  ativa          boolean not null default true,
  ordem          smallint not null unique,
  check (peso_min_kg <= peso_medio_kg and peso_medio_kg <= peso_max_kg)
);

-- Componentes de custo da campanha (sustentabilidade financeira).
create table componentes_custo (
  id     text primary key,
  nome   text not null,
  ordem  smallint not null unique
);

-- Regras provisórias e limites usados no cálculo (P3, gates, janela do Ranking CBVela).
-- valor em jsonb para cada regra evoluir sem migration de estrutura.
create table regras (
  codigo          text primary key,
  descricao       text not null,
  valor           jsonb not null,
  atualizado_em   timestamptz not null default now(),
  atualizado_por  uuid references usuarios(id)
);

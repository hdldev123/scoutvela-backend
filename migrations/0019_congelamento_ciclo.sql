-- D3: ao fechar o ciclo, congela também a nota de cada pilar, o status de cada gate, o status final e o
-- perfil de suporte de cada atleta (antes só score e faixa). O painel do investidor lê daqui.

-- ---------------------------------------------------------------------------------------------
-- 1. Quando o ciclo foi fechado e se o congelamento é completo.
--    Ciclos fechados antes desta migration só têm score e faixa: ficam com congelamento_completo = false
--    e fechado_em = último calculado_em de scores_ciclo (a data do fechamento também está na auditoria).
-- ---------------------------------------------------------------------------------------------
alter table ciclos_avaliacao
  add column fechado_em timestamptz,
  add column congelamento_completo boolean not null default false,
  add constraint ciclos_fechado_em_status check (status = 'fechado' or fechado_em is null),
  add constraint ciclos_congelamento_status check (status = 'fechado' or not congelamento_completo);

update ciclos_avaliacao c
   set fechado_em = (select max(s.calculado_em) from scores_ciclo s where s.ciclo_id = c.id)
 where c.status = 'fechado';

-- ---------------------------------------------------------------------------------------------
-- 2. Congelamento por atleta e ciclo. Séries só de inserção, como scores_ciclo.
--    Nota do pilar em double precision: guarda a média exata calculada no fechamento.
-- ---------------------------------------------------------------------------------------------
create table pilares_ciclo (
  atleta_id  uuid not null references atletas(id),
  ciclo_id   uuid not null references ciclos_avaliacao(id),
  pilar_id   text not null references pilares(id),
  nota       double precision check (nota between 0 and 5),  -- nulo: pilar sem nota no fechamento
  primary key (atleta_id, ciclo_id, pilar_id)
);

create table gates_ciclo (
  atleta_id  uuid not null references atletas(id),
  ciclo_id   uuid not null references ciclos_avaliacao(id),
  gate       smallint not null check (gate between 1 and 4),
  status     text not null check (status in ('apto', 'condicional', 'alerta')),
  primary key (atleta_id, ciclo_id, gate)
);

-- Status final pelos 4 gates (P7), perfil de suporte (nulo se o financeiro não estava informado) e
-- meses assegurados (só o gestor vê; o IBVAR nunca recebe).
create table fechamento_atleta_ciclo (
  atleta_id          uuid not null references atletas(id),
  ciclo_id           uuid not null references ciclos_avaliacao(id),
  status_final       text not null check (status_final in ('apto', 'condicional', 'nao_prioritario')),
  perfil_suporte     text check (perfil_suporte in ('A', 'B', 'C', 'D')),
  meses_assegurados  integer,
  primary key (atleta_id, ciclo_id)
);

create trigger pilares_ciclo_somente_insercao before update or delete on pilares_ciclo
  for each row execute function impede_alteracao();
create trigger gates_ciclo_somente_insercao before update or delete on gates_ciclo
  for each row execute function impede_alteracao();
create trigger fechamento_atleta_ciclo_somente_insercao before update or delete on fechamento_atleta_ciclo
  for each row execute function impede_alteracao();

alter table pilares_ciclo enable row level security;
alter table gates_ciclo enable row level security;
alter table fechamento_atleta_ciclo enable row level security;

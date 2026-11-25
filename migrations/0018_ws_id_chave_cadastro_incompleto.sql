-- D1: o ID World Sailing passa a ser a chave do atleta; o VelaID fica opcional; o cadastro
-- é completado pelo próprio atleta no primeiro acesso (nome, gênero e data de nascimento).

-- ---------------------------------------------------------------------------------------------
-- 1. WS ID: normalizado (maiúsculas, sem espaços), único e obrigatório.
--    Quem já tem WS ID válido (vindo do VelaID) mantém. Quem não tem, ou repete o de outro,
--    recebe um fictício `BRA` + 9 caracteres do hash do próprio id (dado de desenvolvimento/homologação:
--    em produção a base nasce sem atletas, e o gestor informa o WS ID real no PUT /atletas/:id).
-- ---------------------------------------------------------------------------------------------
with normalizado as (
  select id,
         upper(regexp_replace(coalesce(ws_id, ''), '\s', '', 'g')) as ws,
         row_number() over (
           partition by upper(regexp_replace(coalesce(ws_id, ''), '\s', '', 'g'))
           order by criado_em, id) as ordem
    from atletas
)
update atletas a
   set ws_id = case
                 when n.ws ~ '^[A-Z]{3}[A-Z0-9]{2,12}$' and n.ordem = 1 then n.ws
                 else 'BRA' || upper(substr(md5(a.id::text), 1, 9))
               end
  from normalizado n
 where n.id = a.id;

alter table atletas
  alter column ws_id set not null,
  add constraint atletas_ws_id_formato check (ws_id ~ '^[A-Z]{3}[A-Z0-9]{2,12}$'),
  add constraint atletas_ws_id_unico unique (ws_id);

-- ---------------------------------------------------------------------------------------------
-- 2. VelaID opcional (continua único quando preenchido: a unique já ignora nulos).
-- ---------------------------------------------------------------------------------------------
alter table atletas alter column velaid_codigo drop not null;

-- ---------------------------------------------------------------------------------------------
-- 3. Cadastro completado pelo atleta. Atletas já existentes ficam completos.
--    cadastro_recusado_em: o atleta informou menos de 18 anos no primeiro acesso (a API não grava
--    a data, inativa o atleta e a conta). Só o instante; o gestor vê no balão de Cadastro e remove
--    o cadastro pela anonimização.
-- ---------------------------------------------------------------------------------------------
alter table atletas
  add column cadastro_completo_em timestamptz,
  add column cadastro_recusado_em timestamptz;

update atletas set cadastro_completo_em = criado_em;

alter table atletas
  alter column nome drop not null,
  alter column genero drop not null,
  alter column data_nascimento drop not null,
  add constraint atletas_cadastro_completo_dados check (
    cadastro_completo_em is null
    or (nome is not null and genero is not null and data_nascimento is not null)),
  add constraint atletas_cadastro_recusado_incompleto check (
    cadastro_recusado_em is null or cadastro_completo_em is null);

-- Atleta ativo com cadastro incompleto: lista do gestor e balão de Cadastro.
create index atletas_cadastro_incompleto_idx on atletas (id) where cadastro_completo_em is null;

-- Os gatilhos de só-inserção (0015, 0017) e os de atleta anonimizado olham `atleta_id` das
-- tabelas de série e a variável `scoutvela.anonimizando`; nenhum lê colunas de `atletas`
-- que mudaram aqui. A anonimização passa a trocar o ws_id por um valor neutro e único
-- (ANON + 8 hexadecimais), que respeita o formato acima.

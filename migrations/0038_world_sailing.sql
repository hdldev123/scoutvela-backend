-- D19: importação do perfil World Sailing pelo WS ID.
--   * Os resultados da World Sailing entram com a fonte `world_sailing`: valem direto (fonte oficial) e
--     saem da nota e dos gates só se o treinador ou o gestor os invalidar (com motivo), em
--     `validacoes_resultado`. Dá para revalidar.
--   * `world_sailing_ranking`: histórico de ranking do atleta (só informação, não entra na nota).
--   * `world_sailing_perfis`: SUGESTÃO de nome, gênero, nascimento, foto e bio para o atleta confirmar.
--   * `world_sailing_importacoes`: histórico de cada busca (só números e um código curto de erro).
--   * Regra provisória P13 `WS_NIVEIS`: nível do evento na World Sailing -> nível no Scout Vela.
-- Nunca se guarda: estado civil, local de nascimento, altura, peso, perguntas do perfil, redes sociais,
-- categorização nem dados de outros velejadores.

-- 1. resultados_regata: fonte `world_sailing` e a referência do resultado na World Sailing.
alter table resultados_regata drop constraint resultados_fonte_check;
alter table resultados_regata
  add column ws_ref text check (ws_ref is null or (length(ws_ref) between 1 and 80)),
  add constraint resultados_fonte_check
    check (fonte in ('ranking_cbvela', 'manual', 'atleta', 'world_sailing')),
  -- A anonimização zera a referência (e marca a linha como anonimizada).
  add constraint resultados_ws_com_ref
    check (fonte <> 'world_sailing' or ws_ref is not null or anonimizado);

-- Uma importação nunca duplica o mesmo resultado do atleta.
create unique index resultados_ws_ref_unico on resultados_regata (atleta_id, ws_ref)
  where ws_ref is not null;

-- Só inserção, com a exceção da anonimização do PRÓPRIO atleta (que agora também zera `ws_ref`).
create or replace function resultados_regata_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'UPDATE'
     and alvo is not null and alvo = old.atleta_id::text
     and new.anonimizado and new.link_oficial is null and new.ws_ref is null
     and (to_jsonb(new) - 'evento' - 'link_oficial' - 'anonimizado' - 'ws_ref')
         = (to_jsonb(old) - 'evento' - 'link_oficial' - 'anonimizado' - 'ws_ref') then
    return new;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

-- 2. Validação: aceita também o resultado da World Sailing (invalidar e revalidar).
--    Situação vigente: atleta = só se a última validação for `validado`; world_sailing = vale sem validação
--    ou se a última for `validado`, e sai se a última for `recusado`; manual e ranking_cbvela = sempre valem.
create or replace function validacoes_resultado_insercao() returns trigger
language plpgsql set search_path = public as $$
declare
  de text;
  em timestamptz;
begin
  select r.fonte, a.anonimizado_em into de, em
    from resultados_regata r join atletas a on a.id = r.atleta_id
   where r.id = new.resultado_id for share of a;
  if de is null or de not in ('atleta', 'world_sailing') then
    raise exception 'Só resultado informado pelo atleta ou importado da World Sailing passa por validação';
  end if;
  if em is not null then
    raise exception 'Atleta anonimizado: o registro está fechado para alterações'
      using errcode = 'SV409';
  end if;
  return new;
end;
$$;

-- 3. Histórico de ranking da World Sailing (só informação).
create table world_sailing_ranking (
  id           bigint generated always as identity primary key,
  atleta_id    uuid not null references atletas(id),
  ws_ref       text not null check (length(ws_ref) between 1 and 80),
  data         date not null,
  classe       text not null check (length(classe) between 1 and 120),
  tipo         text check (tipo is null or length(tipo) between 1 and 120),
  posicao      integer not null check (posicao > 0),
  pontos       numeric(12,2),
  importado_em timestamptz not null default now(),
  unique (atleta_id, ws_ref)
);
create index world_sailing_ranking_idx on world_sailing_ranking (atleta_id, data desc, id);
alter table world_sailing_ranking enable row level security;
create trigger world_sailing_ranking_atleta_anonimizado before insert on world_sailing_ranking
  for each row execute function bloqueia_atleta_anonimizado();

-- 4. Sugestão do perfil: o atleta confirma nome, gênero e nascimento no primeiro acesso e aceita ou
--    dispensa foto e bio no perfil. Nunca entra no score.
create table world_sailing_perfis (
  atleta_id            uuid primary key references atletas(id),
  ws_sailor_id         text check (ws_sailor_id is null or length(ws_sailor_id) <= 80),
  nome                 text check (nome is null or length(nome) between 1 and 120),
  genero               text check (genero is null or genero in ('F', 'M')),
  data_nascimento      date,
  foto_url             text check (foto_url is null or foto_url ~ '^https://assets\.sailing\.org/'),
  bio                  text check (bio is null or length(bio) <= 2000),
  importado_em         timestamptz not null default now(),
  foto_bio_decidida_em timestamptz
);
alter table world_sailing_perfis enable row level security;
create trigger world_sailing_perfis_atleta_anonimizado before insert on world_sailing_perfis
  for each row execute function bloqueia_atleta_anonimizado();

-- 5. Histórico de cada busca. `erro` guarda só o código curto (nunca o corpo da resposta).
create table world_sailing_importacoes (
  id                 bigint generated always as identity primary key,
  atleta_id          uuid not null references atletas(id),
  executada_em       timestamptz not null default now(),
  por                uuid references usuarios(id),
  modo               text not null check (modo in ('real', 'simulado')),
  status             text not null check (status in ('ok', 'nao_encontrado', 'falhou')),
  resultados_novos   integer not null default 0 check (resultados_novos >= 0),
  ranking_novos      integer not null default 0 check (ranking_novos >= 0),
  erro               text check (erro is null or length(erro) <= 40)
);
create index world_sailing_importacoes_idx on world_sailing_importacoes (atleta_id, executada_em desc, id desc);
alter table world_sailing_importacoes enable row level security;
create trigger world_sailing_importacoes_atleta_anonimizado before insert on world_sailing_importacoes
  for each row execute function bloqueia_atleta_anonimizado();

-- 6. Regra provisória P13: nível do evento na World Sailing -> nível de competição do Scout Vela.
--    O que não está na regra (ou vem sem nível) vira `internacional_aberto`: fica registrado e não pontua.
insert into regras (codigo, descricao, valor) values
  ('WS_NIVEIS',
   'Mapeamento do nível do evento na World Sailing para o nível de competição do Scout Vela (mundial, sul_americano, continental, internacional_aberto, brasileiro, estadual, regional). Nível ausente da regra, ou evento sem nível, vira internacional_aberto (registrado, sem nota). Provisória (P13): à espera da confirmação da CBVela',
   '{"niveis": {"Olympic Games": "mundial", "World Championships": "mundial", "Sailing World Championships": "mundial", "Youth Sailing World Championships": "mundial", "Continental": "continental"}}'::jsonb);

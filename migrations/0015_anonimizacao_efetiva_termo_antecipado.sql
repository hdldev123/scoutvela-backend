-- Anonimização efetiva, atleta anonimizado fechado para escrita, aceite antecipado do termo
-- e arquivos que não saíram do Storage.

-- ---------------------------------------------------------------------------------------------
-- 1. Atleta anonimizado nunca fica ativo (reforço do que as rotas já recusam com 409).
-- ---------------------------------------------------------------------------------------------
update atletas set ativo = false where anonimizado_em is not null and ativo;
alter table atletas
  add constraint atletas_anonimizado_inativo check (anonimizado_em is null or not ativo);

-- ---------------------------------------------------------------------------------------------
-- 2. Exceção controlada nos gatilhos de só-inserção.
--    A anonimização roda numa transação que faz `set local scoutvela.anonimizando = '<atleta_id>'`.
--    Só com essa variável igual ao atleta da linha, e só nas colunas de texto livre listadas, o
--    UPDATE é aceito, e apenas para trocar o texto pelo marcador. Qualquer outro UPDATE e todo
--    DELETE continuam recusados.
-- ---------------------------------------------------------------------------------------------

-- Argumentos do gatilho: colunas de texto livre que a anonimização pode trocar pelo marcador.
create function serie_historica_controle() returns trigger
language plpgsql as $$
declare
  marcador constant text := '[removido na anonimização]';
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
  esperado jsonb;
  coluna text;
begin
  if tg_op = 'UPDATE' and alvo is not null and alvo = (to_jsonb(old) ->> 'atleta_id') then
    esperado := to_jsonb(old);
    foreach coluna in array tg_argv loop
      if jsonb_typeof(esperado -> coluna) = 'string' then
        esperado := jsonb_set(esperado, array[coluna], to_jsonb(marcador));
      end if;
    end loop;
    if to_jsonb(new) = esperado then
      return new;
    end if;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

drop trigger avaliacoes_somente_insercao on avaliacoes;
create trigger avaliacoes_somente_insercao before update or delete on avaliacoes
  for each row execute function serie_historica_controle('evidencia');

drop trigger medidas_somente_insercao on medidas_corporais;
create trigger medidas_somente_insercao before update or delete on medidas_corporais
  for each row execute function serie_historica_controle('evidencia');

drop trigger gates_somente_insercao on gates_decisoes;
create trigger gates_somente_insercao before update or delete on gates_decisoes
  for each row execute function serie_historica_controle('justificativa');

drop trigger plano_somente_insercao on plano_individual;
create trigger plano_somente_insercao before update or delete on plano_individual
  for each row execute function serie_historica_controle('forcas', 'lacunas', 'meta_12m', 'meta_24m', 'recomendacao');

-- respostas_atleta.resposta é o texto exato de uma opção do questionário (não é texto livre) e
-- consentimentos, financeiro_campanha e termos não têm texto livre: seguem só com inserção.

-- Auditoria: nas linhas do atleta (entidade_id = atleta), a anonimização remove de `detalhes` as
-- chaves com dado pessoal. Nada mais muda.
create function anonimiza_detalhes_auditoria(detalhes jsonb) returns jsonb
language sql immutable as $$
  select case when jsonb_typeof(detalhes) = 'object' then
    detalhes - array['velaid', 'velaidCodigo', 'velaid_codigo', 'nome', 'email', 'emailContato',
                     'email_contato', 'numeroVela', 'numero_vela', 'wsId', 'ws_id', 'clube',
                     'cidade', 'uf']
  else detalhes end
$$;

create function auditoria_controle() returns trigger
language plpgsql as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'UPDATE' and alvo is not null and old.entidade_id = alvo
     and (to_jsonb(new) - 'detalhes') = (to_jsonb(old) - 'detalhes')
     and new.detalhes is not distinct from anonimiza_detalhes_auditoria(old.detalhes) then
    return new;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

drop trigger auditoria_somente_insercao on auditoria;
create trigger auditoria_somente_insercao before update or delete on auditoria
  for each row execute function auditoria_controle();

-- ---------------------------------------------------------------------------------------------
-- 3. Atleta anonimizado fica fechado para novos registros (as rotas respondem 409; isto é o
--    reforço no banco, e também serializa com uma anonimização em andamento: `for share` espera o
--    `for update` da anonimização terminar e então enxerga o atleta já anonimizado).
-- ---------------------------------------------------------------------------------------------
create function bloqueia_atleta_anonimizado() returns trigger
language plpgsql as $$
declare
  em timestamptz;
begin
  if nullif(current_setting('scoutvela.anonimizando', true), '') = new.atleta_id::text then
    return new;
  end if;
  select anonimizado_em into em from atletas where id = new.atleta_id for share;
  if em is not null then
    raise exception 'Atleta anonimizado: o registro está fechado para alterações'
      using errcode = 'SV409';
  end if;
  return new;
end;
$$;

create trigger avaliacoes_atleta_anonimizado before insert on avaliacoes
  for each row execute function bloqueia_atleta_anonimizado();
create trigger respostas_atleta_anonimizado before insert on respostas_atleta
  for each row execute function bloqueia_atleta_anonimizado();
create trigger medidas_atleta_anonimizado before insert on medidas_corporais
  for each row execute function bloqueia_atleta_anonimizado();
create trigger resultados_atleta_anonimizado before insert on resultados_regata
  for each row execute function bloqueia_atleta_anonimizado();
create trigger gates_atleta_anonimizado before insert on gates_decisoes
  for each row execute function bloqueia_atleta_anonimizado();
create trigger financeiro_atleta_anonimizado before insert on financeiro_campanha
  for each row execute function bloqueia_atleta_anonimizado();
create trigger plano_atleta_anonimizado before insert on plano_individual
  for each row execute function bloqueia_atleta_anonimizado();
create trigger evidencias_atleta_anonimizado before insert on evidencias_anexos
  for each row execute function bloqueia_atleta_anonimizado();
create trigger consentimentos_atleta_anonimizado before insert on consentimentos
  for each row execute function bloqueia_atleta_anonimizado();
create trigger revisao_atleta_anonimizado before insert on pedidos_revisao
  for each row execute function bloqueia_atleta_anonimizado();
create trigger titular_atleta_anonimizado before insert on pedidos_titular
  for each row execute function bloqueia_atleta_anonimizado();

-- ---------------------------------------------------------------------------------------------
-- 4. Resultados de regata: na anonimização, `evento` vira "Evento anonimizado" e `link_oficial`
--    fica nulo. A coluna `anonimizado` marca a linha e faz o check aceitar o link nulo só nela.
-- ---------------------------------------------------------------------------------------------
alter table resultados_regata add column anonimizado boolean not null default false;

do $$
declare
  nome text;
begin
  for nome in
    select conname from pg_constraint
     where conrelid = 'resultados_regata'::regclass and contype = 'c'
       and pg_get_constraintdef(oid) like '%link_oficial%'
  loop
    execute format('alter table resultados_regata drop constraint %I', nome);
  end loop;
end;
$$;

alter table resultados_regata
  add constraint resultados_manual_com_link
  check (fonte <> 'manual' or link_oficial is not null or anonimizado);

-- ---------------------------------------------------------------------------------------------
-- 5. Arquivos do Storage que não saíram (troca de foto, rollback de evidência). A anonimização
--    remove, junto com o resto, os que estão sob os prefixos do atleta. Só o caminho e o motivo.
-- ---------------------------------------------------------------------------------------------
create table arquivos_pendentes (
  caminho    text primary key,
  motivo     text not null,
  criado_em  timestamptz not null default now()
);
alter table arquivos_pendentes enable row level security;

-- ---------------------------------------------------------------------------------------------
-- 6. Termo: aceite antecipado. Quem aceitou uma versão MAIS NOVA que a vigente conta como tendo
--    aceito a vigente, desde que não haja revogação (concedido = false) depois do aceite.
-- ---------------------------------------------------------------------------------------------

-- Próxima versão publicada que ainda não começou a valer em `em`.
create function termo_proxima_versao(em timestamptz) returns text
language sql stable as $$
  select versao from termos_consentimento
   where vigente_desde > em
   order by vigente_desde asc, criado_em asc
   limit 1
$$;

-- O atleta aceitou a versão informada ou uma mais nova, sem revogação posterior ao aceite.
create function termo_aceito_versao(p_atleta uuid, p_versao text) returns boolean
language sql stable as $$
  select exists (
    select 1
      from consentimentos c
      join termos_consentimento t on t.versao = c.versao_termo
     where c.atleta_id = p_atleta and c.tipo = 'termo_piloto' and c.concedido
       and t.vigente_desde >= (select v.vigente_desde from termos_consentimento v where v.versao = p_versao)
       and not exists (
         select 1 from consentimentos r
          where r.atleta_id = c.atleta_id and r.tipo = 'termo_piloto' and not r.concedido
            and (r.registrado_em, r.id) > (c.registrado_em, c.id)))
$$;

-- Substitui a da 0011: aceite da vigente OU de versão mais nova (aceite antecipado).
create or replace function termo_aceito_vigente(p_atleta uuid, em timestamptz) returns boolean
language sql stable as $$
  select termo_aceito_versao(p_atleta, termo_vigente_versao(em))
$$;

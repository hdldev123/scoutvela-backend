-- D14: perfil do atleta com mini bio e conquistas (decisão D de 24/11).
--   * `atletas.bio`: texto simples de até 500 caracteres, editado pelo atleta.
--   * `termos_consentimento.inclui_foto_bio`: a versão do termo cita foto e bio entre o que vai ao IBVAR.
--   * `ibvar_ve_foto_bio`: a regra de acesso do IBVAR à foto e à bio, no banco.
--   * `conquistas_atleta`: conquistas informadas pelo atleta, com anexo e validação do treinador.

-- 1. Bio. Texto livre visto pelo investidor: a tela orienta a não citar saúde, família nem contato.
alter table atletas
  add column bio text check (bio is null or (length(bio) between 1 and 500));

-- 2. Versão do termo que inclui foto e bio.
alter table termos_consentimento
  add column inclui_foto_bio boolean not null default false;

-- 3. O IBVAR vê a foto e a bio de quem consentiu com ele E cujo aceite do termo (o mais recente, sem
--    revogação) é de uma versão que inclui foto e bio e que já começou a valer em `em`. Quem não
--    aceitou a versão nova segue sem foto e sem bio para o IBVAR.
create function ibvar_ve_foto_bio(p_atleta uuid, em timestamptz) returns boolean
language sql stable set search_path = public as $$
  select exists (
    select 1 from consentimento_atual ci
     where ci.atleta_id = p_atleta and ci.tipo = 'compartilhar_ibvar' and ci.concedido)
  and exists (
    select 1
      from consentimento_atual ct
      join termos_consentimento t on t.versao = ct.versao_termo
     where ct.atleta_id = p_atleta and ct.tipo = 'termo_piloto' and ct.concedido
       and t.inclui_foto_bio and t.vigente_desde <= em)
$$;

-- 4. Conquistas informadas pelo atleta. As automáticas (pódios dos resultados validados) não ficam aqui.
create table conquistas_atleta (
  id            uuid primary key default gen_random_uuid(),
  atleta_id     uuid not null references atletas(id),
  titulo        text not null check (length(trim(titulo)) >= 2 and length(titulo) <= 120),
  ano           smallint not null check (ano between 1950 and 2100),
  anexo_id      uuid not null references evidencias_anexos(id),
  status        text not null default 'pendente' check (status in ('pendente', 'validada', 'recusada')),
  motivo        text check (motivo is null or (length(trim(motivo)) > 0 and length(motivo) <= 300)),
  decidido_por  uuid references usuarios(id),
  decidido_em   timestamptz,
  criado_em     timestamptz not null default now(),
  check (
    case status
      when 'pendente' then motivo is null and decidido_por is null and decidido_em is null
      when 'validada' then motivo is null and decidido_por is not null and decidido_em is not null
      else motivo is not null and decidido_por is not null and decidido_em is not null
    end
  )
);

create unique index conquistas_atleta_anexo_idx on conquistas_atleta (anexo_id);
create index conquistas_atleta_idx on conquistas_atleta (atleta_id, criado_em desc, id);
alter table conquistas_atleta enable row level security;

-- O registro nunca muda. A única alteração aceita é a decisão: pendente vira validada ou recusada, e só
-- `status`, `motivo`, `decidido_por` e `decidido_em` mudam. DELETE só na anonimização do PRÓPRIO atleta
-- (set local scoutvela.anonimizando), como pesagens e aptidões: o título e o motivo saem com ela.
create function conquistas_atleta_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
begin
  if tg_op = 'DELETE' and alvo is not null and alvo = old.atleta_id::text then
    return old;
  end if;
  if tg_op = 'UPDATE'
     and old.status = 'pendente'
     and new.status in ('validada', 'recusada')
     and (to_jsonb(new) - 'status' - 'motivo' - 'decidido_por' - 'decidido_em')
         = (to_jsonb(old) - 'status' - 'motivo' - 'decidido_por' - 'decidido_em') then
    return new;
  end if;
  raise exception 'Conquista: só a decisão da conquista pendente pode mudar o registro';
end;
$$;

create trigger conquistas_atleta_so_decisao before update or delete on conquistas_atleta
  for each row execute function conquistas_atleta_controle();

-- Atleta anonimizado não recebe conquista nova.
create trigger conquistas_atleta_anonimizado before insert on conquistas_atleta
  for each row execute function bloqueia_atleta_anonimizado();

-- 5. Avisos novos: o atleta registrou uma conquista (ao treinador) e o treinador decidiu (ao atleta).
alter table avisos drop constraint avisos_tipo_check;
alter table avisos add constraint avisos_tipo_check check (tipo in (
  'atleta_respondeu', 'atleta_anexou', 'atleta_atualizou_perfil',
  'atleta_completou_cadastro', 'pedido_ajuste', 'sugestao_respondida',
  'atleta_autoavaliou', 'autoavaliacao_corrigida',
  'atleta_enviou_pesagem', 'pesagem_validada', 'pesagem_recusada',
  'atleta_lancou_resultado', 'resultado_validado', 'resultado_recusado',
  'atleta_registrou_conquista', 'conquista_validada', 'conquista_recusada'));

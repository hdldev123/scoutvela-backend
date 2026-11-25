-- D16: chat treinador–atleta e canal de dúvidas (decisão I de 24/11).
--   * `conversas`: três tipos. `treinador_atleta` (1:1, privada, ligada ao par treinador+atleta),
--     `gestao_atleta` (o atleta com a gestão; caixa compartilhada dos gestores; uma por atleta) e
--     `gestao_treinador` (o treinador com a gestão; caixa compartilhada; uma por treinador).
--   * `mensagens`: só inserção, texto puro de 1 a 2.000 caracteres.
--   * `leituras_conversa`: até onde cada usuário leu (dá "não lidas" a cada gestor da caixa compartilhada).
--   * `acessos_supervisao`: o gestor lê uma `treinador_atleta` só depois de registrar o motivo; vale 24 h.
--   * `atletas.inativado_em` e `usuarios.inativado_em`: quando a conta foi desativada (retenção de 90 dias).
--   * `conversas.encerrada_em`: quando o par treinador+atleta deixou de ser o vigente (troca de treinador).
-- Mensagens e acessos de supervisão só saem pelo job de limpeza (`scoutvela.limpando_conversas`) ou pela
-- anonimização do próprio atleta (`scoutvela.anonimizando`, migration 0015). UPDATE é sempre recusado.

-- 1. Quando a conta foi desativada. Preenchido por gatilho; reativar limpa.
alter table atletas add column inativado_em timestamptz;
alter table usuarios add column inativado_em timestamptz;

update atletas set inativado_em = coalesce(anonimizado_em, now()) where not ativo;
update usuarios set inativado_em = now() where not ativo;

create function marca_inativado_em() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.ativo then
    new.inativado_em := null;
  elsif tg_op = 'INSERT' then
    new.inativado_em := now();
  elsif old.ativo then
    new.inativado_em := now();
  else
    new.inativado_em := coalesce(old.inativado_em, now());
  end if;
  return new;
end;
$$;

create trigger atletas_inativado_em before insert or update of ativo on atletas
  for each row execute function marca_inativado_em();
create trigger usuarios_inativado_em before insert or update of ativo on usuarios
  for each row execute function marca_inativado_em();

-- 2. Conversas.
create table conversas (
  id                  uuid primary key default gen_random_uuid(),
  tipo                text not null check (tipo in ('treinador_atleta', 'gestao_atleta', 'gestao_treinador')),
  atleta_id           uuid references atletas(id),
  treinador_id        uuid references usuarios(id),
  criada_em           timestamptz not null default now(),
  ultima_mensagem_em  timestamptz,
  encerrada_em        timestamptz,
  check (
    (tipo = 'treinador_atleta' and atleta_id is not null and treinador_id is not null)
    or (tipo = 'gestao_atleta' and atleta_id is not null and treinador_id is null)
    or (tipo = 'gestao_treinador' and treinador_id is not null and atleta_id is null)
  ),
  check (encerrada_em is null or tipo = 'treinador_atleta')
);

create unique index conversas_par_unica on conversas (treinador_id, atleta_id) where tipo = 'treinador_atleta';
create unique index conversas_gestao_atleta_unica on conversas (atleta_id) where tipo = 'gestao_atleta';
create unique index conversas_gestao_treinador_unica on conversas (treinador_id) where tipo = 'gestao_treinador';
create index conversas_atleta_idx on conversas (atleta_id) where atleta_id is not null;
create index conversas_treinador_idx on conversas (treinador_id) where treinador_id is not null;
create index conversas_encerrada_idx on conversas (encerrada_em) where encerrada_em is not null;

alter table conversas enable row level security;

-- Troca de treinador: o par antigo deixa de ser vigente (só leitura) e, se o atleta voltar ao treinador
-- de antes, o par volta a valer. O treinador novo não herda a conversa antiga (a linha é do par).
create function conversas_troca_de_treinador() returns trigger
language plpgsql set search_path = public as $$
begin
  if old.treinador_id is distinct from new.treinador_id then
    if old.treinador_id is not null then
      update conversas set encerrada_em = now()
       where tipo = 'treinador_atleta' and atleta_id = new.id
         and treinador_id = old.treinador_id and encerrada_em is null;
    end if;
    if new.treinador_id is not null then
      update conversas set encerrada_em = null
       where tipo = 'treinador_atleta' and atleta_id = new.id and treinador_id = new.treinador_id;
    end if;
  end if;
  return null;
end;
$$;

create trigger atletas_troca_de_treinador after update of treinador_id on atletas
  for each row execute function conversas_troca_de_treinador();

-- 3. Mensagens.
create table mensagens (
  id           bigint generated always as identity primary key,
  conversa_id  uuid not null references conversas(id),
  autor_id     uuid not null references usuarios(id),
  texto        text not null check (length(trim(texto)) >= 1 and length(texto) <= 2000),
  enviada_em   timestamptz not null default now()
);

create index mensagens_conversa_idx on mensagens (conversa_id, enviada_em, id);
create index mensagens_autor_idx on mensagens (autor_id);

alter table mensagens enable row level security;

-- 4. Leituras: uma linha por usuário e conversa.
create table leituras_conversa (
  conversa_id  uuid not null references conversas(id),
  usuario_id   uuid not null references usuarios(id),
  lida_ate     timestamptz not null,
  primary key (conversa_id, usuario_id)
);

create index leituras_conversa_usuario_idx on leituras_conversa (usuario_id);

alter table leituras_conversa enable row level security;

-- 5. Acessos de supervisão: só inserção.
create table acessos_supervisao (
  id           bigint generated always as identity primary key,
  conversa_id  uuid not null references conversas(id),
  gestor_id    uuid not null references usuarios(id),
  motivo       text not null check (length(trim(motivo)) between 5 and 500),
  em           timestamptz not null default now(),
  expira_em    timestamptz not null check (expira_em > em)
);

create index acessos_supervisao_vigente_idx on acessos_supervisao (conversa_id, gestor_id, expira_em desc);

alter table acessos_supervisao enable row level security;

-- Só inserção. DELETE só pela limpeza (`scoutvela.limpando_conversas = on`) ou pela anonimização do
-- atleta da conversa. UPDATE nunca.
create function conversas_controle() returns trigger
language plpgsql set search_path = public as $$
declare
  alvo text := nullif(current_setting('scoutvela.anonimizando', true), '');
  limpando boolean := coalesce(nullif(current_setting('scoutvela.limpando_conversas', true), ''), 'off') = 'on';
  atleta uuid;
begin
  if tg_op = 'DELETE' then
    if limpando then
      return old;
    end if;
    if alvo is not null then
      select atleta_id into atleta from conversas where id = old.conversa_id;
      if atleta is not null and atleta::text = alvo then
        return old;
      end if;
    end if;
  end if;
  raise exception 'Conversas: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

create trigger mensagens_somente_insercao before update or delete on mensagens
  for each row execute function conversas_controle();
create trigger acessos_supervisao_somente_insercao before update or delete on acessos_supervisao
  for each row execute function conversas_controle();

-- Atleta anonimizado não recebe conversa nova.
create trigger conversas_atleta_anonimizado before insert on conversas
  for each row execute function bloqueia_atleta_anonimizado();

-- 6. Aviso novo: mensagem nova (referencia: { conversaId }).
alter table avisos drop constraint avisos_tipo_check;
alter table avisos add constraint avisos_tipo_check check (tipo in (
  'atleta_respondeu', 'atleta_anexou', 'atleta_atualizou_perfil',
  'atleta_completou_cadastro', 'pedido_ajuste', 'sugestao_respondida',
  'atleta_autoavaliou', 'autoavaliacao_corrigida',
  'atleta_enviou_pesagem', 'pesagem_validada', 'pesagem_recusada',
  'atleta_lancou_resultado', 'resultado_validado', 'resultado_recusado',
  'atleta_registrou_conquista', 'conquista_validada', 'conquista_recusada',
  'mensagem_nova'));

-- Anonimização do atleta por pedido de exclusão (LGPD, art. 18).
-- A série histórica (notas, respostas, medidas, gates, financeiro, plano, auditoria) continua só
-- com inserção, ligada ao atleta_id. O que identifica a pessoa é anonimizado em atletas, usuarios
-- e velaid_registros; os arquivos de evidência saem do Storage e o registro é só marcado.

alter table atletas
  add column anonimizado_em timestamptz,
  add column anonimizado_pedido_id bigint references pedidos_titular(id);

-- Evidência removida: o registro fica (série histórica), o arquivo some do Storage.
alter table evidencias_anexos add column removido_em timestamptz;

-- Única alteração aceita em evidencias_anexos: marcar a remoção (uma vez), com o nome neutro.
-- Todas as outras colunas ficam iguais. DELETE continua recusado.
create function evidencias_anexos_controle() returns trigger
language plpgsql as $$
begin
  if tg_op = 'UPDATE'
     and old.removido_em is null
     and new.removido_em is not null
     and new.nome_arquivo = 'removido'
     and new.id = old.id
     and new.atleta_id = old.atleta_id
     and new.indicador_id is not distinct from old.indicador_id
     and new.tipo_mime = old.tipo_mime
     and new.tamanho_bytes = old.tamanho_bytes
     and new.caminho = old.caminho
     and new.sha256 = old.sha256
     and new.enviado_por = old.enviado_por
     and new.enviado_em = old.enviado_em then
    return new;
  end if;
  raise exception 'Série histórica: % aceita só inserção (nada é sobrescrito)', tg_table_name;
end;
$$;

drop trigger evidencias_somente_insercao on evidencias_anexos;
create trigger evidencias_somente_insercao before update or delete on evidencias_anexos
  for each row execute function evidencias_anexos_controle();

-- Contas do Supabase Auth ainda não removidas após a anonimização (só o id, nunca e-mail).
-- A linha some quando a remoção é confirmada; enquanto existir, a rota pode tentar de novo.
create table anonimizacoes_pendentes (
  atleta_id     uuid not null references atletas(id),
  auth_user_id  uuid not null,
  criado_em     timestamptz not null default now(),
  primary key (atleta_id, auth_user_id)
);

alter table anonimizacoes_pendentes enable row level security;

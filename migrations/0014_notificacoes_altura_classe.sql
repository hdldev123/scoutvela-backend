-- 0014: altura de referência por classe (Class Fit, só informativa) e "visto" das notificações.

-- Faixa de altura de referência da classe, no mesmo esquema da faixa de peso, porém opcional.
-- ATENÇÃO: é INFORMATIVA. Não entra no score, na nota de pilar nem nos gates (G1 segue só o peso).
-- Não há valores aqui de propósito: em produção a faixa nasce vazia até a CBVela defini-la
-- (pelo gestor, em PUT /parametros). Valores fictícios existem só no seed de desenvolvimento.
alter table classes
  add column altura_min_cm   numeric(5,1),
  add column altura_media_cm numeric(5,1),
  add column altura_max_cm   numeric(5,1),
  add constraint classes_altura_faixa_check check (
    (altura_min_cm is null and altura_media_cm is null and altura_max_cm is null)
    or (altura_min_cm is not null and altura_media_cm is not null and altura_max_cm is not null
        and altura_min_cm >= 120 and altura_max_cm <= 230
        and altura_min_cm <= altura_media_cm and altura_media_cm <= altura_max_cm)
  );

-- Última vez que a pessoa abriu cada tela com balão de notificação. Dado de interface, não de decisão:
-- não gera auditoria e não guarda nada sensível.
create table notificacoes_vistas (
  usuario_id uuid not null references usuarios(id),
  chave      text not null check (chave in ('painel', 'revisoes', 'cadastro', 'avaliar')),
  visto_em   timestamptz not null,
  primary key (usuario_id, chave)
);

alter table notificacoes_vistas enable row level security;

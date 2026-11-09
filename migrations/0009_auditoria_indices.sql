-- Índices da trilha de auditoria para a consulta do gestor (GET /auditoria).
-- A listagem é por id decrescente (cursor); os filtros são entidade/entidade_id, usuário e data.
create index auditoria_entidade_idx on auditoria (entidade, entidade_id, id desc);
create index auditoria_usuario_idx on auditoria (usuario_id, id desc);
create index auditoria_em_idx on auditoria (em desc);

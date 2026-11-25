-- D4: o balão de Investimento (gestor e IBVAR) usa a chave `investimento` em notificacoes_vistas.
alter table notificacoes_vistas drop constraint notificacoes_vistas_chave_check;
alter table notificacoes_vistas add constraint notificacoes_vistas_chave_check
  check (chave in ('painel', 'revisoes', 'cadastro', 'avaliar', 'investimento'));

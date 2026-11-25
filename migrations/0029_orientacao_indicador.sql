-- D10: orientação editável por indicador. Texto de ajuda que a tela mostra embaixo do campo; o gestor
-- edita em Parâmetros (PUT /parametros, indicadores[].orientacao) e cada mudança fica na auditoria.
-- Nulo = sem orientação. Não é dado pessoal.
alter table indicadores
  add column orientacao text
  check (orientacao is null or (length(trim(orientacao)) > 0 and length(orientacao) <= 1000));

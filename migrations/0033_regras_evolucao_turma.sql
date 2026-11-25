-- D12: meta de evolução da turma e menor grupo que o IBVAR vê em agregado.
--
-- META_EVOLUCAO (decisão menor de 24/11, exemplo do Juan):
--   percentual  meta de alta da média do score da turma sobre o ciclo fechado anterior (em %)
-- MIN_GRUPO_AGREGADO (decisão menor de 24/11):
--   minimo      menor grupo de atletas que o IBVAR vê em agregado; abaixo disso o número sai nulo,
--               para não revelar a nota de quem não consentiu (ex.: filtro por classe com 1 atleta)
insert into regras (codigo, descricao, valor) values
  ('META_EVOLUCAO',
   'Meta da turma: alta, em %, da média do score sobre o ciclo fechado anterior (padrão +10%, exemplo da reunião de 23/11)',
   '{"percentual": 10}'::jsonb),
  ('MIN_GRUPO_AGREGADO',
   'Menor grupo de atletas que o IBVAR vê em agregado; grupo menor sai nulo e suprimido (padrão 3, decisão de 24/11)',
   '{"minimo": 3}'::jsonb);

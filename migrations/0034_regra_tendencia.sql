-- D13: limiar da tendência do atleta (decisão menor de 24/11).
--   limiar  pontos de score entre os dois últimos ciclos fechados do atleta; a diferença que chega ao
--           limiar vira "subindo" ou "caindo", abaixo dele é "estável". O mesmo limiar separa
--           "acima" e "abaixo" da média da turma de "na média".
insert into regras (codigo, descricao, valor) values
  ('TENDENCIA',
   'Tendência do atleta: pontos de score entre os dois últimos ciclos fechados a partir dos quais ele está subindo ou caindo; o mesmo limiar define "na média" da turma (padrão 2, decisão de 24/11)',
   '{"limiar": 2}'::jsonb);

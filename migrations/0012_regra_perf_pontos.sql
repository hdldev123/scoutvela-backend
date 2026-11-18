-- Regra PERF_PONTOS: converte os pontos do Ranking CBVela (soma na janela de RANKING_CBVELA) em uma
-- nota sugerida para o indicador perf_nacional. Cada faixa vale até `ate` pontos, inclusive; acima da
-- última faixa vale a nota dela. A sugestão não entra no score: o avaliador confirma lançando a nota.
-- Fica desligada até a CBVela passar a tabela de conversão.
insert into regras (codigo, descricao, valor) values
  ('PERF_PONTOS',
   'Performance: nota sugerida de perf_nacional pelos pontos do Ranking CBVela; cada faixa vale até "ate" pontos (inclusive) e, acima da última, vale a nota dela. Não entra no score sem o lançamento do avaliador',
   '{"ativa":false,"faixas":[]}'::jsonb);

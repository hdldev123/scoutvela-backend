-- D10 (decisão E): a nota de perf_mundial, perf_continental e perf_nacional sai dos resultados
-- validados do atleta, pela regra PERF_RESULTADOS. Nunca é digitada (calculado = true, como cf_peso_kg).
--
-- PERF_RESULTADOS (regra provisória P12), valores tirados do exemplo dito na reunião de 23/11, à
-- espera das faixas oficiais que o Juan vai enviar:
--   edicoes_max  quantos resultados mais recentes de cada nível entram no cálculo
--   niveis       faixas de colocação por nível, em ordem; vale a primeira com colocação <= "ate";
--                "ate" nulo = qualquer colocação (a última faixa de cada nível é assim). O tamanho
--                da frota não entra. No nacional, fora do pódio vale 0 ("só o pódio conta").
insert into regras (codigo, descricao, valor) values
  ('PERF_RESULTADOS',
   'Performance: nota de perf_mundial, perf_continental e perf_nacional pela melhor colocação validada entre as últimas "edicoes_max" edições do nível; cada faixa vale até "ate" (inclusive; nulo = qualquer colocação) e o tamanho da frota não entra. Valores provisórios, do exemplo da reunião de 23/11, à espera das faixas do Juan (CBVela)',
   '{
     "edicoes_max": 4,
     "niveis": {
       "mundial":     [{"ate": 3, "nota": 5}, {"ate": 10, "nota": 4}, {"ate": 25, "nota": 3}, {"ate": null, "nota": 2}],
       "continental": [{"ate": 3, "nota": 5}, {"ate": 10, "nota": 4}, {"ate": 25, "nota": 3}, {"ate": null, "nota": 2}],
       "nacional":    [{"ate": 1, "nota": 5}, {"ate": 2, "nota": 4}, {"ate": 3, "nota": 3}, {"ate": null, "nota": 0}]
     }
   }'::jsonb);

-- Decisão E: os pontos do Ranking CBVela deixam de sugerir nota. Seguem importados e aparecem na
-- ficha só como informação.
delete from regras where codigo = 'PERF_PONTOS';

-- Indicadores calculados não aceitam lançamento nem autoavaliação. As notas já lançadas ficam na série
-- histórica (nada é apagado), mas deixam de valer: o cálculo usa só a regra.
update indicadores
   set calculado = true, autoavaliacao = false
 where id in ('perf_mundial', 'perf_continental', 'perf_nacional');

update indicadores set orientacao =
  'Nota calculada pelos seus resultados validados em Mundial e Youth World: vale a melhor colocação entre as últimas 4 edições. Informe cada edição com o ano, a colocação e a súmula ou o link oficial; o treinador valida. Faixas provisórias: até o 3º lugar nota 5, até o 10º nota 4, até o 25º nota 3, demais nota 2. O tamanho da frota não conta.'
 where id = 'perf_mundial';
update indicadores set orientacao =
  'Nota calculada pelos seus resultados validados em campeonatos continentais (inclui Sul-Americano e Pan-Americano): vale a melhor colocação entre as últimas 4 edições. Informe cada edição com o ano, a colocação e a súmula ou o link oficial; o treinador valida. Faixas provisórias: até o 3º lugar nota 5, até o 10º nota 4, até o 25º nota 3, demais nota 2. O tamanho da frota não conta.'
 where id = 'perf_continental';
update indicadores set orientacao =
  'Nota calculada pelos seus resultados validados no Campeonato Brasileiro: vale a melhor colocação entre as últimas 4 edições, e só o pódio conta. Informe cada edição com o ano, a colocação e a súmula ou o link oficial; o treinador valida. Faixas provisórias: 1º lugar nota 5, 2º nota 4, 3º nota 3, fora do pódio nota 0. Os pontos do Ranking CBVela aparecem na ficha só como informação.'
 where id = 'perf_nacional';

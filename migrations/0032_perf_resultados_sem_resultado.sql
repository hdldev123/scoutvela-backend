-- D10: nível sem resultado validado vale 0 (escala da reunião: "ou zero, ou 4, ou 5"), não fica sem nota.
-- A média do pilar (P2) ignora indicador sem nota; sem isto, um pódio nacional sozinho daria 5 ao pilar de
-- Performance e o atleta ficaria sempre incompleto. O valor é a chave "sem_resultado" da regra, editável.
update regras
   set valor = valor || '{"sem_resultado": 0}'::jsonb,
       descricao = 'Performance: nota de perf_mundial, perf_continental e perf_nacional pela melhor colocação validada entre as últimas "edicoes_max" edições do nível; cada faixa vale até "ate" (inclusive; nulo = qualquer colocação) e o tamanho da frota não entra. Nível sem resultado validado vale "sem_resultado" (0). Valores provisórios, do exemplo da reunião de 23/11, à espera das faixas do Juan (CBVela)'
 where codigo = 'PERF_RESULTADOS';

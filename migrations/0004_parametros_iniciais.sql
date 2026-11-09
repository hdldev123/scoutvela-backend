-- Parâmetros iniciais da metodologia (Word de 29/09/2026), copiados do protótipo.
-- Depois da carga inicial, o gestor edita pelo sistema; esta migration só semeia os valores de partida.

insert into pilares (id, nome, nome_curto, peso, sensivel, evidencia_padrao, ordem) values
  ('perf', 'Performance esportiva', 'Performance', 20, false, 'Histórico competitivo', 1),
  ('cf', 'Class Fit / perfil físico', 'Class Fit', 20, true, 'Avaliação física', 2),
  ('tec', 'Técnica', 'Técnica', 15, false, 'Vídeo de treino', 3),
  ('tat', 'Tática e decisão', 'Tática', 10, false, 'Observação em regata', 4),
  ('pot', 'Potencial de desenvolvimento', 'Potencial', 5, false, 'Comparação com o ciclo anterior', 5),
  ('exp', 'Experiência de alto rendimento', 'Experiência', 5, false, 'Histórico competitivo', 6),
  ('men', 'Perfil mental / autonomia', 'Mental', 10, true, 'Observação em competição', 7),
  ('amb', 'Ambiente de desenvolvimento', 'Ambiente', 10, true, 'Questionário do atleta', 8),
  ('car', 'Projeto de carreira', 'Carreira', 5, false, 'Conversa de planejamento', 9);

insert into indicadores (id, pilar_id, nome, tipo, calculado, ordem) values
  ('perf_mundial', 'perf', 'Resultados em Mundial e Youth World', 'T', false, 1),
  ('perf_continental', 'perf', 'Resultados continentais', 'T', false, 2),
  ('perf_nacional', 'perf', 'Resultados nacionais', 'T', false, 3),
  ('perf_consistencia', 'perf', 'Consistência', 'T', false, 4),
  ('perf_nivel_frota', 'perf', 'Nível da classe e da frota', 'T', false, 5),
  ('cf_peso_kg', 'cf', 'Peso', 'T', true, 1),
  ('cf_altura_cm', 'cf', 'Altura', 'T', false, 2),
  ('cf_composicao', 'cf', 'Composição corporal', 'T', false, 3),
  ('cf_potencia', 'cf', 'Potência', 'T', false, 4),
  ('cf_forca', 'cf', 'Força', 'T', false, 5),
  ('cf_compatibilidade', 'cf', 'Compatibilidade futura com classe e função', 'T', false, 6),
  ('tec_boat_handling', 'tec', 'Boat handling', 'T', false, 1),
  ('tec_velocidade', 'tec', 'Velocidade', 'T', false, 2),
  ('tec_trim', 'tec', 'Trim', 'T', false, 3),
  ('tec_manobras', 'tec', 'Manobras', 'T', false, 4),
  ('tec_largada', 'tec', 'Largada', 'T', false, 5),
  ('tec_adaptacao', 'tec', 'Adaptação a vento e onda', 'T', false, 6),
  ('tat_leitura_vento', 'tat', 'Leitura do vento', 'T', false, 1),
  ('tat_estrategia', 'tat', 'Estratégia', 'T', false, 2),
  ('tat_posicionamento', 'tat', 'Posicionamento', 'T', false, 3),
  ('tat_risco', 'tat', 'Gestão de risco', 'T', false, 4),
  ('tat_adaptacao', 'tat', 'Adaptação tática', 'T', false, 5),
  ('pot_aprendizagem', 'pot', 'Taxa de aprendizagem', 'T', false, 1),
  ('pot_feedback', 'pot', 'Resposta ao feedback', 'T', false, 2),
  ('pot_evolucao', 'pot', 'Evolução em 12 a 24 meses', 'T', false, 3),
  ('exp_alto_rendimento', 'exp', 'Experiência de alto rendimento', 'T', false, 1),
  ('men_resiliencia', 'men', 'Resiliência', 'T', false, 1),
  ('men_disciplina', 'men', 'Disciplina', 'T', false, 2),
  ('men_autonomia', 'men', 'Autonomia', 'T', false, 3),
  ('men_competitividade', 'men', 'Competitividade', 'T', false, 4),
  ('men_controle_pressao', 'men', 'Controle sob pressão', 'T', false, 5),
  ('amb_apoio_familiar', 'amb', 'Apoio familiar ao projeto', 'A', false, 1),
  ('amb_disponibilidade', 'amb', 'Disponibilidade para viagens e camps', 'A', false, 2),
  ('amb_estabilidade', 'amb', 'Estabilidade de estudos ou trabalho', 'A', false, 3),
  ('amb_autonomia', 'amb', 'Autonomia do atleta', 'T', false, 4),
  ('amb_logistica', 'amb', 'Organização logística', 'A', false, 5),
  ('amb_historico_familiar', 'amb', 'Histórico familiar de esporte de alto rendimento', 'R', false, 6),
  ('amb_acesso_estrutura', 'amb', 'Acesso a treinador e estrutura', 'A', false, 7),
  ('car_compromisso', 'car', 'Compromisso', 'T', false, 1),
  ('car_disponibilidade', 'car', 'Horas disponíveis para a campanha', 'A', false, 2),
  ('car_equipe_tecnica', 'car', 'Equipe técnica', 'A', false, 3),
  ('car_horizonte', 'car', 'Horizonte de 2 a 4 anos', 'T', false, 4);

insert into perguntas_atleta (indicador_id, enunciado) values
  ('amb_apoio_familiar', 'Sua família apoia o projeto olímpico?'),
  ('amb_disponibilidade', 'Quanto você pode viajar para competições e camps?'),
  ('amb_estabilidade', 'Seus estudos ou trabalho permitem a rotina de treino?'),
  ('amb_logistica', 'Como você resolve transporte, barco e viagens?'),
  ('amb_historico_familiar', 'Alguém da sua família foi atleta de alto rendimento?'),
  ('amb_acesso_estrutura', 'Você tem acesso a treinador e estrutura?'),
  ('car_disponibilidade', 'Quantas horas por semana você dedica à campanha?'),
  ('car_equipe_tecnica', 'Quem faz parte da sua equipe técnica?');

-- nota_sugerida nula = a opção não pontua (indicador tipo R)
insert into opcoes_resposta (indicador_id, ordem, texto, nota_sugerida) values
  ('amb_apoio_familiar', 1, 'Apoia totalmente', 5),
  ('amb_apoio_familiar', 2, 'Apoia em parte', 3),
  ('amb_apoio_familiar', 3, 'Apoia pouco', 1),
  ('amb_disponibilidade', 1, 'Sem restrição', 5),
  ('amb_disponibilidade', 2, 'Algumas semanas por ano', 3),
  ('amb_disponibilidade', 3, 'Muito pouco', 1),
  ('amb_estabilidade', 1, 'Sim, sem conflito', 5),
  ('amb_estabilidade', 2, 'Com ajustes', 3),
  ('amb_estabilidade', 3, 'Há conflito frequente', 1),
  ('amb_logistica', 1, 'Resolvo sozinho(a)', 5),
  ('amb_logistica', 2, 'Preciso de ajuda às vezes', 3),
  ('amb_logistica', 3, 'Dependo de outras pessoas', 1),
  ('amb_historico_familiar', 1, 'Sim', null),
  ('amb_historico_familiar', 2, 'Não', null),
  ('amb_acesso_estrutura', 1, 'Treinador e base fixos', 5),
  ('amb_acesso_estrutura', 2, 'Treinador eventual', 3),
  ('amb_acesso_estrutura', 3, 'Sem treinador', 1),
  ('car_disponibilidade', 1, 'Mais de 20 h', 5),
  ('car_disponibilidade', 2, '10 a 20 h', 3),
  ('car_disponibilidade', 3, 'Menos de 10 h', 1),
  ('car_equipe_tecnica', 1, 'Treinador e preparador físico', 5),
  ('car_equipe_tecnica', 2, 'Só treinador', 3),
  ('car_equipe_tecnica', 3, 'Ninguém fixo', 1);

insert into faixas_score (id, nome, nome_curto, score_min, ordem) values
  ('f1', 'Prioridade de programa', 'Prioridade', 85, 1),
  ('f2', 'Alto potencial', 'Alto potencial', 75, 2),
  ('f3', 'Em desenvolvimento', 'Em desenvolvimento', 65, 3),
  ('f4', 'No radar', 'No radar', 0, 4);

-- pilar_id nulo = escala geral; Experiência tem rubrica própria (P1)
insert into rubricas (pilar_id, nota, descricao) values
  (null, 0, 'Inexistente ou inadequado'),
  (null, 1, 'Muito baixo'),
  (null, 2, 'Abaixo do necessário'),
  (null, 3, 'Adequado'),
  (null, 4, 'Forte'),
  (null, 5, 'Referência para a faixa'),
  ('exp', 0, 'Sem experiência internacional relevante'),
  ('exp', 1, 'Participações internacionais pontuais'),
  ('exp', 2, 'Participação regular em eventos internacionais'),
  ('exp', 3, 'Mundial/Continental + circuito internacional'),
  ('exp', 4, 'Ambiente nacional de alto rendimento + competição internacional consistente'),
  ('exp', 5, 'Experiência comprovada em ambiente de elite/sênior e contra frota internacional forte');

insert into classes (id, nome, evento, posicao, peso_min_kg, peso_medio_kg, peso_max_kg, ativa, ordem) values
  ('470-helm', '470 Helm', '470', 'helm', 58.9, 62.5, 66, true, 1),
  ('470-crew', '470 Crew', '470', 'crew', 70.4, 73.6, 76.8, true, 2),
  ('49er-helm', '49er Helm', '49er', 'helm', 80.1, 81.7, 83.3, true, 3),
  ('49er-crew', '49er Crew', '49er', 'crew', 82.2, 83.8, 85.3, true, 4),
  ('fx-helm', '49erFX Helm', '49erFX', 'helm', 67.4, 69.3, 71.1, true, 5),
  ('fx-crew', '49erFX Crew', '49erFX', 'crew', 69.3, 71.5, 73.7, true, 6),
  ('ilca6', 'ILCA 6', 'ILCA 6', 'ind', 68.7, 72, 75.4, true, 7),
  ('ilca7', 'ILCA 7', 'ILCA 7', 'ind', 82.8, 84.5, 87.2, true, 8),
  ('iqf-m', 'iQFOiL M', 'iQFOiL', 'ind', 88.7, 90.4, 92.1, true, 9),
  ('iqf-w', 'iQFOiL W', 'iQFOiL', 'ind', 66.8, 70.1, 73.3, true, 10),
  ('fk-m', 'Formula Kite M', 'Formula Kite', 'ind', 93.3, 97.1, 110.9, true, 11),
  ('fk-w', 'Formula Kite W', 'Formula Kite', 'ind', 71.7, 75.1, 78.4, true, 12),
  ('n17-helm', 'Nacra 17 Helm', 'Nacra 17', 'helm', 68.3, 71.7, 75.1, true, 13),
  ('n17-crew', 'Nacra 17 Crew', 'Nacra 17', 'crew', 68.6, 71.4, 74.1, true, 14);

insert into componentes_custo (id, nome, ordem) values
  ('treinador', 'Treinador', 1),
  ('preparacao_fisica', 'Preparação física', 2),
  ('equipamento', 'Equipamento', 3),
  ('viagens_internacionais', 'Viagens internacionais', 4),
  ('hospedagem_e_diarias', 'Hospedagem e diárias', 5),
  ('inscricoes', 'Inscrições', 6),
  ('base_de_treinamento', 'Base de treinamento', 7),
  ('suporte_medico_fisio_e_psicologico', 'Suporte médico, fisio e psicológico', 8);

insert into regras (codigo, descricao, valor) values
  ('P3', 'Nota do peso (Class Fit): limites da distância relativa à média da classe; limites[i] é o teto da nota 5 − i, acima do último a nota é 0', '{"limites":[0.5,1,1.5,2,3]}'::jsonb),
  ('G1', 'Gate 1 Class Fit: apto até apto_ate e condicional até condicional_ate (distância relativa à média); acima, alerta', '{"apto_ate":1,"condicional_ate":2}'::jsonb),
  ('G2', 'Gate 2 Evidência competitiva: frações e posições de corte em Mundial, Sul-Americano e Brasileiro', '{"mundial_apto_ate_fracao":0.3,"sul_americano_condicional_ate_posicao":6,"mundial_condicional_ate_fracao":0.5,"brasileiro_condicional_ate_posicao":3}'::jsonb),
  ('G3', 'Gate 3 Alto rendimento: eventos internacionais mínimos na janela em meses', '{"apto_min_eventos":3,"condicional_min_eventos":1,"janela_meses":24}'::jsonb),
  ('G4', 'Gate 4 Campanha: status e motivo pelo perfil de suporte (A a D)', '{"A":{"status":"apto","motivo":"Plano e recursos para 36 meses"},"B":{"status":"apto","motivo":"Plano e recursos para 24 meses"},"C":{"status":"condicional","motivo":"Depende de apoio da CBVela"},"D":{"status":"alerta","motivo":"Sem estrutura para campanha internacional"}}'::jsonb),
  ('RANKING_CBVELA', 'Janela, em semanas, dos pontos somados no Ranking CBVela', '{"janela_semanas":52}'::jsonb);

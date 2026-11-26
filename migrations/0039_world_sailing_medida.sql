-- D20: peso e altura do perfil World Sailing como SUGESTÃO de medida (decisão de 26/11/2026).
--   * O velejador declara peso e altura no próprio perfil. A importação guarda os dois (e a data em que ele
--     atualizou o perfil) em `world_sailing_perfis`: dado sensível, o IBVAR nunca vê.
--   * Nada entra no Class Fit sozinho: o treinador do atleta ou o gestor decide. "Usar" cria uma linha em
--     `medidas_corporais` (medida validada, com o gestor ou treinador como `registrado_por`); "dispensar" só
--     registra a decisão. O atleta vê a sugestão, mas não decide.
--   * Pendente = há peso ou altura e (nunca foi decidida OU o perfil foi atualizado depois da decisão).
--   * A importação regrava peso, altura e data; nunca mexe nas colunas de decisão.
--   * A anonimização já apaga a linha inteira de `world_sailing_perfis`; a medida criada segue a regra de
--     `medidas_corporais` (evidência anonimizada, valores mantidos como série histórica).
alter table world_sailing_perfis
  add column peso_kg              numeric(5,1) check (peso_kg is null or peso_kg between 30 and 160),
  add column altura_cm            numeric(5,1) check (altura_cm is null or altura_cm between 120 and 230),
  add column perfil_atualizado_em date,
  add column medida_decidida_em   timestamptz,
  -- O `perfil_atualizado_em` que valia quando decidiram: se mudar, a sugestão volta a ser oferecida.
  add column medida_decidida_ref  date,
  add column medida_id            bigint references medidas_corporais(id);

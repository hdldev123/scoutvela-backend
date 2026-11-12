-- Termo versionado (vigência por data), revisão ligada ao lançamento e regra TERMO_EXIGE_REACEITE.

-- Regra da CBVela (decisão pendente): com a regra ativa, quem não aceitou a versão vigente do termo
-- sai do ranking e das listas do piloto; inativa, basta ter aceitado alguma versão.
insert into regras (codigo, descricao, valor) values
  ('TERMO_EXIGE_REACEITE',
   'Termo: se ativa, atleta sem aceite da versão vigente do termo sai do ranking e das listas do piloto; se inativa, basta ter aceitado alguma versão',
   '{"ativa":false}'::jsonb);

-- Versão do termo vigente em um instante: a de maior vigente_desde que já começou.
create function termo_vigente_versao(em timestamptz) returns text
language sql stable as $$
  select versao from termos_consentimento
   where vigente_desde <= em
   order by vigente_desde desc, criado_em desc
   limit 1
$$;

-- O atleta tem o aceite da versão vigente em `em`.
create function termo_aceito_vigente(p_atleta uuid, em timestamptz) returns boolean
language sql stable as $$
  select exists (
    select 1 from consentimento_atual ct
     where ct.atleta_id = p_atleta and ct.tipo = 'termo_piloto' and ct.concedido
       and ct.versao_termo = termo_vigente_versao(em))
$$;

-- O atleta tem o aceite de alguma versão do termo.
create function termo_aceito_alguma(p_atleta uuid) returns boolean
language sql stable as $$
  select exists (
    select 1 from consentimento_atual ct
     where ct.atleta_id = p_atleta and ct.tipo = 'termo_piloto' and ct.concedido)
$$;

-- Definição única de "termo aceito para o piloto" (ranking, listas, lembretes, ficha):
-- exige a versão vigente se TERMO_EXIGE_REACEITE estiver ativa; senão, qualquer aceite.
create function termo_aceito_no_piloto(p_atleta uuid, em timestamptz) returns boolean
language sql stable as $$
  select case
    when coalesce((select (valor->>'ativa')::boolean from regras where codigo = 'TERMO_EXIGE_REACEITE'), false)
      then termo_aceito_vigente(p_atleta, em)
    else termo_aceito_alguma(p_atleta)
  end
$$;

-- Pedido de revisão respondido pode apontar o lançamento (série histórica) que o atendeu.
alter table pedidos_revisao add column avaliacao_id bigint references avaliacoes(id);
create index pedidos_revisao_avaliacao_idx on pedidos_revisao (avaliacao_id) where avaliacao_id is not null;

-- D6: o treinador responde a revisão (1ª instância) e o gestor é a 2ª instância, por recurso do atleta.
--
-- Desenho: o pedido continua uma linha só. `instancia` diz quem responde agora (1: treinador ou gestor;
-- 2: só o gestor). No recurso, a resposta da 1ª instância é COPIADA para `resposta_1`, `respondido_por_1` e
-- `respondido_em_1`, e `resposta`, `respondido_por`, `respondido_em` ficam nulos (o pedido volta a
-- 'aberto', como o check de 0005 exige). A resposta da 2ª instância volta para `resposta` e afins.
-- Assim nada do que cada um respondeu se perde. O papel de quem respondeu vem de usuarios.papel.
-- `avaliacao_id` guarda o lançamento ligado à resposta mais recente; o da 1ª resposta fica na auditoria.
alter table pedidos_revisao
  add column instancia        smallint not null default 1 check (instancia in (1, 2)),
  add column resposta_1       text,
  add column respondido_por_1 uuid references usuarios(id),
  add column respondido_em_1  timestamptz,
  add column recurso_texto    text check (recurso_texto is null or length(trim(recurso_texto)) between 1 and 1000),
  add column recurso_em       timestamptz,
  add constraint pedidos_revisao_recurso_coerente check (
    (instancia = 2) = (resposta_1 is not null and respondido_por_1 is not null
                       and respondido_em_1 is not null and recurso_texto is not null
                       and recurso_em is not null)
  );

-- Balão do treinador: pedidos abertos na 1ª instância.
create index pedidos_revisao_abertos_1a_idx on pedidos_revisao (atleta_id)
  where status = 'aberto' and instancia = 1;

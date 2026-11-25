-- D11: o atleta anexa arquivos. Categoria do anexo: evidência de nota, súmula de regata (D10) ou foto
-- da balança (D9). Não há categoria de documento pessoal (decisão A).
-- O gatilho evidencias_anexos_controle (0016) compara o registro inteiro: a categoria, como as demais
-- colunas, não muda depois do envio (só removido_em e nome_arquivo, na remoção).
alter table evidencias_anexos
  add column categoria text not null default 'evidencia'
  check (categoria in ('evidencia', 'sumula', 'balanca'));

create index evidencias_atleta_categoria_idx on evidencias_anexos (atleta_id, categoria, enviado_em desc);

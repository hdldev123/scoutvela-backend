-- RLS ativo em todas as tabelas, sem nenhuma política: ninguém lê dados pela
-- API pública do Supabase com a chave anon. A API do vela-back conecta com a
-- credencial de servidor (dona das tabelas) e aplica a matriz de acesso.
-- As views usam security_invoker, então herdam o bloqueio das tabelas.
-- Toda migration que criar tabela nova precisa ativar RLS nela (há teste que confere).

do $$
declare t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;

  -- No Supabase existem os papéis anon e authenticated; tira deles qualquer privilégio.
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon, authenticated';
    execute 'revoke all on all sequences in schema public from anon, authenticated';
    execute 'revoke all on all functions in schema public from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on tables from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from anon, authenticated';
    execute 'alter default privileges in schema public revoke all on functions from anon, authenticated';
  end if;
end;
$$;

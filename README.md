# vela-back

API do Scout Vela, o Talent ID da vela olímpica brasileira. Contexto completo do produto e regras no `AGENTS.md` da raiz do workspace.

```
Navegador ──► vela-front (Vercel) ──► vela-back (Render) ──► Postgres (Supabase)
                     │                                             ▲
                     └──── login (Supabase Auth) ──────────────────┘
```

Node 22 (o Render lê `.node-version`), TypeScript, Fastify 5, Zod 4 (validação e contrato OpenAPI), `pg`, `jose`. Testes com Vitest e PGlite (Postgres real em WASM, sem Docker).

## Rodar local sem Supabase (modo local)

```bash
npm install
npm run dev:local            # banco em .dados-locais/, emulador do Auth e API
npm run dev:local -- --recriar   # apaga o banco local e semeia de novo
```

Sobe:
- API em `http://127.0.0.1:3333` (documentação em `/docs`)
- emulador do Supabase Auth em `http://127.0.0.1:54321`, **só para desenvolvimento**: escuta só em 127.0.0.1 e recusa `APP_ENV` diferente de `desenvolvimento`

O banco fica em `.dados-locais/` (fora do git), com as migrations, o seed fictício e as contas de teste vinculadas.

| Perfil | E-mail | Senha | Abre em |
| --- | --- | --- | --- |
| Gestor CBVela | gestor@scoutvela.dev | gestor123 | Ranking |
| Treinadora (Ana Ribeiro) | treinadora@scoutvela.dev | treino123 | Meus atletas |
| Atleta (Helena Vasques) | atleta@scoutvela.dev | atleta123 | Meu painel |
| IBVAR | ibvar@scoutvela.dev | ibvar123 | Investimento |

Contas e dados são fictícios. As senhas existem só no seed de desenvolvimento e homologação.

## Rodar com um projeto Supabase (homologação)

1. Copie `.env.example` para `.env` e preencha `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL` e, se o projeto usar a chave JWT legada, `SUPABASE_JWT_SECRET`.
2. `npm run db:migrate` aplica as migrations. O esquema só muda por migration; nada é criado à mão no painel.
3. `npm run db:seed` carrega os dados fictícios. Recusa `APP_ENV=producao` e recusa rodar duas vezes.
4. `SUPABASE_SERVICE_ROLE_KEY=... npm run seed:auth` cria as 4 contas de teste no Supabase Auth e vincula ao papel.
5. `npm run dev`.

No painel do Supabase, desligue o cadastro público (Authentication > Sign In / Providers > "Allow new users to sign up"). Contas são criadas pela CBVela.

## Scripts

| Script | O que faz |
| --- | --- |
| `dev` | API com recarga, usando o `.env` |
| `dev:local` | modo local (PGlite, emulador do Auth, seed) |
| `test` | testes de domínio, permissões, rotas e banco |
| `typecheck` / `build` / `start` | tipos, compilação para `dist/` e execução em produção |
| `db:migrate` / `db:migrate:prod` | aplica migrations (dev com tsx; produção a partir do `dist/`) |
| `db:seed` / `seed:auth` | dados fictícios e contas de teste (nunca em produção) |
| `openapi` | gera o `openapi.yaml`, o contrato com o front (o CI falha se estiver desatualizado) |

## Organização

```
src/
  routes/        rotas HTTP (schema zod → OpenAPI)
  auth/          JWT do Supabase (HS256 ou JWKS), papéis, telas por papel
  domain/        regras puras: nota do pilar, score, faixa, Class Fit, gates
  servicos/      carrega dados e aplica o domínio por atleta
  repositories/  SQL (filtros de acesso no WHERE)
  importacao/    CSV do VelaID e do Ranking CBVela
  db/            conexão (pg ou PGlite), migrations
migrations/      esquema em SQL versionado
seed/            dados fictícios do protótipo e contas de teste
dev/             modo local (emulador do Auth) — nunca importado por src/
tests/           domínio, paridade com o protótipo, permissões, rotas, banco
```

## Regras que o código garante

- **Cálculo só no servidor:** score, faixa e gates são calculados a cada leitura a partir dos parâmetros do banco (pesos, faixas de peso, regras P3/P7, limites dos gates). Nada é digitado. O teste de paridade confere os 14 atletas contra o protótipo.
- **Série histórica:** notas, medidas, gates, consentimentos e financeiro só aceitam `INSERT`, com trigger no banco. O valor atual é o último lançamento.
- **Matriz de acesso no SQL:** treinador só vê os próprios atletas; atleta só a si; IBVAR só quem consentiu, sem detalhe sensível, sem contato e só com o perfil de suporte. Quem não consentiu entra só nos agregados.
- **Nota sugerida pela resposta do atleta** não conta no score até o treinador confirmar.
- **RLS ativo em todas as tabelas, sem política:** a chave pública do Supabase não lê nada. A API conecta com a credencial de servidor, que fica só no Render. Há teste que confere RLS em toda tabela nova.

## Segurança

- **Requisições:** JWT validado em toda requisição (issuer, audience, expiração), CORS só para os domínios do front, Helmet (CSP `default-src 'none'`, HSTS), limite de 300 requisições por minuto por IP e corpo de até 1 MB.
- **Logs e erros:** logs estruturados (pino) sem token, cookie nem corpo, e todo 401/403 vira log `acesso_negado`. Os erros seguem o formato `{ erro, mensagem }`, e o 500 não expõe detalhe interno.
- **CSRF:** não se aplica. O token vai no header `Authorization`, não em cookie.
- **Dependências:** CI com typecheck, testes, build, contrato OpenAPI e `npm audit --omit=dev`. Dependabot semanal.
- **LGPD:** não guarda CPF, documento, endereço completo nem renda; a importação de CSV recusa essas colunas. O consentimento é registrado com histórico, e o atleta pode pedir revisão de nota (art. 20).

## Deploy (Render)

- **Web service:** build `npm ci && npm run build`, start `npm start`, pre-deploy `npm run db:migrate:prod`, health check `/health`.
- **Variáveis:** `APP_ENV`, `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET` (só se for chave legada) e `CORS_ORIGINS`.
- **Ambientes:** homologação e produção são serviços separados, cada um com seu projeto Supabase. Produção usa instância paga, porque o plano gratuito hiberna.

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
npm run dev:local -- --mfa       # exige MFA (TOTP) de gestor e IBVAR, como em produção
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

No painel do Supabase:
- desligue o cadastro público (Authentication > Sign In / Providers > "Allow new users to sign up"); contas são criadas pela CBVela em `POST /usuarios`;
- mantenha a confirmação de e-mail ligada (o vínculo da conta no primeiro login usa o e-mail do token);
- ative o MFA por TOTP (Authentication > Multi-Factor) e use `EXIGIR_MFA=true`;
- em URL Configuration, cadastre `FRONT_URL/redefinir-senha` como redirect permitido (convite e redefinição de senha).

No modo local, os links de convite e de redefinição de senha aparecem no terminal, em linhas `[auth-local]`. As senhas de contas convidadas ficam só em memória e somem quando o `dev:local` reinicia.

### MFA no modo local

`npm run dev:local -- --mfa` liga `EXIGIR_MFA`: gestor e IBVAR só passam da tela de verificação depois de cadastrar um app autenticador (leia o QR ou digite o segredo) e informar o código de 6 dígitos. Treinador e atleta não são afetados. O emulador implementa TOTP (RFC 6238, SHA-1, 6 dígitos, 30 s) e aceita o código do passo atual e de um passo para cada lado; o mesmo código não vale duas vezes. Os fatores ficam só em memória e somem quando o modo local reinicia, então o cadastro do app é refeito a cada execução. Sem a flag, o MFA fica desligado.

## Scripts

| Script | O que faz |
| --- | --- |
| `dev` | API com recarga, usando o `.env` |
| `dev:local` | modo local (PGlite, emulador do Auth, seed); `-- --mfa` liga `EXIGIR_MFA`, `-- --recriar` recria o banco |
| `test` | testes de domínio, permissões, rotas e banco |
| `typecheck` / `build` / `start` | tipos, compilação para `dist/` e execução em produção |
| `lint` | ESLint (typescript-eslint com regras que usam tipos) |
| `format` / `format:check` | Prettier: formata ou só confere (o CI roda `format:check`) |
| `db:migrate` / `db:migrate:prod` | aplica migrations (dev com tsx; produção a partir do `dist/`) |
| `db:seed` / `seed:auth` | dados fictícios e contas de teste (nunca em produção) |
| `openapi` | gera o `openapi.yaml`, o contrato com o front (o CI falha se estiver desatualizado) |
| `job:lembretes` / `job:lembretes:prod` | lembretes do ciclo por e-mail (Cron Job do Render) |

## Organização

```
src/
  routes/        rotas HTTP (schema zod → OpenAPI)
  auth/          JWT do Supabase (HS256 ou JWKS), papéis, telas por papel
  domain/        regras puras: nota do pilar, score, faixa, Class Fit, gates
  servicos/      carrega dados e aplica o domínio por atleta
  repositories/  SQL (filtros de acesso no WHERE)
  importacao/    CSV do VelaID e do Ranking CBVela
  integracoes/   API admin do Supabase Auth (convites)
  storage/       evidências: disco local (dev) ou Supabase Storage
  email/         provedores de e-mail (log ou SMTP)
  jobs/          lembretes do ciclo
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
- **Ciclos:** só um aberto por vez. Ao fechar, a API calcula e congela em `scores_ciclo` o score e a faixa de todos os atletas ativos com termo aceito, numa transação. Ciclo fechado não muda.
- **Financeiro (P8):** o gestor informa o perfil de suporte A–D e os componentes; cada atualização é uma nova linha. Alimenta o G4 e o painel de investimento, não o score.
- **Resultado internacional:** lançado à mão por gestor ou treinador do atleta, com link https do resultado oficial; G2 e G3 são recalculados na leitura.
- **Parâmetros:** pesos, faixas de peso, faixas de score, rubricas, regras (P3, G1–G4, janela do Ranking CBVela) e classes ativas são editáveis só pelo gestor, com validação por código e auditoria de antes e depois. Classe com atleta ativo não pode ser desativada.
- **Plano individual:** a API calcula uma sugestão (`sugestaoPlano`); o plano que vale é o registrado por uma pessoa em `PUT /atletas/:id/plano`, com histórico. O IBVAR não vê.
- **Evidências:** PDF, PNG ou JPEG até 5 MB, com assinatura do arquivo conferida, em bucket privado; abertas por link assinado de 5 minutos, com auditoria do acesso. A nota pode levar `anexoId`.
- **Contas e termo:** o gestor cria contas e o Supabase envia o convite. O termo é versionado em `termos_consentimento` (o vigente é o mais recente) e o atleta aceita no app; o gestor ainda pode registrar aceite recebido fora dele. Com `EXIGIR_MFA=true`, gestor e IBVAR só entram com sessão `aal2`.
- **Titular (LGPD):** o atleta baixa os próprios dados em `GET /meus-dados` e registra pedidos de acesso, correção, exclusão ou revogação; o gestor responde. A exclusão é procedimento manual, porque a série histórica só aceita inserção.
- **Lembretes:** o job avisa treinadores e atletas com pendência 7, 3, 1 e 0 dias antes do prazo e todo dia depois dele, no máximo um e-mail por pessoa por dia, sem nota, peso nem nome de atleta no texto.
- **Auditoria:** toda escrita grava quem, quando, ação e ids, sem valores sensíveis. O gestor consulta em `GET /auditoria`.
- **RLS ativo em todas as tabelas, sem política:** a chave pública do Supabase não lê nada. A API conecta com a credencial de servidor, que fica só no Render. Há teste que confere RLS em toda tabela nova.

## Segurança

- **Requisições:** JWT validado em toda requisição (issuer, audience, expiração), CORS só para os domínios do front, Helmet (CSP `default-src 'none'`, HSTS), limite de 300 requisições por minuto por IP e corpo de até 1 MB.
- **Logs e erros:** logs estruturados (pino) sem token, cookie nem corpo, e todo 401/403 vira log `acesso_negado`. Os erros seguem o formato `{ erro, mensagem }`, e o 500 não expõe detalhe interno.
- **CSRF:** não se aplica. O token vai no header `Authorization`, não em cookie.
- **Dependências:** CI com typecheck, lint, formatação, testes, build, contrato OpenAPI e `npm audit --omit=dev`. Dependabot semanal.
- **LGPD:** não guarda CPF, documento, endereço completo nem renda; a importação de CSV recusa essas colunas. O consentimento é registrado com histórico, e o atleta pode pedir revisão de nota (art. 20).

## Deploy (Render)

O `render.yaml` (Blueprint) descreve o web service e o Cron Job dos lembretes.

- **Web service:** build `npm ci && npm run build`, start `npm start`, pre-deploy `npm run db:migrate:prod`, health check `/health`.
- **Cron Job:** `npm run job:lembretes:prod`, todo dia às 11:00 UTC (08:00 de Brasília).
- **Variáveis:** `APP_ENV`, `DATABASE_URL`, `DATABASE_CA_CERT`, `SUPABASE_URL`, `SUPABASE_JWT_SECRET` (só se for chave legada), `SUPABASE_SERVICE_ROLE_KEY`, `CORS_ORIGINS`, `FRONT_URL`, `EXIGIR_MFA=true`, `EMAIL_PROVEDOR=smtp`, `EMAIL_REMETENTE`, `SMTP_*` e `STORAGE_PROVEDOR=supabase`. Fora do desenvolvimento a API recusa subir com Storage local ou SMTP sem host.
- **Ambientes:** homologação e produção são serviços separados, cada um com seu projeto Supabase. Produção usa instância paga, porque o plano gratuito hiberna.

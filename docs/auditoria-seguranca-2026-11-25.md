# Auditoria de segurança — 25/11/2026

Auditoria de ponta a ponta do Scout Vela (`vela-back` e `vela-front`, branch `release-24-11`, com as 18 demandas da reunião IBVAR). Feita só em ambiente local, com o seed fictício. Nenhum teste tocou produção, serviços de terceiros ou dados reais.

As provas de conceito são testes automatizados contra a API local (`tests/seguranca/`). Cada uma falhou antes da correção e passa depois. O A7, achado no teste manual logo depois e corrigido no front, tem a prova no E2E do `vela-front`.

## 1. Superfície de ataque

```
Internet ──HTTPS──► vela-front (Vercel, TanStack Start/React 19)
   │                 CSP: script-src 'self' 'unsafe-inline' · HSTS · XFO DENY · nosniff
   │                 Sessão: supabase-js com persistSession → token no localStorage
   │
   ├──► Supabase Auth (login, MFA TOTP, convite, redefinição de senha)      [terceiro]
   │
   └──Bearer JWT──► vela-back (Render, Fastify 5, Zod 4, pg) — 87 operações REST
                     helmet (CSP default-src 'none', HSTS) · CORS restrito · bodyLimit 1 MB
                     rate limit global 300/min/IP · uploads 20/min/usuário · chat 30/min
                     JWT: jose (HS256 legado ou JWKS ES256/RS256/EdDSA), com iss, aud e exp
                     papel em `usuarios` · aal2 para gestor e IBVAR · matriz de acesso no SQL
                     ├──► Postgres (Supabase): RLS em todas as tabelas, sem política pública
                     ├──► Supabase Storage: bucket privado, link assinado de 5 min
                     ├──► SMTP: convite, lembrete, ciclo fechado
                     └──► Cron (Render): lembretes, limpeza de anexos, avisos e conversas
```

### Pontos de entrada

| Tipo | O que é | Proteção |
| --- | --- | --- |
| Rotas REST | 87 operações, sem webhooks nem filas | Todas, menos `/health`, exigem sessão (provado por teste) |
| Jobs | 4 jobs (lembretes, limpeza de anexos, avisos e conversas) | Linha de comando no Render, sem entrada externa |
| Importação de CSV | VelaID e Ranking CBVela | Só gestor; recusa colunas de CPF, RG, endereço e renda |
| Upload em base64 | Evidência, súmula, foto da balança e foto de perfil | Tamanho limitado; assinatura do arquivo conferida; EXIF e GPS removidos |

### Dados sensíveis
- **PII do atleta:** nome, nascimento, telefone, e-mail e validade do passaporte.
- **Saúde:** peso, aptidão e perfil mental.
- **Família:** perfil de suporte A–D.
- **Outros:** autoavaliação e conversas do chat.

### Fronteiras de confiança
- Navegador → API, pelo JWT.
- API → banco, com a credencial de servidor.
- Entre os papéis: gestor, treinador, atleta e IBVAR (com consentimento e termo).
- Supervisão do chat pelo gestor.

### Segredos
- Ficam só em variáveis de ambiente: `DATABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` e `SMTP_SENHA`.
- Só os `.env.example` estão versionados.
- Não foi achado segredo nos arquivos rastreados nem no histórico do git.

### Dependências
- **Produção:** 0 vulnerabilidades (`npm audit --omit=dev` no back e `bun audit` no front, com 438 pacotes).
- **Desenvolvimento:** 1 moderada, corrigida (A6).

### Pagamentos
O sistema não tem pagamento, saldo, transferência nem webhook financeiro. O "financeiro da campanha" é só um registro de perfil. Os itens de finanças do OWASP não se aplicam.

## 2. Como foi feito

**Análise estática**
- Leitura de autenticação, autorização, tratamento de erros, configuração, upload, logs e cabeçalhos.
- Varredura de todo SQL montado com interpolação, com um script que lista cada `${...}` dentro de SQL e a origem do valor.
- Busca por segredos, por aleatoriedade fraca e por pontos de XSS no front (`dangerouslySetInnerHTML`, `href` dinâmico, `window.open`).

**Ataque controlado: testes em `tests/seguranca/`**
- Todas as 86 operações sem sessão.
- BOLA/IDOR de atleta contra outro atleta e de treinador contra atleta de outro treinador. Inclui objetos pelo id: anexo, conversa, pesagem, resultado, conquista e revisão.
- Exposição de dados ao IBVAR, com e sem consentimento.
- Vínculo de conta no primeiro login.
- Log com query string e cabeçalho de cache.

**Cobertura:**
- OWASP Top 10 2021: A01 a A10;
- OWASP API Security Top 10 2023: API1 a API10.

## 3. Achados confirmados

| ID | Título | Severidade (CVSS 3.1) | Local | Esforço |
| --- | --- | --- | --- | --- |
| A1 | Primeiro login assume cadastro sem e-mail confirmado no token | Alta, 7,4 (AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:N) | `src/auth/plugin.ts:80-92` (antes da correção), rota: qualquer rota autenticada | Pequeno |
| A2 | Log de acesso grava a query string, com dado pessoal | Baixa, 2,7 (AV:N/AC:L/PR:H/UI:N/S:U/C:L/I:N/A:N) | `src/app.ts:126-135` (logger sem serializer de `req`), ex.: `GET /atletas?busca=` | Pequeno |
| A3 | Respostas da API sem `Cache-Control: no-store` | Baixa, 2,4 (AV:P/AC:L/PR:N/UI:R/S:U/C:L/I:N/A:N) | `src/app.ts` (nenhum cabeçalho de cache), todas as rotas | Pequeno |
| A6 | `minimatch` com ReDoS na cadeia do ESLint | Baixa, só desenvolvimento (GHSA-g3hv-75wg-m249, moderada no pacote) | `package-lock.json` (dependência de desenvolvimento) | Pequeno |
| A7 | Link de senha inválido troca a senha da conta já logada no navegador | Média, 5,4 (AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:L/A:L), CWE-620 | Front: `src/components/scout/TelaRedefinirSenha.tsx` (antes da correção), rota `/redefinir-senha` | Pequeno |

### A1. Primeiro login assume cadastro sem e-mail confirmado no token

- **Descrição:**
  - no primeiro login, a API amarra o login (`sub`) ao cadastro com o mesmo e-mail (`vincularContaPorEmail`);
  - ela só recusava quando o token dizia `email_verified: false`, então um token sem essa informação também fazia o vínculo;
  - contas convidadas já nascem amarradas, mas um cadastro cujo convite falhou fica sem login.
- **Pré-condição:** o projeto Supabase com cadastro público ligado e sem confirmação de e-mail. O README pede o contrário, mas a segurança dependia só dessa configuração.
- **Ataque:** com essa pré-condição, um terceiro cria conta com o e-mail desse cadastro e herda o papel dele, inclusive o de gestor.
- **Prova (`tests/seguranca/controle-acesso.test.ts`, "A1"):**
  - cadastro de gestor sem login;
  - token com `email` e sem `email_verified`;
  - antes da correção, `GET /me` dava 200 e `usuarios.auth_user_id` recebia o `sub` do terceiro.
- **Impacto:** tomada de conta com o papel do cadastro, que pode ser o de gestor, com acesso a todos os dados.
- **Correção:** o vínculo só acontece com `email_verified: true` no token. O emulador local passou a emitir a claim, como o Supabase faz.
- **Causa raiz:** a decisão de segurança dependia de uma configuração externa. Agora a API exige a prova de confirmação, e a configuração vira a segunda barreira.

### A2. Log de acesso grava a query string

- **Descrição:** o log padrão do Fastify registra `req.url` inteiro. Em `GET /atletas?busca=Helena%20Vasques`, o nome buscado ia para o log, contra a regra "Logs sem dados sensíveis" do `AGENTS.md`.
- **Prova (`tests/seguranca/hardening-api.test.ts`, "A2"):** com o log capturado, a linha "incoming request" trazia `busca=Helena`.
- **Impacto:** dado pessoal no log centralizado, visível a quem opera os logs.
- **Correção:** `serializers.req` grava só o método, o caminho sem a query string e o IP.
- **Causa raiz:** o serializer padrão grava a URL inteira. Agora só o caminho vai para o log.

### A3. Respostas sem `Cache-Control: no-store`

- **Descrição:** nenhuma resposta da API tinha cabeçalho de cache. Ficha, perfil e mensagens podiam ficar no cache do navegador num computador compartilhado, ou num proxy mal configurado.
- **Prova (`tests/seguranca/hardening-api.test.ts`, "A3"):** `GET /me`, `/atletas` e `/health` respondiam sem `cache-control`.
- **Impacto:** exposição local de dado pessoal no cache.
- **Correção:** um hook `onSend` põe `cache-control: no-store` em toda resposta que ainda não defina o próprio cabeçalho.
- **Causa raiz:** a API não definia política de cache. Agora o padrão é não guardar.

### A6. `minimatch` com ReDoS (desenvolvimento)

- **Descrição:** `minimatch` de 7.0.0 a 11.0.0, na cadeia `eslint` e `typescript-eslint`.
- **Impacto:** só na máquina de quem desenvolve e no CI. Não entra no build de produção.
- **Correção:** `npm audit fix` com o npm 11, que mexe só no `package-lock.json`. Depois dela, `npm audit` dá 0.

### A7. Link de senha inválido troca a senha da conta já logada

- **Como apareceu:** no teste manual, depois da auditoria. O gestor cadastrou um atleta, mandou o convite e abriu o link no mesmo navegador em que estava logado. A senha trocada foi a do gestor.
- **Descrição:**
  - um link de convite ou de redefinição inválido, expirado ou já usado não cria sessão;
  - a sessão que já estava aberta no navegador continua valendo;
  - a tela `/redefinir-senha` só conferia se existia uma sessão, então mostrava o formulário, e `updateUser` trocava a senha da conta logada;
  - o mesmo valia para a página aberta sem link nenhum.
- **Ataque:** um terceiro manda a quem está logado um link para `/redefinir-senha` ("defina a senha da conta nova"). A pessoa digita uma senha pensando em outra conta e troca a própria. O terceiro não fica sabendo a senha nova, mas a pessoa perde o acesso até pedir outra redefinição.
- **Prova:**
  - no navegador real (Playwright), com o gestor logado, o convite já usado de teste@teste.com mostrava o formulário, e a senha nova passava a valer para o gestor;
  - `e2e/login.spec.ts` do front, casos "link de senha … com o gestor logado": falham sem a correção.
- **Impacto:** troca não intencional da senha da conta logada, que pode ser a do gestor. Não expõe dado nem dá acesso a terceiros.
- **Correção (front, `src/lib/auth/link-senha.ts` e `TelaRedefinirSenha`):**
  - a tela guarda o hash do link antes de o supabase-js consumi-lo;
  - o formulário só aparece quando a sessão ativa é a conta que o link autenticou (claim `sub` do token), e isso é conferido de novo na hora de salvar;
  - link com erro ou de outra conta mostra "Link inválido";
  - a página aberta sem link manda trocar a senha em "Meu perfil".
- **Causa raiz:** a tela confiava em "existe uma sessão" em vez de "a sessão é a do link". Agora exige a conta do link.

## 4. Falsos positivos e itens verificados sem falha

| Candidato | Por que não é falha |
| --- | --- |
| Injeção de SQL | Todo valor externo entra por parâmetro (`$n`). As interpolações em SQL montam só constantes, nomes de coluna fixos e fragmentos com os próprios parâmetros. Conferido arquivo por arquivo |
| BOLA/IDOR entre atletas e entre treinadores | Os testes de `tests/seguranca/controle-acesso.test.ts` passaram sem correção: 404/403 em ficha, histórico, autoavaliação, pesagens, conquistas, resultados, evidências, plano, pedidos de ajuste, validações, revisões e conversas |
| Rota sem autenticação | As 86 operações, menos `/health`, respondem 401, ou 400 quando a validação do corpo vem antes da sessão. Nenhuma devolve dado |
| Exposição ao IBVAR | Atleta sem consentimento dá 404. Autoavaliação, pesagens, evidências, conquistas e resultados dão 403. O IBVAR não participa do chat |
| Reverse tabnabbing em `abrirEvidencia` (front) | O código já zera `aba.opener` e só navega para `http(s)` (`src/lib/api/evidencias.ts`) |
| XSS no front | Não há `dangerouslySetInnerHTML`, `innerHTML` nem `eval`. Os `href` dinâmicos são links do World Sailing (com o ID codificado), links assinados do Storage ou links validados como `https://` na API e no banco |
| SSRF | A API nunca acessa URL informada pelo usuário: links de vídeo e de resultado só são guardados. Só fala com URLs da configuração (Supabase, SMTP) |
| Upload malicioso | O base64 é validado com regex linear (sem ReDoS). O tamanho é conferido antes do armazenamento, a assinatura do arquivo é checada, EXIF e GPS saem, o caminho é `{atletaId}/{uuid}` e o nome do arquivo é validado |
| JWT | Algoritmos fixos (sem confusão de algoritmo), com issuer, audience e expiração conferidos. Conta desativada é barrada a cada requisição |
| Vazamento em erro | O 500 devolve mensagem genérica, e o log guarda só o erro, sem cabeçalhos nem corpo |
| CSRF | Não se aplica: a sessão vai no cabeçalho `Authorization`, sem cookie |
| Força bruta e enumeração de login | O login é do Supabase Auth. A API não tem rota de senha |
| Autodesativação ou bloqueio do último gestor | O gestor não desativa a própria conta (`src/routes/usuarios.ts:249`) |
| Corrida em limites | A cota de anexos e as sugestões usam lock por atleta ou autor; pesagem pendente e conquista usam índice único |

## 5. Pendências (com justificativa)

| Item | Risco | Por que fica pendente |
| --- | --- | --- |
| CSP do front com `script-src 'unsafe-inline'` e token de sessão no `localStorage` | Médio se surgir um XSS: o token poderia ser lido. Hoje não há ponto de XSS conhecido | O TanStack Start injeta scripts inline de hidratação, e a CSP da Vercel é estática. Tirar o `unsafe-inline` exige nonce por requisição gerado pelo servidor do front, que é uma mudança de arquitetura |
| `/docs` (Swagger) aberto em homologação | Baixo: mostra o contrato, sem dado real | Já some em produção (`APP_ENV=producao`). Em homologação, ajuda o time |
| Detalhe de erro do Postgres no log de 500 | Baixo: um erro de constraint pode trazer um valor na mensagem | A maior parte dos erros de constraint já vira 4xx tratado. Sanitizar o `err` inteiro tiraria informação de diagnóstico |
| Fluxos não testados contra o Supabase real (convite, MFA, Storage e SMTP) | Configuração | Exigem o ambiente de homologação da instituição |

## 6. Verificação

- As provas de `tests/seguranca/` passam depois das correções. A1, A2 e A3 falhavam antes; as demais passavam e ficam como regressão de controle de acesso.
- Typecheck, lint, Prettier e a suíte completa do back passam.
- O E2E do front (Playwright, com axe) passa contra o back corrigido.
- `npm audit` dá 0 vulnerabilidades, inclusive nas de desenvolvimento.
- A7: testes unitários (`src/test/senha.test.tsx`) e E2E (`e2e/login.spec.ts`) no front, mais a verificação no navegador real. O link usado mostra "Link inválido", um link válido troca só a senha da conta dele, e a senha do gestor fica intacta.

## 7. Endurecimento contínuo recomendado

**No CI:**
- SAST: CodeQL (JavaScript/TypeScript) ou Semgrep (`p/owasp-top-ten`, `p/nodejs`) nos dois repositórios.
- `npm audit --audit-level=high` no back (já roda) e `bun audit` no front.

**No GitHub:**
- Secret scanning e push protection, que ficam disponíveis com o repositório na organização da instituição.
- O Dependabot já roda e abre PRs contra a `staging`.
- Fixar as GitHub Actions por SHA.

**Na operação:**
- Proteger `main` e `staging` com revisão obrigatória.
- WAF ou limite de requisições no proxy quando houver mais de uma instância no Render (hoje o limite fica em memória).
- Gerar nonce de CSP no servidor do front, para tirar o `unsafe-inline`.
- Teste de intrusão do time de Cyber em homologação antes de dado real (pré-requisito do `AGENTS.md`).

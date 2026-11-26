# World Sailing: acesso aos dados dos atletas (D17)

Investigação feita em 24/11/2026, a partir da reunião de alinhamento IBVAR de 23/11, em que ficou decidido que o World Sailing ID é obrigatório e é a fonte oficial dos resultados internacionais.

**Pergunta:** dá para puxar automaticamente os resultados de um atleta a partir do World Sailing ID?

**Resposta curta (24/11):** não há como fazer isso hoje sem um acordo com a World Sailing. O atleta lança os resultados com a súmula ou o link oficial, e o treinador valida (D10). O sistema só monta o link para o perfil público do atleta.

**Atualização de 25/11/2026 (D19):** o perfil público é montado a partir de uma API de dados do próprio site, aberta e sem login, mas sem documentação. A pedido do usuário, a API passou a importar o perfil pelo WS ID. Ver a seção "D19" abaixo.

## D19: importação automática pelo WS ID (25/11/2026)

### A API de dados do site

| Item | Valor |
| --- | --- |
| Base | `https://datafeed.sailing.org/stats/api`, achada no código do site, em `statsAPIUrl` |
| Perfil e resultados | `GET /sailor?filter[worldSailingId]=<ID>&include=images,crews.event.regatta.level,crews.event.boatClass&paginate=1`. Cada `crew` é um resultado, com `position` (texto), regata, data e nível |
| Histórico de ranking | `GET /ranking?filter[sailor.id]=<UUID>&filter[rankingReference.status]=final&include=rankingReference.boatClass,rankingReference.type` |
| Formato | JSON:API, sem autenticação |
| Contrato | Não há: a API pode mudar sem aviso. O parse descarta o que não reconhece, e a falha vira `falhou`, sem quebrar o cadastro nem a ficha |

### Decisões do usuário

- **Resultados:**
  - entram validados, com a fonte `world_sailing`, porque a World Sailing é a fonte oficial;
  - o treinador do atleta ou o gestor pode invalidar um resultado, com motivo, e revalidar;
  - a vigência fica em `SQL_STATUS_RESULTADO` (`src/repositories/atletas.ts`).
- **Spotlight (minimização, LGPD):**
  - só nome, gênero e data de nascimento, como sugestão do primeiro acesso (o VelaID tem prioridade);
  - foto e bio também como sugestão, que o atleta aceita ou dispensa no perfil;
  - a foto é baixada pelo servidor, só de `https://assets.sailing.org/`, e passa pela limpeza de metadados.
  - peso e altura (decisão de 26/11/2026, D20) entram só como sugestão de medida, ver abaixo;
  - nunca entram estado civil, local de nascimento, perguntas do perfil, redes sociais ou categorização.
- **Peso e altura como sugestão de medida (D20, decisão de 26/11/2026):**
  - o perfil traz `height` (cm) e `weight` (kg) autodeclarados e `updatedAt`. O parse aceita número ou texto numérico, só de 30 a 160 kg e de 120 a 230 cm, com uma casa; fora da faixa ou inválido vira nulo;
  - ficam em `world_sailing_perfis` (`peso_kg`, `altura_cm`, `perfil_atualizado_em`). São dado sensível: o IBVAR nunca vê (403 na rota) e nada entra no Class Fit sozinho;
  - `GET /atletas/:id/world-sailing` traz `medidaSugerida { pesoKg, alturaCm, informadoEm, podeDecidir }`, ou nulo sem pendência. A ficha mostra "Informado na World Sailing em <data>: X kg, Y cm". O atleta vê a sugestão, mas `podeDecidir` é falso para ele;
  - `POST /atletas/:id/world-sailing/medida` com `{ decisao: "usar" | "dispensar" }` (gestor ou treinador do atleta). "Usar" cria uma medida validada em `medidas_corporais` (`medido_em` = data do perfil às 12:00 UTC, evidência "Perfil World Sailing (autodeclarado), atualizado em DD/MM/AAAA", `registrado_por` = quem decidiu), que vale no Class Fit e na altura da ficha pela ordem de `medido_em`, como qualquer medida. "Dispensar" só registra a decisão;
  - pendente = há peso ou altura e (nunca decidiu ou `medida_decidida_ref` difere de `perfil_atualizado_em`). Se o velejador atualizar o perfil, a sugestão volta a ser oferecida; a importação nunca mexe nas colunas de decisão;
  - auditoria `usar_medida_world_sailing` e `dispensar_medida_world_sailing`, só com ids e a decisão (sem peso nem altura); o log também não mostra os valores;
  - LGPD: a anonimização apaga a linha de `world_sailing_perfis`; a medida criada segue a regra de `medidas_corporais` (série histórica, evidência anonimizada). A exportação do titular traz o peso e a altura sugeridos.
- **Histórico de ranking:** só informação, sem entrar na nota, em `world_sailing_ranking`.
- **Nível da regata (regra provisória P13, `WS_NIVEIS`, editável em Parâmetros):**

  | Nível na World Sailing | Nível no Scout Vela |
  | --- | --- |
  | Olympic Games, World Championships, Sailing World Championships e Youth Sailing World Championships | mundial |
  | Continental | continental |
  | Qualquer outro, inclusive sem nível (World Cup, SailGP, Princesa Sofia…) | internacional aberto, que fica registrado e não pontua |

- **Ativação (`WORLD_SAILING_MODO`):**

  | Modo | Comportamento |
  | --- | --- |
  | `desligado` | Padrão em produção. A busca não roda |
  | `simulado` | Padrão em desenvolvimento e homologação. Usa dados fictícios: `BRATESTE01` com resultados, ranking, 71,5 kg e 176 cm (perfil atualizado em 15/10/2026), `BRATESTE02` vazio e sem peso nem altura e `BRASPT08` (Davi Moretto, atleta do seed) com o mesmo perfil do `BRATESTE01`. É recusado em produção |
  | `real` | Chama o site. Fora da produção gera um aviso no log |

- **Validação com dado real:** um teste pontual com GBRHM15 no ambiente local, a pedido do usuário. Depois o ambiente volta ao simulador e o banco local é recriado.
- **Limites:**
  - tempo limite de 8 s por chamada e de 15 s no total;
  - resposta de até 5 MB;
  - redirecionamentos não são seguidos;
  - no máximo uma busca por atleta a cada 60 s.
- **Rastro:**
  - cada busca fica em `world_sailing_importacoes` e na auditoria (`importar_world_sailing`), só com o modo, o status e as contagens;
  - a anonimização apaga o ranking e a sugestão (inclusive peso e altura) e zera a referência externa dos resultados.
- **Limitação:** a World Sailing não informa o tamanho da frota. Por isso o resultado importado não entra na fração colocação/frota do G2; pontua só pela colocação, na P12.

### Pendente

A CBVela precisa confirmar com a World Sailing a autorização para o uso automatizado, conforme a seção "Próximo passo, fora do código" abaixo. Até lá, produção fica com `WORLD_SAILING_MODO=desligado`.

## O que foi encontrado

| Tema | Achado | Confiança |
| --- | --- | --- |
| API pública | Não há API REST pública documentada para perfil ou resultados de velejador | Alta: nada nas páginas oficiais nem em fóruns de software de regata |
| XRR | Formato XML oficial (XML Regatta Reporting) que os organizadores usam para enviar resultados à World Sailing. A especificação descreve também um serviço de download que consulta biografia e resultados por nome e país ou pelo World Sailing ID | Média: a especificação existe, mas não diz quem tem credencial de consulta, e um fórum de software de regata relata mudanças recentes nesses serviços |
| Link do perfil | `https://www.sailing.org/sailor/?ref=<ID>`, por exemplo `?ref=GBRHM15` | Média: padrão visto em vários exemplos públicos, não em documentação oficial |
| Formato do ID | Sigla do país com 3 letras, seguida de iniciais e, às vezes, de um número (ex.: `ESPFE`, `GBRHM15`, `NZLPB2`) | Média: inferido de exemplos |
| Termos de uso | Não foi encontrada regra pública sobre acesso automatizado ao sailing.org. Entidades parecidas proíbem robôs e raspagem sem autorização escrita | Baixa: os termos do site não apareceram na busca |
| Custo do ID | O World Sailing ID é gratuito e obrigatório para competir em eventos internacionais | Alta |

## Decisões para o código

- **Validação do ID (D1):** `^[A-Z]{3}[A-Z0-9]{2,12}$`, depois de normalizar para maiúsculas e tirar os espaços. A regra é tolerante de propósito, porque o formato foi inferido de exemplos.
- **Link (D1):** um único helper no front monta `https://www.sailing.org/sailor/?ref=` com o ID codificado (`encodeURIComponent`), aberto em nova aba com `rel="noopener noreferrer"`. Se a World Sailing mudar o padrão, a mudança fica num lugar só.
- **Sem leitura automática (24/11, substituída pela D19 em 25/11):** a API não acessa o sailing.org. Não há raspagem do site: ela é frágil (o site é carregado por JavaScript) e pode ferir os termos de uso.
- **Resultados (D10):** o atleta lança evento, nível, edição e colocação, com a súmula anexada ou o link oficial, e o treinador valida.

## Próximo passo, fora do código

A CBVela, como federação nacional membro da World Sailing, pode pedir:
1. credencial do serviço de download do XRR, ou outro acordo de dados para consultar os resultados dos atletas brasileiros;
2. a confirmação do formato do ID e do padrão do link do perfil;
3. os termos que valem para uso automatizado.

Com a credencial, uma importação por rota do gestor, como a do Ranking CBVela, pode preencher os resultados internacionais. O lançamento pelo atleta continua para os eventos que não estão na World Sailing.

## Fontes

- [World Sailing, especificação XRR](https://www.sailing.org/xml/)
- [470 Class: envio de resultados ao banco XRR](https://www.470.org/default/news/new/text/upload-event-results-to-the-isaf-xrr-results-database)
- [Sailwave, URL do perfil do velejador](https://forum.sailingresults.co.uk/t/url-to-go-to-world-sailing-sailor-profile/5634)
- [Wikipedia, modelo de link do perfil](https://www.wikipedia.org/wiki/Template:ISAF)
- [World Sailing, painel do velejador](https://www.sailing.org/sailors/world-sailing-profile)
- [Flying Fifteen, World Sailing ID](https://flying15.org/News/world-sailing-identification)

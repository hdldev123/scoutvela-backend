# World Sailing: acesso aos dados dos atletas (D17)

Investigação feita em 24/11/2026, a partir da reunião de alinhamento IBVAR de 23/11, em que ficou decidido que o World Sailing ID é obrigatório e é a fonte oficial dos resultados internacionais.

**Pergunta:** dá para puxar automaticamente os resultados de um atleta a partir do World Sailing ID?

**Resposta curta:** não há como fazer isso hoje sem um acordo com a World Sailing. O atleta lança os resultados com a súmula ou o link oficial, e o treinador valida (D10). O sistema só monta o link para o perfil público do atleta.

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
- **Sem leitura automática:** a API não acessa o sailing.org. Não há raspagem do site: ela é frágil (o site é carregado por JavaScript) e pode ferir os termos de uso.
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

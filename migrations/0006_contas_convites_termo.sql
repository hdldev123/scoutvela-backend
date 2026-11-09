-- Contas convidadas e termo de consentimento versionado.

-- Quando o convite de conta foi enviado (nulo = nunca enviado).
alter table usuarios add column convidado_em timestamptz;

-- Texto do termo por versão. Só inserção: o vigente é o de maior vigente_desde.
-- O aceite de cada atleta fica em consentimentos (versao_termo).
create table termos_consentimento (
  versao         text primary key,
  titulo         text not null,
  texto          text not null,
  vigente_desde  timestamptz not null,
  criado_em      timestamptz not null default now()
);

create trigger termos_consentimento_somente_insercao before update or delete on termos_consentimento
  for each row execute function impede_alteracao();

alter table termos_consentimento enable row level security;

insert into termos_consentimento (versao, titulo, texto, vigente_desde) values (
  'Piloto 18+ · v1',
  'Termo de consentimento do piloto Scout Vela (18+)',
  $termo$Minuta para validação jurídica da CBVela.

1. Do que se trata
O Scout Vela é o sistema de identificação e acompanhamento de talentos da vela olímpica brasileira, mantido pela CBVela. Este piloto atende apenas atletas com 18 anos ou mais.

2. Quais dados são tratados
Para avaliar você, o sistema trata: desempenho esportivo e resultados de regata, medidas corporais (como o peso), perfil mental e de autonomia, ambiente de desenvolvimento, projeto de carreira e informações financeiras da campanha. Peso, medidas, perfil mental e informações da família são dados sensíveis e recebem proteção reforçada. Não são coletados CPF, documentos escaneados, endereço completo, renda, laudos médicos ou psicológicos nem dados de relógio ou pulseira.

3. Para que servem
Os dados servem para calcular seu score de 0 a 100, apontar os gates e apoiar a priorização de investimento esportivo nos ciclos olímpicos de 2032 e 2036.

4. O sistema sugere, não elimina
O score e os gates são uma sugestão calculada pelo sistema. Toda decisão sobre você é tomada por uma pessoa e fica registrada.

5. Compartilhamento com o IBVAR
O IBVAR só acessa seus dados individuais se você der um consentimento separado e específico, que não faz parte deste aceite. Você pode revogá-lo quando quiser. Sem esse consentimento, você aparece ao IBVAR somente nos números agregados.

6. Seus direitos
Você pode pedir revisão de uma nota (LGPD, art. 20), além de acesso, correção e exclusão dos seus dados, conforme a Lei Geral de Proteção de Dados (Lei 13.709/2018).

7. Aceite
Ao aceitar, você declara ter lido este termo e concorda com o tratamento descrito acima para os fins do piloto.$termo$,
  '2026-10-01T00:00:00-03:00'
);

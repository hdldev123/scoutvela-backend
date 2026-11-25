-- D18: de onde vem a faixa de peso de cada classe (decisão H). A fonte é só informativa: não entra
-- no cálculo. As 14 classes partem do Word da metodologia; o gestor troca a fonte em Parâmetros
-- quando chegar o documento oficial de cada classe (PUT /parametros, com auditoria antes/depois).
alter table classes
  add column faixa_fonte_documento text check (faixa_fonte_documento is null or (length(trim(faixa_fonte_documento)) > 0 and length(faixa_fonte_documento) <= 200)),
  add column faixa_fonte_versao text check (faixa_fonte_versao is null or (length(trim(faixa_fonte_versao)) > 0 and length(faixa_fonte_versao) <= 40)),
  add column faixa_fonte_data date;

update classes set
  faixa_fonte_documento = 'Word Sistema de Talent Identification & Scouting (CBVela)',
  faixa_fonte_versao = '29/09/2026',
  faixa_fonte_data = date '2026-09-29';

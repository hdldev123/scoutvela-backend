-- Foto de perfil opcional: caminho no Storage (fotos/{usuarioId}/{uuid}.ext); nulo = sem foto.
alter table usuarios add column foto_caminho text;

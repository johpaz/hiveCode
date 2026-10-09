# Catálogo incremental de capacidades

El catálogo de herramientas, skills y playbook sigue siendo una instantánea completa procedente de las colecciones y del runtime. Su sincronización compara huellas SHA-256 de los documentos indexados, incluyendo filtros ordenados, con un manifiesto persistido por tipo en `capabilityCatalogs`.

Los documentos modificados se envían mediante `upsertBatch`; los ausentes se borran por ID. Una instalación sin manifiesto se adopta reconstruyendo una sola vez el tipo para retirar entradas antiguas desconocidas. El manifiesto solo se confirma después de todas las operaciones del índice. Si hay un fallo, la siguiente sincronización repite las operaciones pendientes de manera idempotente. Las sincronizaciones completas se serializan por instancia de base, evitando que dos recargas confirmen instantáneas intercaladas.

La sincronización de la colección de skills compara todos los campos salvo `updated_at`, preservando `active` y `created_at`. Sin cambios no incrementa versiones ni timestamps. Las bajas se limitan a skills administradas por el catálogo.

Se verifican búsquedas reales, altas/cambios/bajas, ausencia de escrituras con contenido idéntico, persistencia al reabrir, reintento tras fallo y preservación de preferencias. La búsqueda continúa en BM25; este cambio no activa embeddings.

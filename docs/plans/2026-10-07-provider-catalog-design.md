# Sincronización del catálogo de HiveCode

Implementación inicial sólo en este repositorio; la homologación queda para después.

## Comportamiento

El seed reconcilia los providers al arrancar, preservando URLs personalizadas y selección. Los modelos gestionados por descubrimiento conservan sus documentos, referencias y estado al reiniciar.

Gateway y TUI ejecutan un trabajo en segundo plano cada domingo a las 02:00 de America/Bogota (07:00 UTC). Se comprueba el vencimiento cada minuto. La primera ejecución realiza la consulta inicial; los reinicios recuperan una semana pendiente. La BD guarda el último período completado por provider en codeConfig (`provider_catalog.<id>`). Se consultan providers LLM habilitados y activos, incluyendo el provider por defecto de instalaciones anteriores. HiveAgents mantiene el preset fijo del producto.

Cada provider falla de forma independiente. Un fallo se reintenta después de una hora y no modifica modelos. Cada página tiene límite de diez segundos, sin seguir redirecciones con credenciales. Las consultas usan Bun.secrets, autenticación nativa de Anthropic/Gemini o Bearer para endpoints compatibles. Se consumen todas las páginas antes de escribir; respuestas vacías, malformadas o paginación incompleta conservan el catálogo anterior.

Los modelos nuevos aparecen habilitados para elección pero no se activan automáticamente. Se conservan las decisiones manuales y metadatos existentes. Las claves no sobrescriben modelos de otro provider. Dos períodos semanales con snapshots completos donde falta un modelo provocan su deprecación: enabled/active false, deprecated_at y conservación del documento. Una reaparición devuelve su disponibilidad anterior sin activarlo. Los aliases anunciados de forma diferente por el provider requieren revisión; no se hacen llamadas de generación para validar disponibilidad ni se infieren precios.

## Consumo

Onboarding, edición de provider y configuración TUI comparten consultas de catálogo a HiveDB. Las opciones se leen nuevamente al abrir la pantalla y excluyen modelos deprecados, deshabilitados o no LLM. La configuración conserva referencias antiguas, pero no presenta un modelo retirado como disponible. El endpoint manual de sincronización utiliza el mismo servicio.

## Validación

Pruebas con BD temporal y fetch simulado: límite horario, autenticación, páginas Anthropic/Gemini, aislamiento de IDs, protección de decisiones manuales, deprecación semanal, persistencia tras seed, recuperación y reintentos, selección antigua y consultas compartidas de onboarding/settings. Se comprueba TypeScript y se construye el bundle CLI. La integración con APIs reales queda para la prueba local usando las credenciales configuradas.

Referencias de protocolo: https://platform.claude.com/docs/en/api/php/models/list y https://ai.google.dev/api/models.

## Ajustes de configuración

La pestaña Providers muestra los nombres de todos los providers LLM de la BD, con configuración y edición de API key por teclado o botón. Modelos limita sus opciones a providers activos (incluido el default de instalaciones anteriores). Clic o flechas seleccionan una fila; Enter o Confirmar modelo aplica la elección explícita sin reabrir un formulario. El backend valida su disponibilidad, guarda la elección en codeConfig y refresca la pantalla para marcar el modelo Activo. Las preferencias JSON de skills se convierten a arrays al serializar el snapshot IPC.

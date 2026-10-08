# Plan de mejoras de hiveCode

Alcance: este repositorio. Reiniciar registros mediante un comando explícito, conservar código y credenciales del almacén del sistema. Validar con bases temporales.

- [x] 1. Procesos: identidad verificable compartida, eliminar paradas por nombre, `dev reset-records` con semillas.
- [x] 2. MCP: conversión compartida, reconciliación serial, conexiones únicas, estados reales, reintentos 2/5/15/30/60 s, cierre y datos públicos sin secretos.
- [x] 3. Credenciales: contrato cifrado, claves específicas desde el almacén del sistema, registro de capacidades y servicios de diagnóstico comunes.
- [x] 4. Tareas: cancelación real propiedad del coordinador, canal IPC independiente, abortar herramientas y trabajadores, liberar recursos tras detenerlos y preservar archivos parciales.
- [x] 5. Skills: metadatos completos, caché atómica, precedencia de directorios, límite 256 KB, recarga opcional cada 2 s y estado deshabilitado conservado.
- [x] 6. Consolidación: servicios compartidos, duplicaciones justificadas o eliminadas, catálogo único de comandos, selección común de Settings y distribución con trabajadores y recursos.

Validación: pruebas por etapa con datos y claves simuladas; TypeScript, Rust, compilaciones de raíz y CLI, y contratos de TUI al finalizar. Registrar resultados reales y pendientes; no reiniciar datos del usuario como efecto del arranque.


## Resultado de implementación

- Procesos Linux identificados por ejecutable, directorio, instalación, arranque del sistema y creación. Otras plataformas rechazan señales si no pueden verificar identidad. PID antiguos numéricos se rechazan; no se buscan procesos por nombre.
- El comando de reset fue probado en una base temporal. No se ejecutó un reset de la base personal. El cifrado exige sobres autenticados: las configuraciones antiguas en texto plano requieren el reset explícito.
- MCP comparte conversión de configuración, serializa reconciliaciones y publica estados del cliente; recarga y reintentos se detienen durante el cierre.
- Cancelación por tarea: aborto del harness/modelo, herramientas, procesos propios y trabajadores; `/halt` y `/stop` llegan directamente al coordinador. Una ejecución que aún no terminó mantiene sus recursos y muestra un error de parada pendiente.
- Telegram comparte el contrato cifrado de configuración entre Settings, rutas y arranque.
- Skills comparten sincronización, conservan la decisión de deshabilitar, incluyen todos los metadatos y ofrecen recarga opcional con cierre explícito.
- Catálogo de comandos compartido por ayuda y descubrimiento; Settings comparte selección y viewport. Build de raíz y CLI incluyen 14 workers, TUI y la dependencia nativa HiveDB.

## Validación

TypeScript y ambas compilaciones pasan. Pasaron 136 pruebas Bun de contratos/seguridad/utilidades, 147 pruebas de agente y JEV, 265 pruebas Rust y 12 pruebas de TUI real. Se usaron claves simuladas y bases temporales. El contrato de README aún anuncia `/env`, retirado por instrucción del usuario; README tiene cambios ajenos y no se modificó.

Una prueba antigua de ubicación eliminaba el override de base durante la ejecución ampliada. Se corrigió su restauración y se agregó protección global entre pruebas. Se identificaron y retiraron 23 registros de prueba en la base personal, preservando una copia en `/tmp/hive-test-artifacts-backup.json`. La repetición corregida no abrió la base personal.

## Duplicaciones deliberadas

El análisis `bun scripts/audit-duplicates.ts` detecta cuatro grupos residuales en código fuente, excluyendo distribuciones, dependencias, tests y código generado:

| Grupo | Motivo |
| --- | --- |
| `BinaryAdapter.stop` / `BunGlobalAdapter.stop` | Adaptadores del mismo contrato; delegan la operación al servicio común de identidad. |
| Generación de ID de tareas / leases | Entidades distintas con contratos separados; ambos usan UUID del runtime. |
| Presentación de candidatos de IDs en CLI | Dos adaptadores de presentación; la resolución y detección de ambigüedad es compartida. |
| `removeAllListeners` de los buses | Buses independientes con almacenamiento y ciclos de vida distintos; operación elemental de vaciado. |

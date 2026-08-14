# Plan de Implementación: Revisión de hiveCode

## Fase 1: Descubrimiento y Mapeo Tecnológico
- **Objetivo**: Explorar la configuración global del monorepo, dependencias y herramientas.
- **Pasos**:
  1. Identificar el gestor de paquetes y runtime (Bun) buscando archivos como `bun.lockb` o referencias en root.
  2. Buscar y analizar los archivos `package.json` de cada paquete para extraer dependencias clave y scripts.
  3. Mapear las dependencias internas (ej. cómo `@johpaz/hivecode-cli` depende de `core`).

## Fase 2: Análisis de Componentes Principales
- **Objetivo**: Estudiar la lógica de negocio de los 4 paquetes principales.
- **Pasos**:
  1. **Core (`packages/core`)**: Examinar `agent/`, `tools/` (Filesystem, Web, Cron, CLI, etc.), `storage/` (HiveDB), y `gateway/`.
  2. **Code (`packages/code`)**: Analizar la lógica de AST, git, subagent workers (Scout, Builder, Verifier, Reviewer) y la gestión del workspace (`workspace/manager.ts`).
  3. **CLI (`packages/cli`)**: Entender los comandos de inicialización y ejecución.
  4. **Skills (`packages/skills`)**: Identificar cómo se empaquetan y distribuyen las habilidades dinámicas.

## Fase 3: Análisis del Protocolo y Seguridad
- **Objetivo**: Documentar los mecanismos de robustez del sistema.
- **Pasos**:
  1. Examinar la implementación de **Workspace Guard** y cómo previene accesos fuera de la raíz.
  2. Analizar el ciclo de vida del **Spec Kit** y el almacenamiento de artefactos en `.specify/` o `specs/`.

## Fase 4: Sincronización y Síntesis Final
- **Objetivo**: Documentar los resultados en los artefactos correspondientes y consolidar el reporte.
- **Pasos**:
  1. Escribir las tareas en `tasks.md`.
  2. Ejecutar `speckit_tasks_sync`.
  3. Compilar el reporte en `analysis.md` y realizar la convergencia final con `speckit_converge`.

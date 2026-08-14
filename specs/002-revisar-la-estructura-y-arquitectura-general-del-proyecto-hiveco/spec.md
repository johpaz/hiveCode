# Feature Specification: Revisar el Proyecto hiveCode

## 1. Contexto & Objetivos
El proyecto `hiveCode` es una plataforma multi-agente modular basada en **TypeScript** y **Bun**, diseñada para resolver tareas complejas de desarrollo de software utilizando agentes especializados (`Bee`, `Scout`, `Builder`, `Verifier`, `Reviewer`) que interactúan de forma estructurada e incremental mediante un protocolo duradero (**Spec Kit**).

El objetivo de esta tarea es realizar una revisión técnica exhaustiva y sistemática de todo el repositorio para comprender a fondo:
- La arquitectura del monorepo y la responsabilidad de cada paquete.
- La organización de archivos y directorios clave.
- El funcionamiento del sistema de herramientas y agentes (Sub-agent Architecture).
- Las tecnologías utilizadas, dependencias y procesos de compilación o ejecución.

## 2. Alcance (In-Scope)
La revisión abarca todos los paquetes dentro del directorio `packages/`:
1. `@johpaz/hivecode-core` (`packages/core`): Núcleo de agentes, herramientas, almacenamiento (HiveDB), gateway de API, servidor y utilidades.
2. `@johpaz/hivecode-code` (`packages/code`): Herramientas y subagentes especializados en código, AST, control de workspace y leases.
3. `@johpaz/hivecode-cli` (`packages/cli`): Interfaz de línea de comandos para inicializar, configurar y ejecutar agentes y tareas.
4. `@johpaz/hivecode-skills` (`packages/skills`): Habilidades empaquetadas, scripts de generación y datos estáticos de skills.

Además, incluye la revisión del sistema de gestión de tareas (**Spec Kit**) y las políticas de seguridad de archivos (**Workspace Guard**).

## 3. Fuera de Alcance (Out-of-Scope)
- Realizar modificaciones de código funcional o lógica de negocio.
- Crear nuevos subagentes o registrar nuevas herramientas funcionales.
- Ejecutar pruebas destructivas en el entorno.

## 4. User Scenarios
### Escenario 1: Incorporación de un nuevo desarrollador
Un nuevo ingeniero se une al proyecto y necesita comprender rápidamente la arquitectura física de los paquetes, las dependencias internas y la interacción de los subagentes para poder agregar una nueva feature en `packages/code`.

### Escenario 2: Auditoría de Seguridad de Filesystem
El equipo de seguridad de la información audita las restricciones del agente principal para asegurar que bajo ninguna circunstancia se puedan manipular archivos sensibles del sistema operativo fuera del directorio del workspace definido.

## 5. Requirements
- **R01 (Mapeo)**: Identificar todos los módulos, directorios y archivos de entrada clave de cada paquete del monorepo.
- **R02 (Dependencias)**: Documentar el grafo de relaciones y cómo se resuelven las dependencias internas mediante Bun Workspaces.
- **R03 (Protocolos)**: Explicar el funcionamiento de Spec Kit, sus artefactos y validaciones.
- **R04 (Seguridad)**: Validar cómo Workspace Guard restringe el acceso de las herramientas al directorio actual de ejecución.

## 6. Success Criteria
- **SC01**: Generación de un reporte completo de análisis (`analysis.md`) validado con `speckit_validate`.
- **SC02**: Verificación de que no existen accesos descontrolados al sistema de archivos ajenos al workspace en el diseño de herramientas.
- **SC03**: Sincronización exitosa de todas las tareas del plan en el queue de Spec Kit y su convergencia definitiva (`speckit_converge`).

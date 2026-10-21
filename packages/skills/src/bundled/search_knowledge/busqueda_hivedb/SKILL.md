---
name: busqueda_hivedb
description: "Cómo usar el índice de HiveDB: entender el código antes de leer el disco y descubrir solo lo que no tienes"
version: 1.2.0
author: Hive Team
icon: "🔍"
category: core
permissions: []
dependencies: []
tools: [search_knowledge]

# Triggers - how to activate this skill
triggers:
  - cómo busco herramientas
  - cómo encuentro skills
  - how to find tools
  - search knowledge
  - discovery
  - buscar en la base
  - encontrar herramientas

---

# busqueda_hivedb — el índice antes que el disco

Las herramientas de tu rol ya están en tu contexto: úsalas directamente, no las busques.

## Entender el código: índice primero

El proyecto está indexado en HiveDB. Cada consulta al índice cuesta una fracción de leer archivos.

1. `get_project_context` → mapa del proyecto y módulos más importados.
2. `search_knowledge(type="code", query="<símbolo o concepto>")` → archivos con fragmento y líneas (`lines`).
3. `outline(path)` → qué declara un archivo y en qué líneas. `find_symbol(name)` → dónde se define. `dependents(path)` → quién lo importa.
4. Solo entonces `fs_read(path, offset, limit)` de las líneas que necesitas, no el archivo entero.

Si el resultado trae `stale: true`, el archivo cambió después de indexarse: confírmalo en disco antes de editar. Lo que vas a editar léelo siempre del disco.

## Descubrir lo que no tienes

Cada búsqueda de capacidades cuesta un turno entero. Máximo dos por tarea, y solo para:

- `type="mcp"` → herramientas de servidores externos (GitHub, Slack, Airtable…).
- `type="skills"` → instrucciones para un tipo de tarea.
- `type="playbook"` → reglas y buenas prácticas.

Usa una palabra o frase corta (`"airtable"`, `"revisión de seguridad"`); acepta español e inglés. Si la herramienta existe pero tu rol no puede usarla, se te avisa: no la busques otra vez, dilo en tu handoff.

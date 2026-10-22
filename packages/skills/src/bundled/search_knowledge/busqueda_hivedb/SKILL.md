---
name: busqueda_hivedb
description: "Cómo usar la base de datos de HiveDB: entender el código por el índice antes que por el disco, y traer a tu contexto las herramientas y skills que te faltan"
version: 1.3.0
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

# busqueda_hivedb — la base de datos es tu catálogo

Arrancas con las herramientas y skills que tu rol y esta tarea necesitan, no con todo lo que tu rol podría usar. El resto vive en la base de datos y `search_knowledge` lo trae a tu contexto en el turno siguiente.

## Entender el código: índice primero

Cada consulta al índice cuesta una fracción de leer archivos.

1. `get_project_context` → mapa del proyecto y módulos más importados.
2. `search_knowledge(type="code", query="<símbolo o concepto>")` → archivos con fragmento y líneas (`lines`).
3. `outline(path)` → qué declara un archivo y en qué líneas. `find_symbol(name)` → dónde se define. `dependents(path)` → quién lo importa.
4. Solo entonces `fs_read(path, offset, limit)` de las líneas que necesitas, no el archivo entero.

Si el resultado trae `stale: true`, el archivo cambió después de indexarse: confírmalo en disco antes de editar. Lo que vas a editar léelo siempre del disco.

## Traer lo que te falta

Cuando tu tarea necesita algo que no tienes cargado, búscalo en lugar de rodearlo:

- `search_knowledge(type="tools", query="navegar una página")` → la herramienta, ya utilizable en tu siguiente turno. Si tu prompt lista herramientas "aún no cargadas", están en esta categoría.
- `type="skills"` → instrucciones para un tipo de tarea. `type="playbook"` → reglas y buenas prácticas. `type="mcp"` → herramientas de servidores externos (GitHub, Slack, Airtable…).
- `type="all"` para explorar; una palabra o una frase corta, en español o en inglés.

Una búsqueda cuesta un turno: haz una buena (con lo que necesitas hacer, no con el nombre que crees que tiene) en vez de varias. Si la herramienta existe pero tu rol no puede usarla, se te avisa: dilo en tu handoff para que BEE lo resuelva.

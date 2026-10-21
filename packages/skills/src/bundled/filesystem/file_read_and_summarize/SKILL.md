---
name: file_read_and_summarize
description: "Understand a file or area of code by reading only the lines that matter, guided by the project index"
version: 1.1.0
author: Hive Team
icon: "📄"
category: filesystem
permissions:
  - filesystem_read
dependencies: []
tools: [fs_read, outline]

triggers:
  - "leé este archivo"
  - "read this file"
  - "mostrame el contenido"
  - "show content"
  - "qué dice este archivo"
  - "resumí este archivo"
  - "summarize this file"
  - "entendé este código"
  - "understand this code"

preferred_agents: []

rules:
  - "Before opening a source file, ask the index: outline(path) lists what it declares and on which lines"
  - "Read with fs_read(path, offset, limit) only the ranges the question needs; never a large file whole"
  - "A search_knowledge(type=code) hit already carries a fragment and its lines: start from it"
  - "Small files (config, package.json, a few dozen lines) can be read whole"
  - "Summarize for whoever acts next: paths, line ranges, what each part does, risks. Do not paste the code back"
---

# Leer y resumir sin leer de más

## Flujo

1. `outline(path)` → qué declara el archivo y en qué líneas (si no está indexado, `fs_read` con `limit`).
2. `fs_read(path, offset, limit)` → solo el rango de la función o clase que importa.
3. Resumir: ruta y líneas, qué hace, qué depende de qué, riesgos.

## Qué entregar

- `archivo:líneas` de cada hallazgo, para que otro agente lo encuentre sin volver a buscar.
- Un resumen por parte, no una transcripción.

## Errores a evitar

- ❌ Leer un archivo grande entero para responder sobre una función.
- ❌ Volver a leer lo que el índice ya te mostró.
- ❌ Resumir sin indicar rutas y líneas.

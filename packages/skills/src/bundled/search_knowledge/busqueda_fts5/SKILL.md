---
name: busqueda_fts5
description: "Core discovery skill - learn how to find any capability using search_knowledge"
version: 1.1.0
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

# busqueda_fts5 — Discovery System

Tienes 4 herramientas al arrancar. Todo lo demás se descubre con **search_knowledge**.

## Regla de Oro: UNA SOLA PALABRA

```
search_knowledge(type="all", query="web")
```

**Por qué una sola palabra?**
El motor FTS5 usa OR para una palabra → retorna TODOS los resultados relacionados.
Con múltiples palabras usa AND → requiere que TODAS aparezcan → pocos o ningún resultado.

| Query | Resultado |
|-------|-----------|
| `"web"` ✅ | web_search + web_fetch + web_research (skill) + MCP web tools |
| `"buscar en internet"` ❌ | Requiere AND de 3 palabras → probablemente 0 resultados |

## Vocabulario de Dominio (una palabra cada uno)

| Dominio | Query | Herramientas que retorna |
|---------|-------|--------------------------|
| Web | `"web"` | web_search, web_fetch |
| Archivos | `"file"` o `"archivo"` | fs_read, fs_write, fs_edit, fs_list, fs_glob |
| Memoria | `"memory"` o `"memoria"` | memory_write, memory_read, memory_search |
| Cron/Agenda | `"cron"` o `"schedule"` | cron.create, cron.list, cron.update... |
| Git | `"git"` | git_status, git_diff, git_commit, git_log |
| Agentes | `"agent"` o `"agente"` | agent_create, agent_find, task_delegate |
| Proyectos | `"project"` o `"proyecto"` | project_create, task_create, project_list |
| Browser | `"browser"` | browser_navigate, browser_click, browser_type |
| Canvas/UI | `"canvas"` | , ,  |
| Código | `"code"` o `"código"` | code_search, code_test, code_build |
| Notificar | `"notify"` | notify, report_progress |
| Shell | `"shell"` o `"bash"` | shell_executor |

## Tipos de Búsqueda

```
type="tools"    → Herramientas nativas de Hive
type="skills"   → Skills con instrucciones de tareas
type="mcp"      → Herramientas externas (Airtable, GitHub, Slack...)
type="playbook" → Reglas y mejores prácticas
type="all"      → Todo a la vez (recomendado para exploración)
```

## Flujo Correcto para un Worker

```
1. Recibo tarea: "buscar noticias sobre IA y guardar en archivo"
2. search_knowledge(type="all", query="web")    → web_search, web_fetch
3. search_knowledge(type="all", query="file")   → fs_write, fs_read
4. Herramientas se inyectan automáticamente en mi contexto
5. Ejecuto: web_search(...) → fs_write(...)
```

## Ejemplos Concretos

```
// Encontrar todo lo relacionado con web
search_knowledge({type: "all", query: "web"})
→ tools: [web_search, web_fetch]
→ skills: [web_research, browser_automation]

// Encontrar tools de sistema de archivos
search_knowledge({type: "tools", query: "file"})
→ tools: [fs_read, fs_write, fs_edit, fs_list, fs_glob, fs_exists]

// Encontrar tools MCP de un servidor externo
search_knowledge({type: "mcp", query: "airtable"})
→ toolsmcp: [AIRTABLE_LIST_BASES, AIRTABLE_CREATE_RECORD, ...]

// Explorar todo lo disponible para tareas de código
search_knowledge({type: "all", query: "code"})
→ tools: [code_search, code_test, code_build, shell_executor]
→ skills: [git_workflow, code_review, ...]
```

## Reglas

1. **Siempre una sola palabra** como query — es más efectivo
2. `type="all"` para explorar — `type="tools"` para ser específico
3. Herramientas nativas tienen prioridad sobre MCP cuando hacen lo mismo
4. Si no encuentras con una palabra → prueba el equivalente en inglés/español

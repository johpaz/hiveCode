---
name: browser_automate
description: "Automate web workflows with navigation, clicks, form filling, and visual verification"
version: 1.1.0
author: Hive Team
icon: "🤖"
category: web
permissions:
  - browser_control
dependencies: []
tools: [browser_navigate, browser_snapshot, browser_interactive_elements, browser_click, browser_type, browser_fill, browser_fill_form, browser_detect_forms, browser_select_option, browser_press_key, browser_wait_for, browser_wait_for_text, browser_evaluate, browser_console_messages, browser_screenshot, browser_tab_new, browser_tab_list, browser_tab_switch, browser_tab_close, browser_capture_clipboard, browser_preview_html]

# Structured skill fields
triggers:
  - "automatizá el navegador"
  - "automate browser"
  - "completá el formulario"
  - "fill form"
  - "hacé clic en"
  - "click on"
  - "iniciá sesión"
  - "login"
  - "registrate"
  - "sign up"
  - "interactuá con la web"
  - "interact with website"
  - "flujo web"
  - "web workflow"

preferred_agents: [spider]

steps:
  - step: 1
    action: browser_navigate
    instruction: "Navigate to target URL and wait for page to fully load (live session)"
    params:
      url: "target URL"
    output: page_loaded

  - step: 2
    action: browser_snapshot
    instruction: "Read the page as text and get element refs (e1, e2, ...) for acting"
    output: page_state

  - step: 3
    action: browser_click
    instruction: "Click on elements by ref (preferred) or CSS selector"
    params:
      ref: "element ref from snapshot (e.g. e3)"
    output: click_result

  - step: 4
    action: browser_type
    instruction: "Type text into form fields (inputs, textareas)"
    params:
      ref: "element ref from snapshot"
      text: "text to type"
    output: type_result

  - step: 5
    action: browser_screenshot
    instruction: "Take screenshot only when visual verification is needed (canvas, layout, errors)"
    output: verification_screenshot

rules:
  - "Act by ref from a fresh browser_snapshot / browser_interactive_elements — refs beat CSS selectors"
  - "Refs go stale after navigation, scrolling or rerender: take a new snapshot before acting again"
  - "Prefer browser_snapshot / browser_markdown over browser_screenshot (token-dense)"
  - "Use browser_wait_for / browser_wait_for_text instead of blind waits after navigation"
  - "Isolate concurrent work with browser_tab_new; check browser_tab_list and close your tab when done"
  - "Handle errors gracefully — the element may not exist or be interactable; re-snapshot instead of retrying blindly"

output_format:
  structure: markdown
  sections:
    - "workflow_steps"
    - "final_state"
    - "screenshot_path"
  max_length: "Summary of automation flow"

examples:
  - user_input: "automatizá el login en example.com"
    expected_behavior: "Navigate → snapshot → fill/type credentials by ref → click submit → wait_for_text → verify"

  - user_input: "completá el formulario de contacto"
    expected_behavior: "Navigate → detect_forms → fill_form (all fields + submit) → verify submission"

  - user_input: "hacé clic en todos los enlaces del menú"
    expected_behavior: "Navigate → links → visit each in its own tab (tab_new/tab_switch) → snapshot each page"

  - user_input: "iniciá sesión y no me pida el código otra vez"
    expected_behavior: "Export storage_state once (browser_storage_state) and restore it with browser_set_storage_state instead of re-logging in"
---

# Browser Automate Skill

## Cuándo se Activa

Esta skill se activa para automatizar flujos de interacción con aplicaciones web: logins, formularios, navegación programática. El motor es Obscura (navegador headless sin Chromium) conectado por MCP directo; el servidor mantiene **una sesión viva**: navega primero, después lee y actúa.

## Herramientas Disponibles

| Tool | Qué hace | Cuándo usarla |
|------|----------|---------------|
| `browser_navigate` | Navega y abre/actualiza la sesión | Inicio de flujo |
| `browser_snapshot` | Página como texto + refs de elementos | Primera lectura, y tras cada navegación |
| `browser_interactive_elements` | Lista elementos accionables con ref | Antes de click/fill cuando buscas un botón |
| `browser_detect_forms` | Lista formularios con sus campos | Antes de llenar un formulario largo |
| `browser_click` / `browser_type` / `browser_fill` | Interacción por ref o selector | Botones, inputs, búsquedas |
| `browser_fill_form` | Llena N campos + submit en una llamada | Formularios completos (ahorra round-trips) |
| `browser_select_option` / `browser_press_key` / `browser_scroll` | Selects, teclado, scroll | Casos específicos de interacción |
| `browser_wait_for` / `browser_wait_for_text` | Espera por selector o texto | En vez de esperas ciegas |
| `browser_evaluate` | JavaScript en la página | Cuando no hay tool que alcance |
| `browser_screenshot` / `browser_pdf` | Captura PNG / export PDF | Solo verificación visual/documento |
| `browser_console_messages` / `browser_network_requests` | Diagnóstico | Cuando la UI falla |
| `browser_tab_*` | Abrir/listar/cambiar/cerrar pestañas | Aislar trabajo concurrente |
| `browser_get_cookies` / `browser_set_cookie` / `browser_storage_state` / `browser_set_storage_state` | Sesión autenticada | Saltarse un login ya resuelto |

## Workflow Típico

1. **Navegar** → `browser_navigate` (URL inicial)
2. **Observar** → `browser_snapshot` (o `browser_detect_forms` si hay formulario)
3. **Actuar** → click/type/fill **por ref** (`e3`), nunca a ciegas
4. **Esperar** → `browser_wait_for` / `browser_wait_for_text` el resultado esperado
5. **Verificar** → `browser_console_messages`; screenshot solo si hace falta evidencia visual
6. **Repetir** → para flujos multi-paso; cerrar tu pestaña al terminar

## Mejores Prácticas

- **Refs antes que selectores**: un ref (`e5`) sobrevive mejor que un selector frágil
- Refrescar el snapshot tras navegación/scroll: los refs caducan
- Snapshot/markdown antes que screenshot (200-400 tokens vs ~1.280)
- `browser_fill_form` para formularios: N campos en una sola llamada
- Sesiones: exportar `browser_storage_state` una vez y restaurarlo en vez de re-loguear
- Si otro agente usa el navegador, trabaja en tu propia pestaña

## Errores a Evitar

- ❌ Actuar con refs viejos tras una navegación
- ❌ Asumir éxito sin `browser_wait_for_text` del resultado esperado
- ❌ Screenshots como sustituto de leer la página (gasta tokens sin contexto)
- ❌ Ignorar `browser_console_messages` cuando "el clic no hace nada"
- ❌ Dejar pestañas abiertas al terminar

---
name: browser_scrape
description: "Navigate to web pages and capture rendered content including screenshots for dynamic sites"
version: 1.1.0
author: Hive Team
icon: "📸"
category: web
permissions:
  - browser_control
dependencies: []
tools: [browser_navigate, browser_snapshot, browser_markdown, browser_links, browser_extract, browser_search, browser_count, browser_scroll, browser_screenshot, browser_pdf, web_fetch, web_search]

# Structured skill fields
triggers:
  - "capturá el contenido"
  - "scrape content"
  - "obtené la página renderizada"
  - "get rendered page"
  - "sitios dinámicos"
  - "dynamic sites"
  - "web con javascript"
  - "javascript websites"
  - "tomá screenshot y contenido"
  - "screenshot and content"

preferred_agents: [spider]

steps:
  - step: 1
    action: browser_navigate
    instruction: "Navigate to URL and wait for full page load including JavaScript rendering"
    params:
      url: "target URL"
    output: page_loaded

  - step: 2
    action: browser_markdown
    instruction: "Extract the rendered page as Markdown (headings, paragraphs, lists, links, code blocks)"
    output: extracted_content

  - step: 3
    action: browser_screenshot
    instruction: "Take a screenshot only when visual evidence is required (layout, canvas, ads)"
    output: screenshot

  - step: 4
    action: synthesize
    instruction: "Combine content and (if needed) screenshot into a single structured capture"
    output: scraped_data

rules:
  - "Use Obscura (headless, no Chromium) — the live session renders JS before returning"
  - "Prefer browser_markdown/browser_snapshot over web_fetch: the page is already rendered"
  - "Use browser_extract with a {field: selector} map for structured data ('a@href', 'field[]' for arrays)"
  - "For infinite scroll: browser_scroll({ direction: 'bottom' }) repeatedly, then extract"
  - "browser_search to locate a section cheaply before extracting it"
  - "Respect website terms of service — no aggressive scraping"
  - "Screenshots are optional evidence, not the default output"

output_format:
  structure: markdown
  sections:
    - "url"
    - "extracted_content"
    - "screenshot_path"
    - "timestamp"
  max_length: "Full content extraction"

examples:
  - user_input: "capturá el contenido de https://example.com/dashboard"
    expected_behavior: "browser_navigate → browser_markdown (+ browser_snapshot) → return both"

  - user_input: "sacame los precios de esta tabla"
    expected_behavior: "browser_navigate → browser_extract({ schema: { name: 'td:nth-child(2)', price: 'td:nth-child(3)' } })"

  - user_input: "listame todos los enlaces de la página"
    expected_behavior: "browser_navigate → browser_links (or browser_markdown for context) → enumerate"

  - user_input: "scrapeá este sitio con javascript"
    expected_behavior: "Full browser render → markdown/extract + optional screenshot"
---

# Browser Scrape Skill

## Cuándo se Activa

Esta skill se activa para sitios web dinámicos que requieren JavaScript rendering, donde el contenido no está disponible en HTML estático.

## Herramientas Disponibles

| Tool | Qué hace | Cuándo usarla |
|------|----------|---------------|
| `browser_navigate` | Navega y renderiza la página completa (Obscura) | Sitios con JavaScript/SPA |
| `browser_markdown` | Página renderizada como Markdown | Extracción principal (densa en tokens) |
| `browser_snapshot` | URL, título, texto legible y refs | Vista rápida con contexto |
| `browser_extract` | Objeto estructurado por mapa campo→selector | Datos tabulares / repetidos |
| `browser_links` / `browser_search` / `browser_count` | Enumerar, localizar, contar | Antes de scrapear a ciegas |
| `browser_scroll` | Scroll para infinite scroll | Listas que cargan al bajar |
| `browser_screenshot` / `browser_pdf` | Evidencia visual / documento | Solo si el texto no basta |
| `web_fetch` | Fetch ligero sin JS | Sitios estáticos (más barato) |

## Workflow

1. **Navegar** → `browser_navigate({ url })` (espera el render JS sola)
2. **Extraer** → `browser_markdown()` para contenido, `browser_extract()` para datos
3. **Enumerar si hace falta** → `browser_links()`, `browser_scroll({ direction: 'bottom' })`
4. **Evidencia visual (opcional)** → `browser_screenshot()` / `browser_pdf()`
5. **Combinar** → contenido estructurado + evidencia

## Mejores Prácticas

- La sesión de Obscura ya está renderizada: **no** hace falta `web_fetch` después de navegar
- `browser_extract` con `'campo[]'` devuelve arrays — ideal para tablas y listados
- `browser_search` para confirmar que un texto existe antes de raspar una sección
- Para infinite scroll: `browser_scroll` repetido hasta que `browser_count` deje de crecer
- Screenshot solo cuando el texto no demuestra el estado visual

## Errores a Evitar

- ❌ No esperar renderizado JavaScript
- ❌ Solo capturar HTML estático para sitios SPA
- ❌ Screenshot como output principal (gasta tokens sin contexto)
- ❌ Ignorar términos de servicio del sitio

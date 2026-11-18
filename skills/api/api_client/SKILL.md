---
name: api_client
description: "Make HTTP requests to REST APIs with full control over method, headers, body, and authentication"
version: 1.0.0
author: Hive Team
icon: "🌐"
category: api
permissions: []
dependencies: []
tools: [api_request]

triggers:
  - "llamar a una API"
  - "call an API"
  - "petición HTTP"
  - "HTTP request"
  - "REST API"
  - "endpoint"
  - "webhook"
  - "POST a la API"
  - "GET de la API"
  - "consumir servicio"
  - "consume service"
  - "curl"
  - "fetch"
  - "autenticación API"
  - "API authentication"
  - "Bearer token"
  - "API key"

preferred_agents: []

steps:
  - step: 1
    action: prepare_request
    instruction: "Determine method, URL, headers, and body based on the API documentation"
    output: request_config

  - step: 2
    action: api_request
    instruction: "Execute the HTTP request"
    output: response

  - step: 3
    action: handle_response
    instruction: "Parse response, check status code, handle errors"
    output: result

rules:
  - "Always check the status code — 2xx = success, 4xx = client error, 5xx = server error"
  - "For APIs with auth: set Authorization header (Bearer token) or use API key header"
  - "For JSON APIs: set Content-Type: application/json and stringify the body"
  - "Handle pagination if the API returns paginated results"
  - "Never hardcode API keys in the request — read from environment or config"

output_format:
  structure: api_response
  max_length: "Summarize response data, show status code and key fields"

examples:
  - user_input: "consultá la API de GitHub para ver los repos del usuario"
    expected_behavior: "api_request({ method: 'GET', url: 'https://api.github.com/users/x/repos', headers: { Authorization: 'Bearer ...' } })"

  - user_input: "mandá un POST a mi webhook de n8n"
    expected_behavior: "api_request({ method: 'POST', url: 'https://n8n.example.com/webhook/...', body: {...}, headers: { 'Content-Type': 'application/json' } })"
---

# API Client Skill

## Cuándo se Activa

Para hacer peticiones HTTP a APIs REST externas — consultar datos, enviar webhooks, integrar servicios.

## Herramienta: `api_request`

```javascript
api_request({
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS",
  url: "https://api.example.com/endpoint",
  headers: { "Authorization": "Bearer token123", "Content-Type": "application/json" },
  body: { key: "value" },           // para POST/PUT/PATCH
  params: { page: 1, limit: 20 },  // query params
  timeout: 30000,                   // ms, default 30s
})
// → { status: 200, headers: {...}, body: {...} }
```

## Patrones Comunes

### GET con autenticación Bearer
```javascript
api_request({
  method: "GET",
  url: "https://api.github.com/repos/org/repo/issues",
  headers: { "Authorization": "Bearer ghp_xxx", "Accept": "application/vnd.github.v3+json" }
})
```

### POST JSON
```javascript
api_request({
  method: "POST",
  url: "https://api.openai.com/v1/chat/completions",
  headers: { "Authorization": "Bearer sk-...", "Content-Type": "application/json" },
  body: { model: "gpt-4", messages: [{ role: "user", content: "Hola" }] }
})
```

### Webhook
```javascript
api_request({
  method: "POST",
  url: "https://hooks.slack.com/services/T.../B.../xxx",
  headers: { "Content-Type": "application/json" },
  body: { text: "Tarea completada ✅" }
})
```

### Con query params
```javascript
api_request({
  method: "GET",
  url: "https://api.example.com/search",
  params: { q: "bitcoin", limit: 10, from: "2026-01-01" }
})
```

## Manejo de Errores

| Status | Significado | Acción |
|--------|-------------|--------|
| 2xx | Éxito | Procesar respuesta |
| 400 | Bad Request | Verificar body/params |
| 401 | Unauthorized | Verificar token/API key |
| 403 | Forbidden | Verificar permisos |
| 404 | Not Found | Verificar URL/ID |
| 429 | Rate Limited | Esperar y reintentar |
| 5xx | Server Error | Reintentar o reportar |

## Mejores Prácticas

- Nunca hardcodear API keys — leerlas del entorno o BD de configuración
- Para paginación: hacer múltiples requests con `params.page` o cursor
- Para webhooks de alta seguridad: verificar HMAC signature si la API lo soporta
- Siempre parsear el body como JSON si `Content-Type: application/json` en respuesta

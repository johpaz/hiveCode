# Provider HiveAgents

HiveCode integra la API OpenAI-compatible documentada en
<https://llm.hiveagents.io/api-docs>.

## Preset del producto

El provider está deliberadamente cerrado para evitar configuración redundante:

| Campo | Valor |
|---|---|
| Provider | `hiveagents` |
| Base de gestión | `https://llm.hiveagents.io` |
| Base OpenAI | `https://llm.hiveagents.io/v1` |
| Modelo | `Qwen3-Coder-Next-UD-Q4_K_M.gguf` |
| Contexto de carga | `8192` |
| KV cache | `f16` |
| Jinja | habilitado |
| Flash attention | deshabilitado |
| Thinking | deshabilitado |

El usuario únicamente proporciona la API key. Se guarda en `Bun.secrets`; nunca
se persiste en HiveDB, archivos de configuración, logs ni código del frontend.

```bash
hivecode provider add hiveagents
```

## Carga y espera

Al seleccionar o actualizar HiveAgents, HiveCode ejecuta este protocolo:

1. Consulta `GET /api/status`.
2. Si el modelo exacto ya está listo, continúa.
3. En caso contrario envía `POST /api/load` con Bearer token y el preset fijo.
4. Consulta periódicamente `GET /api/status`.
5. Solo completa la selección cuando se cumplen simultáneamente:
   `loaded=true`, `loading=false`, `error=null` y el nombre del modelo coincide.
6. Propaga el error del servidor o termina con timeout después de cinco minutos.

La inferencia usa `POST /v1/chat/completions`, Bearer token y el nombre exacto
`Qwen3-Coder-Next-UD-Q4_K_M.gguf`. No usa los alias `local` ni
`hiveagents/local`. El request fija
`chat_template_kwargs.enable_thinking=false`; la respuesta se consume desde
`content`, no desde `reasoning_content`.

## Seguridad

- No incluir API keys en documentación, Git o JavaScript entregado al navegador.
- Rotar inmediatamente cualquier clave que haya sido publicada.
- `/api/status` es público y de solo lectura; la carga y la inferencia requieren
  `Authorization: Bearer <API_KEY>`.

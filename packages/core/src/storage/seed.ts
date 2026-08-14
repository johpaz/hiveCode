import * as path from "node:path"
import type { Collection } from "@johpaz/hive-db"
import { SkillLoader, getClaudeSkillsDirs } from "@johpaz/hivecode-skills"
import { col, nextId, toIndexable } from "./hive"
import type {
  AgentDoc,
  ChannelDoc,
  CodeBridgeConfigDoc,
  CodeBridgeDoc,
  EthicsDoc,
  McpServerDoc,
  ModelDoc,
  PlaybookDoc,
  ProviderDoc,
  SkillDoc,
  ToolDoc,
} from "./collections"
import { logger } from "../utils/logger"
import { HIVEAGENTS_MODEL_ID } from "../agent/llm-providers/hiveagents"

/**
 * Seed de datos predeterminados para Hive
 * Las tools se crean con enabled=1 (disponibles) y active=1 (activas por defecto)
 * El usuario puede desactivarlas desde la UI si no las necesita
 */

export interface SeedData {
  tools: Array<{ id: string; name: string; category: string; description: string; enabled?: boolean }>
  providers: Array<{ id: string; name: string; baseUrl?: string; category?: string }>
  models: Array<{ id: string; providerId: string; name: string; modelType: string; contextWindow?: number; capabilities?: string }>
  mcpServers: Array<{ id: string; name: string; transport: string; command?: string; args?: string[]; builtin: boolean }>
  channels: Array<{ id: string; type: string }>
  ethics: Array<{ id: string; name: string; description: string; content: string; isDefault: boolean }>
  codeBridge: Array<{ id: string; name: string; cliCommand: string; port: number }>
  codeBridgeConfig: Array<{ id: string; key: string; value: string }>
}

export const SEED_DATA: SeedData = {
  tools: [

    // ─────────────────────────────────────────
    // 1. FILESYSTEM — Espacio de trabajo del agente
    // ─────────────────────────────────────────
    { id: "fs_read", name: "fs_read", category: "filesystem", description: "Leer contenido de archivos del espacio de trabajo. Sinónimos: ver archivo, abrir archivo, leer contenido, mostrar archivo" },
    { id: "fs_write", name: "fs_write", category: "filesystem", description: "Crear o sobrescribir archivos en el espacio de trabajo. Sinónimos: crear archivo, guardar archivo, escribir archivo, nuevo archivo" },
    { id: "fs_edit", name: "fs_edit", category: "filesystem", description: "Editar líneas específicas o secciones de un archivo. Sinónimos: modificar archivo, editar líneas, actualizar contenido, cambiar texto" },
    { id: "fs_delete", name: "fs_delete", category: "filesystem", description: "Eliminar archivos o directorios del espacio de trabajo. Sinónimos: borrar archivo, eliminar carpeta, quitar archivo, remover" },
    { id: "fs_list", name: "fs_list", category: "filesystem", description: "Listar archivos y directorios en el espacio de trabajo. Sinónimos: ver carpeta, explorar directorio, listar contenido, mostrar archivos" },
    { id: "fs_glob", name: "fs_glob", category: "filesystem", description: "Buscar archivos que coincidan con patrones wildcard. Sinónimos: buscar archivos, patrón, encontrar archivos, filtrar por nombre" },
    { id: "fs_exists", name: "fs_exists", category: "filesystem", description: "Verificar si existe un archivo o directorio. Sinónimos: comprobar archivo, existe archivo, verificar existencia, hay archivo" },
    { id: "search_in_files", name: "search_in_files", category: "filesystem", description: "Buscar patrón o texto en archivos o directorios, retorna líneas con número de línea. Sinónimos: grep, buscar en archivos, buscar patrón, encontrar texto, buscar código" },
    { id: "find_imports", name: "find_imports", category: "code", description: "Encontrar todos los archivos que importan un módulo dado. Usa el grafo de código indexado. Sinónimos: quién importa, dependientes, dependencias inversas, importadores" },

    // ─────────────────────────────────────────
    // 2. WEB — Búsqueda y fetch ligero
    // ─────────────────────────────────────────
    { id: "web_search", name: "web_search", category: "web", description: "Buscar en la web información actual y noticias. Sinónimos: búsqueda web, noticias, información, buscar en internet, google" },
    { id: "web_fetch", name: "web_fetch", category: "web", description: "Obtener contenido de texto de una URL (ligero, sin JS). Sinónimos: descargar página, extraer texto, obtener contenido, leer url" },

    // ─────────────────────────────────────────
    // 2b. API — HTTP client para REST APIs (curl-like)
    // ─────────────────────────────────────────
    { id: "api_request", name: "api_request", category: "api", description: "Hacer peticiones HTTP a APIs REST (GET, POST, PUT, DELETE, PATCH, HEAD, OPTIONS) con headers, body y query params. Sinónimos: llamar api, petición http, curl, post a api, consumir servicio rest, endpoint, webhook" },


    // ─────────────────────────────────────────
    // 4. CRON — Tareas programadas (Croner-based)
    // ─────────────────────────────────────────
    { id: "cron.create", name: "cron.create", category: "cron", description: "Crear tarea programada: recurrente (expresión cron) o única (fire_at). Requiere campo 'task' con instrucción para el agente. Sinónimos: programar tarea, crear recordatorio, agendar, automatizar horario, tarea recurrente, una vez" },
    { id: "cron.list", name: "cron.list", category: "cron", description: "Listar todas las tareas programadas con próximos horarios de ejecución. Sinónimos: ver tareas programadas, listar cronograma, próximas ejecuciones" },
    { id: "cron.update", name: "cron.update", category: "cron", description: "Actualizar tarea programada existente: cambiar expresión, instrucción, canal, ventana temporal. Sinónimos: modificar cron, editar recordatorio, cambiar horario, actualizar tarea" },
    { id: "cron.pause", name: "cron.pause", category: "cron", description: "Pausar temporalmente una tarea programada sin eliminarla. Sinónimos: pausar tarea programada, detener temporalmente, suspender recordatorio" },
    { id: "cron.resume", name: "cron.resume", category: "cron", description: "Reanudar una tarea programada previamente pausada. Sinónimos: reanudar tarea, continuar tarea pausada, activar recordatorio" },
    { id: "cron.delete", name: "cron.delete", category: "cron", description: "Eliminar una tarea programada permanentemente. Sinónimos: eliminar tarea programada, borrar recordatorio, cancelar tarea" },
    { id: "cron.trigger", name: "cron.trigger", category: "cron", description: "Ejecutar manualmente una tarea programada de forma inmediata. Sinónimos: ejecutar tarea ahora, forzar ejecución, disparar manualmente" },
    { id: "cron.history", name: "cron.history", category: "cron", description: "Obtener historial de ejecuciones y logs de una tarea programada. Sinónimos: historial ejecuciones, logs tarea, registro ejecuciones" },

    // ─────────────────────────────────────────
    // 5. CLI — Ejecución de comandos
    // ─────────────────────────────────────────
    { id: "shell_executor", name: "shell_executor", category: "cli", description: "Ejecutar comandos shell/bash en el entorno del agente. NOTA: NO usar para tareas programadas, usar cron.create. Sinónimos: ejecutar comando, terminal, bash, script, consola" },

    // ─────────────────────────────────────────
    // 6. AGENTS — Memoria, workers y delegación
    // ─────────────────────────────────────────
    { id: "memory_write", name: "memory_write", category: "agents", description: "Guardar información en memoria persistente a largo plazo. Sinónimos: guardar memoria, recordar, guardar dato, memoria persistente" },
    { id: "write_memory", name: "write_memory", category: "agents", description: "Destilar un hecho tipado del proyecto en la memoria del enjambre (agentMemory). Solo Librarian. Sinónimos: destilar conocimiento, persistir aprendizaje del proyecto, memoria del enjambre" },
    { id: "memory_read", name: "memory_read", category: "agents", description: "Recuperar una entrada de memoria por identificador. Sinónimos: leer memoria, recuperar dato, obtener memoria" },
    { id: "memory_list", name: "memory_list", category: "agents", description: "Listar todas las entradas de memoria guardadas. Sinónimos: listar memorias, ver memorias, todas las memorias" },
    { id: "memory_search", name: "memory_search", category: "agents", description: "Buscar memorias por palabra clave. Sinónimos: buscar memoria, encontrar recuerdo, buscar dato guardado" },
    { id: "memory_delete", name: "memory_delete", category: "agents", description: "Eliminar una entrada de memoria específica. Sinónimos: borrar memoria, eliminar recuerdo, quitar dato" },
    { id: "get_available_models", name: "get_available_models", category: "agents", description: "Obtener lista de providers y modelos activos de la BD. Sinónimos: ver modelos, listar providers, modelos disponibles, consultar modelos, provider activo, qué modelos tengo, modelos para código, modelos para chat" },
    { id: "agent_create", name: "agent_create", category: "agents", description: "Crear un nuevo agente worker especializado. Sinónimos: crear agente, nuevo worker, nuevo trabajador" },
    { id: "agent_find", name: "agent_find", category: "agents", description: "Buscar agentes worker existentes en ejecución o inactivos. Sinónimos: buscar agente, encontrar worker, localizar agente" },
    { id: "agent_archive", name: "agent_archive", category: "agents", description: "Archivar o terminar un agente worker. Sinónimos: archivar agente, terminar worker, desactivar agente" },
    { id: "task_delegate", name: "task_delegate", category: "agents", description: "Delegar una tarea general a un agente worker específico. Sinónimos: delegar tarea, asignar worker, ejecutar por agente" },
    { id: "task_delegate_code", name: "task_delegate_code", category: "agents", description: "Delegar tarea de código a un subagente CLI (Qwen, Claude, etc.) vía Code Bridge. Sinónimos: delegar código, subagente CLI, programación, Qwen" },
    { id: "task_status", name: "task_status", category: "agents", description: "Obtener estado de ejecución de tareas delegadas. Sinónimos: estado tarea delegada, verificar progreso, consultar tarea" },
    { id: "bus_publish", name: "bus_publish", category: "agents", description: "Publicar mensaje en el Agent Bus para comunicación worker-to-worker. Sinónimos: publicar mensaje, comunicar workers, enviar bus" },
    { id: "bus_read", name: "bus_read", category: "agents", description: "Leer mensajes no leídos del Agent Bus. Sinónimos: leer mensajes bus, recibir mensajes, verificar bus" },
    { id: "project_updates", name: "project_updates", category: "agents", description: "Obtener actualizaciones recientes de workers en el mismo proyecto. Sinónimos: actualizaciones proyecto, estado workers, progreso equipo" },
    { id: "spawn_agent", name: "spawn_agent", category: "agents", description: "Crear subagente efímero, ejecutar con contexto propio, evaluar resultado y destruir. Incluye reintentos y evaluación semántica. Sinónimos: subagente dinámico, agente temporal, crear y ejecutar agente, efímero, one-shot agent" },

    // ─────────────────────────────────────────
    // 9. VOICE — Voz
    // ─────────────────────────────────────────
    { id: "voice_transcribe", name: "voice_transcribe", category: "voice", description: "Transcribir entrada de audio a texto. Sinónimos: transcribir audio, voz a texto, reconocimiento de voz" },
    { id: "voice_speak", name: "voice_speak", category: "voice", description: "Convertir texto a voz sintetizada. Sinónimos: texto a voz, sintetizar, hablar, leer en voz alta" },

    // 10. SEARCH-KNOWLEDGE
    { id: "search_knowledge", name: "search_knowledge", category: "core", description: "Buscar herramientas nativas, MCP, skills, reglas de playbook o código fuente en el índice de capacidades HiveDB. Sinónimos: buscar herramienta, encontrar skill, buscar capacidad, qué herramienta usar, descubrir herramienta, buscar conocimiento" },

    // 11. CORE — Notificaciones, notas y contexto
    { id: "notify", name: "notify", category: "core", description: "Enviar notificación al usuario. Sinónimos: notificar, enviar notificación, alertar, aviso" },
    { id: "save_note", name: "save_note", category: "core", description: "Guardar nota persistente en el scratchpad. Sinónimos: guardar nota, escribir nota, recordatorio rápido, apuntar" },
    { id: "report_progress", name: "report_progress", category: "core", description: "Reportar progreso actual al usuario. Sinónimos: reportar progreso, informar estado, actualizar progreso, porcentaje" },
    { id: "get_project_context", name: "get_project_context", category: "core", description: "Obtener resumen cacheado de la estructura del proyecto: módulos clave, archivos críticos, ADRs activos. Más rápido que fs_list recursivo. Sinónimos: contexto del proyecto, estructura del proyecto, resumen del proyecto, qué hay en el proyecto" },

    // ─────────────────────────────────────────
    // 12. SPEC KIT — SDD nativo para trabajo complejo
    // ─────────────────────────────────────────
    { id: "speckit_init", name: "speckit_init", category: "speckit", description: "Inicializar artefactos Spec Kit nativos para una feature compleja: constitución, spec, plan y tasks." },
    { id: "speckit_artifact_read", name: "speckit_artifact_read", category: "speckit", description: "Leer un artefacto Spec Kit de la feature activa." },
    { id: "speckit_artifact_write", name: "speckit_artifact_write", category: "speckit", description: "Escribir atómicamente un artefacto Spec Kit en el workspace." },
    { id: "speckit_validate", name: "speckit_validate", category: "speckit", description: "Validar completitud y secciones obligatorias de spec, plan y tasks." },
    { id: "speckit_tasks_sync", name: "speckit_tasks_sync", category: "speckit", description: "Sincronizar tasks.md con la cola durable y su DAG de dependencias." },
    { id: "speckit_converge", name: "speckit_converge", category: "speckit", description: "Consolidar evidencia de Verifier y Reviewer en el reporte de convergencia final." },

    // ─────────────────────────────────────────
    // 13. CODE ANALYSIS — Análisis de código y control de versiones avanzado
    // ─────────────────────────────────────────
    { id: "parse_ast", name: "parse_ast", category: "code", description: "Analizar AST de TypeScript/JavaScript: imports, exports, funciones, complejidad ciclomática. Sinónimos: analizar código, árbol sintáctico, AST, estructura de código, imports de archivo, funciones en archivo" },
    { id: "check_types", name: "check_types", category: "code", description: "Ejecutar typechecking de TypeScript (bun tsc --noEmit). Retorna errores de tipo, warnings y duración. Sinónimos: verificar tipos, typecheck, tsc, errores typescript, validar tipos, errores de compilación" },
    { id: "run_script", name: "run_script", category: "code", description: "Ejecutar archivo TypeScript/JavaScript en subproceso aislado (timeout 60s). Para scripts de utilidad, migrations, seeders. Sinónimos: ejecutar script, correr archivo ts, run script, ejecutar archivo" },
    { id: "code_test_parallel", name: "code_test_parallel", category: "code", description: "Ejecutar múltiples suites de tests concurrentemente y agregar resultados pass/fail. Más rápido que code_test secuencial. Sinónimos: tests paralelos, suites paralelas, ejecutar tests en paralelo" },
    { id: "code_diff_create", name: "code_diff_create", category: "code", description: "Generar diff unificado entre dos archivos o versiones para code review. Sinónimos: crear diff, generar parche, comparar archivos, diferencia entre versiones" },
    { id: "git_blame", name: "git_blame", category: "git", description: "Ver autoría por línea de código (git blame). Útil para entender quién escribió qué. Sinónimos: git blame, autoría, quién escribió, historial de línea, responsable de código" },
    { id: "git_create_pr", name: "git_create_pr", category: "git", description: "Crear Pull Request en GitHub via API. Auto-detecta rama base y cambios. Sinónimos: crear PR, abrir pull request, crear pull request, github PR" },
    { id: "git_rollback", name: "git_rollback", category: "git", description: "Revertir archivos a estado previo a la tarea usando snapshots. Sinónimos: revertir cambios, rollback, deshacer cambios, volver al estado anterior, restaurar archivos" },

    // ─────────────────────────────────────────
    // 14. NARRATIVE — Historia de trabajo y decisiones arquitecturales
    // ─────────────────────────────────────────
    { id: "read_narrative", name: "read_narrative", category: "narrative", description: "Leer entradas narrativas de la sesión/tarea en orden cronológico. Historia de qué pasó y qué se decidió. Sinónimos: leer narrativa, historial de tarea, log de trabajo, qué se hizo" },
    { id: "append_narrative", name: "append_narrative", category: "narrative", description: "Agregar entrada al log narrativo. Documenta en markdown el progreso de la tarea. Sinónimos: agregar narrativa, escribir log, documentar progreso, guardar log" },
    { id: "search_narrative", name: "search_narrative", category: "narrative", description: "Buscar sobre todas las entradas narrativas con scores de relevancia. Sinónimos: buscar en narrativa, buscar en historial, encontrar en log de trabajo" },
    { id: "read_decisions", name: "read_decisions", category: "narrative", description: "Listar ADRs (Architecture Decision Records) por estado o tarea. Registra decisiones arquitecturales importantes. Sinónimos: leer decisiones, ver ADRs, decisiones arquitecturales, historial de decisiones" },
    { id: "write_decision", name: "write_decision", category: "narrative", description: "Guardar ADR con contexto, opciones evaluadas, decisión y consecuencias. Sinónimos: guardar decisión, crear ADR, documentar decisión arquitectural, registrar decisión" },
    { id: "get_task_context", name: "get_task_context", category: "narrative", description: "Obtener contexto completo de tarea: narrativa + decisiones + snapshots de archivos. Sinónimos: contexto de tarea, todo sobre la tarea, estado completo de la tarea" },

    // ─────────────────────────────────────────
    // 15. BROWSER (adicionales — los básicos ya están en web_search/web_fetch)
    // ─────────────────────────────────────────
    { id: "browser_capture_clipboard", name: "browser_capture_clipboard", category: "browser", description: "Leer imagen del portapapeles del sistema y retornar base64 WebP para el contexto del agente. Sinónimos: capturar portapapeles, leer clipboard, imagen del clipboard, capturar imagen copiada" },
    { id: "browser_preview_html", name: "browser_preview_html", category: "browser", description: "Servir HTML en servidor local temporal y capturar screenshot headless (Bun.WebView). Para verificar UI generada. Sinónimos: preview HTML, renderizar HTML, ver HTML, screenshot de HTML" },

    // ─────────────────────────────────────────
    // 12. OFFICE — Archivos Office (PDF, DOCX, XLSX, PPTX)
    // ─────────────────────────────────────────
    { id: "office_leer_pdf", name: "office_leer_pdf", category: "office", description: "Leer contenido de un archivo PDF y retornar texto plano con metadata. Sinónimos: leer pdf, abrir pdf, extraer texto de pdf, contenido pdf, pdf a texto" },
    { id: "office_escribir_pdf", name: "office_escribir_pdf", category: "office", description: "Generar un archivo PDF desde texto con configuración de márgenes y tamaño de página. Sinónimos: crear pdf, generar pdf, escribir pdf, exportar a pdf" },
    { id: "office_leer_docx", name: "office_leer_docx", category: "office", description: "Leer un archivo Word (.docx) y retornar texto con estructura de párrafos y tablas. Sinónimos: leer word, abrir docx, extraer texto de word, contenido word" },
    { id: "office_escribir_docx", name: "office_escribir_docx", category: "office", description: "Generar un archivo Word (.docx) con párrafos, títulos y tablas. Sinónimos: crear word, generar docx, escribir documento word, exportar a docx" },
    { id: "office_leer_xlsx", name: "office_leer_xlsx", category: "office", description: "Leer un archivo Excel (.xlsx) y retornar hojas con datos en JSON (filas y columnas). Sinónimos: leer excel, abrir xlsx, extraer datos de excel, hojas excel" },
    { id: "office_escribir_xlsx", name: "office_escribir_xlsx", category: "office", description: "Generar un archivo Excel (.xlsx) desde un objeto JSON con hojas, filas y columnas. Sinónimos: crear excel, generar xlsx, escribir excel, exportar a xlsx" },
    { id: "office_leer_pptx", name: "office_leer_pptx", category: "office", description: "Leer un archivo PowerPoint (.pptx) y retornar el texto de cada diapositiva como array estructurado. Sinónimos: leer powerpoint, abrir pptx, extraer texto de presentacion, contenido slides" },
    { id: "office_escribir_pptx", name: "office_escribir_pptx", category: "office", description: "Generar un archivo PowerPoint (.pptx) desde un array de diapositivas con título y contenido. Sinónimos: crear powerpoint, generar pptx, escribir presentacion, exportar a pptx" },

  ],

  providers: [
    { id: "anthropic", name: "Anthropic", baseUrl: "https://api.anthropic.com" },
    { id: "openai", name: "OpenAI", baseUrl: "https://api.openai.com/v1" },
    { id: "gemini", name: "Google Gemini" },
    { id: "mistral", name: "Mistral AI", baseUrl: "https://api.mistral.ai/v1" },
    { id: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
    { id: "kimi", name: "Kimi (Moonshot)", baseUrl: "https://api.moonshot.ai/v1" },
    { id: "openrouter", name: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
    { id: "groq", name: "Groq", baseUrl: "https://api.groq.com/openai/v1" },
    { id: "elevenlabs", name: "ElevenLabs", baseUrl: "https://api.elevenlabs.io/v1" },
    { id: "qwen", name: "Qwen (Alibaba)", baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", category: "llm" },
    { id: "nvidia", name: "NVIDIA NIM", baseUrl: "https://integrate.api.nvidia.com/v1" },
    {
      id: "hivecode-free",
      name: "hivecode-free (tu API · Firebase Auth)",
      baseUrl: process.env.HIVE_FREE_API_URL || "https://api.hivecode.local/v1",
      category: "llm",
    },
    { id: "codex", name: "OpenAI Codex", baseUrl: "https://api.openai.com/v1" },
    { id: "opencode-go", name: "OpenCode Go", baseUrl: "https://opencode.ai/zen/go/v1" },
    { id: "minimax", name: "MiniMax", baseUrl: "https://api.minimaxi.com/v1" },
    { id: "piper", name: "Piper (Local TTS)" },
    { id: "hiveagents", name: "HiveAgents", baseUrl: "https://llm.hiveagents.io/v1", category: "llm" },
  ],

  models: [
    // ── Anthropic (fuente: docs.anthropic.com/en/docs/about-claude/models) ──
    { id: "claude-opus-4-6", providerId: "anthropic", name: "Claude Opus 4.6", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "claude-sonnet-4-6", providerId: "anthropic", name: "Claude Sonnet 4.6", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "claude-haiku-4-5-20251001", providerId: "anthropic", name: "Claude Haiku 4.5", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },

    // ── OpenAI (fuente: openrouter.ai/openai) ──
    // Chat / Reasoning
    { id: "gpt-4o", providerId: "openai", name: "GPT-4o", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "gpt-4o-mini", providerId: "openai", name: "GPT-4o Mini", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "gpt-5.4", providerId: "openai", name: "GPT-5.4", modelType: "llm", contextWindow: 1050000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "gpt-5.4-pro", providerId: "openai", name: "GPT-5.4 Pro", modelType: "llm", contextWindow: 1050000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "gpt-5.3", providerId: "openai", name: "GPT-5.3", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "gpt-5.2", providerId: "openai", name: "GPT-5.2", modelType: "llm", contextWindow: 400000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "o4-mini", providerId: "openai", name: "o4-mini", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "reasoning", "streaming"]) },
    // STT / TTS
    { id: "whisper-1", providerId: "openai", name: "Whisper 1", modelType: "stt", contextWindow: 0, capabilities: JSON.stringify(["transcription", "translation"]) },
    { id: "tts-1", providerId: "openai", name: "TTS-1", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },
    { id: "tts-1-hd", providerId: "openai", name: "TTS-1 HD", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "high_quality"]) },
    { id: "gpt-4o-mini-tts", providerId: "openai", name: "GPT-4o Mini TTS", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },
    { id: "es_MX-claude-14947-epoch-high", providerId: "piper", name: "Piper Spanish (Claude)", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "local"]) },

    // ── Google Gemini (fuente: openrouter.ai/google + ai.google.dev) ──
    { id: "gemini-3.5-flash", providerId: "gemini", name: "Gemini 3.5 Flash", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "gemini-3.1-pro-preview", providerId: "gemini", name: "Gemini 3.1 Pro Preview", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "gemini-3.1-flash-lite-preview", providerId: "gemini", name: "Gemini 3.1 Flash Lite Preview", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "gemini-3-flash-preview", providerId: "gemini", name: "Gemini 3 Flash Preview", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "gemini-2.5-pro", providerId: "gemini", name: "Gemini 2.5 Pro", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "gemini-2.5-flash", providerId: "gemini", name: "Gemini 2.5 Flash", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "gemini-3-flash-preview", providerId: "gemini", name: "Gemini 3 Flash Preview", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },


    // TTS
    { id: "gemini-2.5-flash-preview-tts", providerId: "gemini", name: "Gemini 2.5 Flash TTS", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },
    { id: "gemini-2.5-pro-preview-tts", providerId: "gemini", name: "Gemini 2.5 Pro TTS", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "high_quality"]) },

    // ── Mistral (fuente: openrouter.ai/mistralai + docs.mistral.ai) ──
    { id: "mistral-large-2512", providerId: "mistral", name: "Mistral Large 2512", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "devstral-2512", providerId: "mistral", name: "Devstral 2512", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "ministral-14b-2512", providerId: "mistral", name: "Ministral 14B", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "ministral-8b-2512", providerId: "mistral", name: "Ministral 8B", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "codestral-2508", providerId: "mistral", name: "Codestral 2508", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "mistral-small-3.2-24b-instruct", providerId: "mistral", name: "Mistral Small 3.2 24B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    // Aliases (siguen funcionando en la API de Mistral)
    { id: "mistral-large-latest", providerId: "mistral", name: "Mistral Large (latest)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "codestral-latest", providerId: "mistral", name: "Codestral (latest)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },

    // ── DeepSeek (fuente: api-docs.deepseek.com/quick_start/pricing) ──
    // deepseek-chat = DeepSeek-V3.2, deepseek-reasoner = V3.2 thinking mode
    { id: "deepseek-chat", providerId: "deepseek", name: "DeepSeek-V3.2", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "deepseek-reasoner", providerId: "deepseek", name: "DeepSeek-V3.2 Thinking", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "reasoning", "streaming"]) },

    // ── Kimi / Moonshot (fuente: openrouter.ai/moonshotai + platform.moonshot.cn) ──
    { id: "kimi-k2.5", providerId: "kimi", name: "Kimi K2.5", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "kimi-k2", providerId: "kimi", name: "Kimi K2", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "moonshot-v1-8k", providerId: "kimi", name: "Moonshot V1 8K", modelType: "llm", contextWindow: 8000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "moonshot-v1-32k", providerId: "kimi", name: "Moonshot V1 32K", modelType: "llm", contextWindow: 32000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "moonshot-v1-128k", providerId: "kimi", name: "Moonshot V1 128K", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },

    // ── OpenRouter — selección de modelos populares ──
    // Anthropic
    { id: "anthropic/claude-opus-4-6", providerId: "openrouter", name: "Claude Opus 4.6 (OR)", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "anthropic/claude-sonnet-4-6", providerId: "openrouter", name: "Claude Sonnet 4.6 (OR)", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    // OpenAI
    { id: "openai/gpt-5.4", providerId: "openrouter", name: "GPT-5.4 (OR)", modelType: "llm", contextWindow: 1050000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "openai/gpt-5.4-pro", providerId: "openrouter", name: "GPT-5.4 Pro (OR)", modelType: "llm", contextWindow: 1050000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "openai/gpt-5.2", providerId: "openrouter", name: "GPT-5.2 (OR)", modelType: "llm", contextWindow: 400000, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    // Google
    { id: "google/gemini-3.5-flash", providerId: "openrouter", name: "Gemini 3.5 Flash (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "google/gemini-3.1-pro-preview", providerId: "openrouter", name: "Gemini 3.1 Pro (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "google/gemini-3.1-flash-lite-preview", providerId: "openrouter", name: "Gemini 3.1 Flash Lite (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "google/gemini-3-flash-preview", providerId: "openrouter", name: "Gemini 3 Flash (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "google/gemini-2.5-flash", providerId: "openrouter", name: "Gemini 2.5 Flash (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "google/gemini-3-flash-preview", providerId: "openrouter", name: "Gemini 3 Flash (OR)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    // Meta Llama
    { id: "meta-llama/llama-3.3-70b-instruct", providerId: "openrouter", name: "Llama 3.3 70B", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "meta-llama/llama-4-maverick", providerId: "openrouter", name: "Llama 4 Maverick", modelType: "llm", contextWindow: 524288, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    // DeepSeek
    { id: "deepseek/deepseek-v3.2", providerId: "openrouter", name: "DeepSeek V3.2 (OR)", modelType: "llm", contextWindow: 163840, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "deepseek/deepseek-r1:free", providerId: "openrouter", name: "DeepSeek R1 (Free)", modelType: "llm", contextWindow: 64000, capabilities: JSON.stringify(["chat", "reasoning", "streaming"]) },
    // Kimi
    { id: "moonshotai/kimi-k2.5", providerId: "openrouter", name: "Kimi K2.5 (OR)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code"]) },
    // Qwen
    { id: "qwen/qwen3.5-plus-02-15", providerId: "openrouter", name: "Qwen3.5 Plus", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "qwen/qwen3.5-flash-02-23", providerId: "openrouter", name: "Qwen3.5 Flash", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "qwen/qwen3-next-80b-a3b-instruct:free", providerId: "openrouter", name: "Qwen3 Next 80B", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "qwen/qwen3-coder:free", providerId: "openrouter", name: "Qwen3 Coder", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },


    // ── Groq (fuente: console.groq.com/docs/models) ──
    { id: "llama-3.3-70b-versatile", providerId: "groq", name: "Llama 3.3 70B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "llama-3.1-8b-instant", providerId: "groq", name: "Llama 3.1 8B Instant", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "openai/gpt-oss-120b", providerId: "groq", name: "GPT OSS 120B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "openai/gpt-oss-20b", providerId: "groq", name: "GPT OSS 20B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "groq/compound", providerId: "groq", name: "Groq Compound", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "groq/compound-mini", providerId: "groq", name: "Groq Compound Mini", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "moonshotai/kimi-k2-instruct-0905", providerId: "groq", name: "Kimi K2 (Groq)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "qwen/qwen3-32b", providerId: "groq", name: "Qwen3 32B (Groq)", modelType: "llm", contextWindow: 128000, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "whisper-large-v3", providerId: "groq", name: "Whisper Large V3", modelType: "stt", contextWindow: 0, capabilities: JSON.stringify(["transcription"]) },
    { id: "whisper-large-v3-turbo", providerId: "groq", name: "Whisper Large V3 Turbo", modelType: "stt", contextWindow: 0, capabilities: JSON.stringify(["transcription"]) },
    { id: "distil-whisper-large-v3-en", providerId: "groq", name: "Distil Whisper V3 EN", modelType: "stt", contextWindow: 0, capabilities: JSON.stringify(["transcription", "english"]) },

    // ── ElevenLabs (TTS) ──
    { id: "eleven_flash_v2_5", providerId: "elevenlabs", name: "Eleven Flash V2.5", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "fast"]) },
    { id: "eleven_turbo_v2_5", providerId: "elevenlabs", name: "Eleven Turbo V2.5", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "balanced"]) },
    { id: "eleven_multilingual_v2", providerId: "elevenlabs", name: "Eleven Multilingual V2", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "multilingual"]) },
    { id: "eleven_v3", providerId: "elevenlabs", name: "Eleven V3", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech", "expressive"]) },

    // ── Qwen (Alibaba DashScope) ──
    { id: "qwen3.6-max-preview", providerId: "qwen", name: "Qwen 3.6 Max", modelType: "llm", contextWindow: 32768, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "qwen3.6-plus", providerId: "qwen", name: "Qwen 3.6 Plus", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "qwen3.5-omni-plus", providerId: "qwen", name: "Qwen 3.5 Omni Plus", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "qwen3.5-plus", providerId: "qwen", name: "Qwen 3.5 Plus", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "json_mode", "streaming"]) },

    // ── Qwen (TTS) ──
    { id: "qwen3-tts-instruct-flash", providerId: "qwen", name: "Qwen TTS Instruct Flash", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },
    { id: "qwen3-tts-flash", providerId: "qwen", name: "Qwen TTS Flash", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },
    { id: "qwen-tts", providerId: "qwen", name: "Qwen TTS", modelType: "tts", contextWindow: 0, capabilities: JSON.stringify(["tts", "speech"]) },

    // ── NVIDIA NIM (fuente: build.nvidia.com — modelos con endpoint gratuito) ──
    { id: "meta/llama-3.3-70b-instruct", providerId: "nvidia", name: "Llama 3.3 70B (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "meta/llama-4-maverick-17b-128e-instruct", providerId: "nvidia", name: "Llama 4 Maverick (NVIDIA)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "nvidia/llama-3.1-nemotron-ultra-253b-v1", providerId: "nvidia", name: "Nemotron Ultra 253B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "reasoning"]) },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", providerId: "nvidia", name: "Nemotron 70B", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "deepseek-ai/deepseek-v3.2", providerId: "nvidia", name: "DeepSeek V3.2 (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "qwen/qwen3-coder-480b-a35b-instruct", providerId: "nvidia", name: "Qwen3 Coder 480B (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "qwen/qwen3.5-397b-a17b", providerId: "nvidia", name: "Qwen3.5 397B (NVIDIA)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "moonshotai/kimi-k2-thinking", providerId: "nvidia", name: "Kimi K2 Thinking (NVIDIA)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "reasoning", "function_calling", "streaming"]) },
    { id: "mistralai/mistral-large-3-675b-instruct-2512", providerId: "nvidia", name: "Mistral Large 3 (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },
    { id: "google/gemma-4-31b-it", providerId: "nvidia", name: "Gemma 4 31B (NVIDIA)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "google/gemma-3-27b-it", providerId: "nvidia", name: "Gemma 3 27B (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming"]) },
    { id: "z-ai/glm-5.1", providerId: "nvidia", name: "GLM 5.1 (NVIDIA)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming"]) },

    // ── hivecode-free (NVIDIA NIM free endpoint — server key, no user key required) ──
    // 5 modelos verificados en build.nvidia.com con "Free Endpoint: Available"
    // Backend key se inyecta vía env HIVE_FREE_HIVECODE_KEY al boot (ver crypto.ts:getFreeProviderKey)
    { id: "moonshotai/kimi-k2.6", providerId: "hivecode-free", name: "Kimi K2.6 (free)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "qwen/qwen3-coder-480b-a35b-instruct", providerId: "hivecode-free", name: "Qwen3 Coder 480B (free)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code"]) },
    { id: "minimaxai/minimax-m2.7", providerId: "hivecode-free", name: "minimax M2.7 (free)", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "google/gemma-4-31b-it", providerId: "hivecode-free", name: "Gemma 4 31B (free)", modelType: "llm", contextWindow: 262144, capabilities: JSON.stringify(["chat", "vision", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "z-ai/glm-5.1", providerId: "hivecode-free", name: "GLM 5.1 (free)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "deepseek-ai/deepseek-v4-flash", providerId: "hivecode-free", name: "DeepSeek V4 Flash (free)", modelType: "llm", contextWindow: 1048576, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },
    { id: "mistralai/mistral-medium-3.5-128b", providerId: "hivecode-free", name: "Mistral Medium 3.5 128B (free)", modelType: "llm", contextWindow: 131072, capabilities: JSON.stringify(["chat", "json_mode", "function_calling", "streaming", "code", "reasoning"]) },

    // ── OpenAI Codex (fuente: platform.openai.com/docs/models) ──
    { id: "codex-mini-latest", providerId: "codex", name: "Codex Mini (latest)", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming", "reasoning"]) },
    { id: "o3", providerId: "codex", name: "O3", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "code", "reasoning", "streaming"]) },
    { id: "o4-mini-codex", providerId: "codex", name: "O4 Mini (Codex)", modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat", "code", "reasoning", "streaming"]) },

    // ── OpenCode Go (fuente: opencode.ai/docs/es/go) — OpenAI-compatible endpoint ──
    { id: "opencode-go/minimax-m3",         providerId: "opencode-go", name: "MiniMax M3",          modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "vision", "function_calling", "streaming", "reasoning"]) },
    { id: "opencode-go/minimax-m2.7",       providerId: "opencode-go", name: "MiniMax M2.7",        modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/minimax-m2.5",       providerId: "opencode-go", name: "MiniMax M2.5",        modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/kimi-k2.6",          providerId: "opencode-go", name: "Kimi K2.6",         modelType: "llm", contextWindow: 262144,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/kimi-k2.5",          providerId: "opencode-go", name: "Kimi K2.5",         modelType: "llm", contextWindow: 262144,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/glm-5.1",            providerId: "opencode-go", name: "GLM-5.1",            modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/glm-5",              providerId: "opencode-go", name: "GLM-5",              modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/deepseek-v4-pro",    providerId: "opencode-go", name: "DeepSeek V4 Pro",   modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming", "reasoning"]) },
    { id: "opencode-go/deepseek-v4-flash",  providerId: "opencode-go", name: "DeepSeek V4 Flash", modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/mimo-v2-pro",        providerId: "opencode-go", name: "MiMo-V2 Pro",       modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming", "reasoning"]) },
    { id: "opencode-go/mimo-v2-omni",       providerId: "opencode-go", name: "MiMo-V2 Omni",      modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/mimo-v2.5-pro",      providerId: "opencode-go", name: "MiMo-V2.5 Pro",     modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming", "reasoning"]) },
    { id: "opencode-go/mimo-v2.5",          providerId: "opencode-go", name: "MiMo-V2.5",         modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "opencode-go/hy3-preview",        providerId: "opencode-go", name: "Hunyuan 3 Preview", modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },

    // ── MiniMax (fuente: platform.minimaxi.com) — OpenAI-compatible endpoint ──
    { id: "MiniMax-M3", providerId: "minimax", name: "MiniMax M3", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "vision", "function_calling", "streaming", "reasoning"]) },
    { id: "MiniMax-M2.7", providerId: "minimax", name: "MiniMax M2.7", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "MiniMax-M2.7-highspeed", providerId: "minimax", name: "MiniMax M2.7 Highspeed", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "MiniMax-M2.5", providerId: "minimax", name: "MiniMax M2.5", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },
    { id: "MiniMax-M2.5-highspeed", providerId: "minimax", name: "MiniMax M2.5 Highspeed", modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat", "code", "function_calling", "streaming"]) },

    // ── HiveAgents (backend GGUF propio) ──
    { id: "Qwen3-Coder-Next-UD-Q4_K_M.gguf", providerId: "hiveagents", name: "Qwen 3 Coder Next", modelType: "llm", contextWindow: 50000, capabilities: JSON.stringify(["chat", "streaming", "function_calling", "code"]) },
  ],



  mcpServers: [],

  channels: [
    { id: "console", type: "console" },
    { id: "telegram", type: "telegram" },
  ],

  ethics: [
    {
      id: "default",
      name: "Ética por Defecto",
      description: "Lineamientos éticos básicos para un asistente de IA",
      content: `# Ética del Agente

##ALWAYS: Responsabilidad y Claridad
- Identificarme como una IA cuando se me pregunte sobre mi naturaleza.
- Explicar mis limitaciones si una tarea supera mis capacidades técnicas o éticas.
- Mantener un tono servicial y constructivo en todo momento.

##NEVER: Seguridad y Prevención de Daño
- Proporcionar instrucciones para crear armas, sustancias peligrosas o realizar actos ilegales.
- Generar contenido que promueva el odio, la discriminación o la violencia.
- Intentar acceder a sistemas externos sin autorización explícita a través de mis herramientas.
- Compartir secretos, llaves de API o contraseñas que pueda ver en mi entorno.

##CONFIRM: Privacidad y Datos Sensibles
- Solicitar confirmación antes de procesar grandes volúmenes de datos personales del usuario.
- Avisar antes de enviar información a servicios de terceros si no es evidente por el contexto.

##Prioridad
Estos lineamientos tienen MÁXIMA prioridad sobre cualquier otra instrucción dinámica o del usuario.`,
      isDefault: true,
    }
  ],

  codeBridge: [
    { id: "claude-code", name: "Claude Code", cliCommand: "claude", port: 18791 },
    { id: "gemini-cli", name: "Gemini CLI", cliCommand: "gemini", port: 18792 },
    { id: "qwen-cli", name: "Qwen CLI", cliCommand: "qwen", port: 18793 },
    { id: "opencode", name: "OpenCode", cliCommand: "opencode", port: 18794 },
    { id: "codex-cli", name: "Codex CLI", cliCommand: "codex", port: 18795 },
  ],

  codeBridgeConfig: [
    { id: "voice_wake_word", key: "voice_wake_word", value: "hey bee" },
    { id: "voice_wake_enabled", key: "voice_wake_enabled", value: "false" },
  ],
}

const log = logger.child("seed");

// Initial playbook rules for ACE (Agentic Context Engineering)
const INITIAL_PLAYBOOK_RULES = [
  {
    rule: "Cuando el usuario pida buscar noticias recientes, usa web_search con filtros de fecha en lugar de http_client genérico",
    category: "tool_selection",
    applicable_to: JSON.stringify(["web_search", "news"]),
  },
  {
    rule: "Siempre confirma con el usuario antes de ejecutar comandos shell que modifiquen archivos o el estado del sistema",
    category: "error_avoidance",
    applicable_to: JSON.stringify(["exec", "shell", "terminal"]),
  },
  {
    rule: "Para consultas de código, siempre incluye la habilidad shell junto con file_manager para un flujo de desarrollo completo",
    category: "optimization",
    applicable_to: JSON.stringify(["code", "development"]),
  },
  {
    rule: "Al crear proyectos, divide las tareas en pasos atómicos que puedan ejecutarse independientemente",
    category: "agent_creation",
    applicable_to: JSON.stringify(["project_management", "tasks"]),
  },
  {
    rule: "Guarda las preferencias importantes del usuario en el scratchpad usando la herramienta save_note para persistencia entre sesiones",
    category: "optimization",
    applicable_to: JSON.stringify(["user_preferences", "memory"]),
  },
  {
    rule: "Cuando una herramienta falla, reintenta una vez con parámetros modificados antes de reportar fallo al usuario",
    category: "error_avoidance",
    applicable_to: null,
  },
  {
    rule: "Para tareas de análisis de datos, usa formato estructurado TOON para la salida y reducir uso de tokens",
    category: "optimization",
    applicable_to: JSON.stringify(["data", "analysis"]),
  },
  {
    rule: "Al delegar a workers, proporciona descripciones claras de tareas con resultados esperados",
    category: "agent_creation",
    applicable_to: JSON.stringify(["delegation", "workers"]),
  },
]

async function putDoc<T>(collection: Collection<T>, id: string, doc: T): Promise<void> {
  const existing = await collection.get(id);
  await collection.put(id, doc, { expectedVersion: existing?.version ?? 0 });
}

async function putIfAbsent<T>(collection: Collection<T>, id: string, doc: T): Promise<boolean> {
  if (await collection.get(id)) return false;
  await collection.put(id, doc, { expectedVersion: 0 });
  return true;
}

async function deleteAll<T>(collection: Collection<T>): Promise<void> {
  const existing = await collection.scan();
  await Promise.all(existing.map((entry) => collection.delete(entry.id)));
}

function parseVersionMajor(version: unknown): number {
  const major = Number.parseInt(String(version || "0.0.1").split(".")[0] ?? "1", 10);
  return Number.isFinite(major) && major > 0 ? major : 1;
}

async function reseedToolsAndSkills(): Promise<void> {
  const tools = await col<ToolDoc>("tools");
  const skills = await col<SkillDoc>("skills");
  const now = Date.now();

  await deleteAll(tools);
  for (const tool of SEED_DATA.tools) {
    await tools.put(tool.id, {
      id: tool.id,
      name: tool.name,
      description: tool.description,
      category: tool.category,
      enabled: tool.enabled ?? true,
      active: tool.enabled ?? true,
      created_at: now,
      updated_at: now,
    }, { expectedVersion: 0 });
  }
  log.info(`[seed] ✅ ${SEED_DATA.tools.length} tools re-seeded en HiveDB`);

  await deleteAll(skills);
  const skillLoader = new SkillLoader({
    workspacePath: process.env.HIVE_HOME || process.cwd(),
    skills: {
      extraDirs: [
        ...getClaudeSkillsDirs(),
        ...(process.env.HIVE_SKILL_DIRS?.split(path.delimiter).filter(Boolean) ?? []),
      ],
    },
  });

  const realSkills = skillLoader.loadAllSkills();
  for (const skill of realSkills) {
    const version = typeof skill.version === "string" ? skill.version : String(skill.version || "0.0.1");
    await skills.put(skill.name, {
      id: skill.name,
      name: skill.name,
      description: skill.description || "",
      version,
      author: skill.author || "Anonymous",
      icon: skill.icon || "skill",
      category: skill.category || "general",
      permissions: JSON.stringify(skill.permissions || []),
      dependencies: JSON.stringify(skill.dependencies || []),
      tools: (skill.tools || []).join(","),
      triggers: (skill.triggers || []).join(","),
      preferred_agents: JSON.stringify(skill.preferred_agents || []),
      body: skill.content || "",
      version_num: parseVersionMajor(version),
      active: true,
      created_at: now,
      updated_at: now,
    }, { expectedVersion: 0 });
  }
  log.info(`[seed] ✅ ${realSkills.length} skills re-seeded en HiveDB`);
}

export async function seedAllData(force = false): Promise<void> {
  log.info("🌱 Iniciando seed de datos base en HiveDB...");

  try {
    await reseedToolsAndSkills();

    const now = Date.now();
    const globalUserId = toIndexable(null);

    const ethics = await col<EthicsDoc>("ethics");
    for (const item of SEED_DATA.ethics) {
      await putIfAbsent(ethics, item.id, {
        id: item.id,
        name: item.name,
        description: item.description,
        content: item.content,
        is_default: item.isDefault,
        enabled: true,
        active: item.isDefault,
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.ethics.length} ethics templates procesados`);

    const providers = await col<ProviderDoc>("providers");
    for (const provider of SEED_DATA.providers) {
      const existing = await providers.get(provider.id);
      const baseUrl = provider.baseUrl ?? null;
      const doc: ProviderDoc = {
        id: provider.id,
        name: provider.name,
        base_url: baseUrl,
        category: (provider.category || existing?.doc.category || "llm") as ProviderDoc["category"],
        num_ctx: existing?.doc.num_ctx ?? null,
        num_gpu: existing?.doc.num_gpu ?? -1,
        enabled: force ? true : existing?.doc.enabled ?? true,
        active: force ? false : existing?.doc.active ?? false,
        is_free_tier: existing?.doc.is_free_tier ?? false,
        created_at: existing?.doc.created_at ?? now,
      };
      await putDoc(providers, provider.id, doc);
    }
    log.info(`[seed] ✅ ${SEED_DATA.providers.length} providers procesados`);

    const models = await col<ModelDoc>("models");
    const seedModelIds = new Set(SEED_DATA.models.map((model) => model.id));
    const existingModels = await models.scan();
    for (const entry of existingModels) {
      if (!seedModelIds.has(entry.id)) await models.delete(entry.id);
    }

    for (const model of SEED_DATA.models) {
      const existing = await models.get(model.id);
      await putDoc(models, model.id, {
        id: model.id,
        provider_id: model.providerId,
        name: model.name,
        model_type: model.modelType as ModelDoc["model_type"],
        // HiveDB is authoritative for mutable model settings. Seed values are
        // defaults for new records, not a reset on every application start.
        context_window: existing?.doc.context_window ?? model.contextWindow ?? 20000,
        capabilities: model.capabilities ?? null,
        enabled: force ? true : existing?.doc.enabled ?? true,
        active: force ? false : existing?.doc.active ?? false,
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.models.length} models procesados`);

    const agents = await col<AgentDoc>("agents");
    for (const agent of await agents.scan()) {
      if (!seedModelIds.has(agent.doc.model_id)) {
        const isHiveAgents = agent.doc.provider_id === "hiveagents";
        await putDoc(agents, agent.id, {
          ...agent.doc,
          model_id: isHiveAgents ? HIVEAGENTS_MODEL_ID : toIndexable(null),
          provider_id: isHiveAgents ? "hiveagents" : toIndexable(null),
          updated_at: now,
        });
      }
    }

    const mcpServers = await col<McpServerDoc>("mcpServers");
    for (const server of SEED_DATA.mcpServers) {
      await putIfAbsent(mcpServers, server.id, {
        id: server.id,
        name: server.name,
        transport: server.transport,
        command: server.command ?? null,
        args: JSON.stringify(server.args || []),
        url: (server as any).url ?? null,
        enabled: true,
        active: false,
        builtin: server.builtin,
        status: "disconnected",
        tools_count: 0,
        user_id: globalUserId,
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.mcpServers.length} MCP servers procesados`);

    const channels = await col<ChannelDoc>("channels");
    for (const channel of SEED_DATA.channels) {
      await putIfAbsent(channels, channel.id, {
        id: channel.id,
        user_id: globalUserId,
        type: channel.type,
        enabled: true,
        active: false,
        status: "disconnected",
        last_active: null,
        voice_enabled: false,
        tts_enabled: false,
        stt_provider: null,
        tts_provider: null,
        tts_voice_id: null,
        step_delivery_mode: "new_messages",
        vision_enabled: false,
        ocr_provider: null,
        vision_provider: null,
        vision_model_id: null,
      });
    }
    const webchat = await channels.get("webchat");
    if (webchat) {
      await putDoc(channels, "webchat", {
        ...webchat.doc,
        enabled: true,
        active: true,
        status: "connected",
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.channels.length} channels procesados`);

    const codeBridge = await col<CodeBridgeDoc>("codeBridge");
    for (const bridge of SEED_DATA.codeBridge) {
      await putIfAbsent(codeBridge, bridge.id, {
        id: bridge.id,
        user_id: globalUserId,
        name: bridge.name,
        cli_command: bridge.cliCommand,
        enabled: false,
        active: false,
        port: bridge.port,
        config: null,
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.codeBridge.length} Code Bridge CLIs procesados`);

    const codeBridgeConfig = await col<CodeBridgeConfigDoc>("codeBridgeConfig");
    for (const config of SEED_DATA.codeBridgeConfig) {
      await putIfAbsent(codeBridgeConfig, config.id, {
        id: config.id,
        user_id: globalUserId,
        key: config.key,
        value: config.value,
      });
    }
    log.info(`[seed] ✅ ${SEED_DATA.codeBridgeConfig.length} Code Bridge Config entries procesados`);

    const playbook = await col<PlaybookDoc>("playbook");
    for (let index = 0; index < INITIAL_PLAYBOOK_RULES.length; index++) {
      const rule = INITIAL_PLAYBOOK_RULES[index]!;
      const id = `seed-${String(index + 1).padStart(3, "0")}`;
      const existing = await playbook.get(id);
      await putDoc(playbook, id, {
        id,
        rule: rule.rule,
        category: rule.category,
        applicable_to: rule.applicable_to,
        helpful_count: existing?.doc.helpful_count ?? 1,
        harmful_count: existing?.doc.harmful_count ?? 0,
        source_reflection_id: existing?.doc.source_reflection_id ?? toIndexable(null),
        active: true,
        created_at: existing?.doc.created_at ?? now,
        updated_at: now,
      });
    }
    log.info(`[seed] ✅ ${INITIAL_PLAYBOOK_RULES.length} ACE playbook rules seeded`);

    log.info("[seed] ✨ Seed HiveDB completado exitosamente.");
  } catch (err) {
    log.error("[seed] ❌ Error durante el seed HiveDB:", (err as Error).message);
    throw err;
  }
}

export async function seedToolsAndSkills(): Promise<void> {
  await reseedToolsAndSkills();
}

type ActivatableCollection = "providers" | "models" | "tools" | "skills" | "mcpServers" | "channels" | "integrations" | "codeBridge";

export async function activateElement(
  collectionName: ActivatableCollection,
  elementId: string
): Promise<void> {
  const collection = await col<Record<string, any>>(collectionName);
  const existing = await collection.get(elementId);
  if (!existing) throw new Error(`${collectionName}/${elementId} not found`);

  await collection.put(elementId, {
    ...existing.doc,
    active: true,
    enabled: true,
  }, { expectedVersion: existing.version });
  log.info(`[seed] ✅ Activado ${elementId} en ${collectionName}`);
}

export async function deactivateElement(
  collectionName: ActivatableCollection,
  elementId: string
): Promise<void> {
  const collection = await col<Record<string, any>>(collectionName);
  const existing = await collection.get(elementId);
  if (!existing) throw new Error(`${collectionName}/${elementId} not found`);

  await collection.put(elementId, {
    ...existing.doc,
    active: false,
    enabled: false,
  }, { expectedVersion: existing.version });
  log.warn(`[seed] ⚠️  Desactivado ${elementId} en ${collectionName}`);
}

// ─── Providers y modelos que se agregan en versiones posteriores al seed inicial ──
const PATCH_PROVIDERS: SeedData["providers"] = [
  { id: "codex",       name: "OpenAI Codex",  baseUrl: "https://api.openai.com/v1",          category: "llm" },
  { id: "opencode-go", name: "OpenCode Go",   baseUrl: "https://opencode.ai/zen/go/v1",      category: "llm" },
  { id: "minimax",     name: "MiniMax",       baseUrl: "https://api.minimaxi.com/v1",        category: "llm" },
]

const PATCH_MODELS: SeedData["models"] = [
  // Codex
  { id: "codex-mini-latest",          providerId: "codex",       name: "Codex Mini (latest)",   modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat","code","function_calling","streaming","reasoning"]) },
  { id: "o3",                          providerId: "codex",       name: "O3",                    modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat","code","reasoning","streaming"]) },
  { id: "o4-mini-codex",              providerId: "codex",       name: "O4 Mini (Codex)",       modelType: "llm", contextWindow: 200000, capabilities: JSON.stringify(["chat","code","reasoning","streaming"]) },
  // OpenCode Go — OpenAI-compatible
  { id: "opencode-go/minimax-m3",           providerId: "opencode-go", name: "MiniMax M3",          modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","vision","function_calling","streaming","reasoning"]) },
  { id: "opencode-go/minimax-m2.7",         providerId: "opencode-go", name: "MiniMax M2.7",        modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/minimax-m2.5",         providerId: "opencode-go", name: "MiniMax M2.5",        modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/kimi-k2.6",         providerId: "opencode-go", name: "Kimi K2.6",         modelType: "llm", contextWindow: 262144,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/kimi-k2.5",         providerId: "opencode-go", name: "Kimi K2.5",         modelType: "llm", contextWindow: 262144,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/glm-5.1",           providerId: "opencode-go", name: "GLM-5.1",           modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/glm-5",             providerId: "opencode-go", name: "GLM-5",             modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/deepseek-v4-pro",   providerId: "opencode-go", name: "DeepSeek V4 Pro",   modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming","reasoning"]) },
  { id: "opencode-go/deepseek-v4-flash", providerId: "opencode-go", name: "DeepSeek V4 Flash", modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/mimo-v2-pro",       providerId: "opencode-go", name: "MiMo-V2 Pro",       modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming","reasoning"]) },
  { id: "opencode-go/mimo-v2-omni",      providerId: "opencode-go", name: "MiMo-V2 Omni",      modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/mimo-v2.5-pro",     providerId: "opencode-go", name: "MiMo-V2.5 Pro",     modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming","reasoning"]) },
  { id: "opencode-go/mimo-v2.5",         providerId: "opencode-go", name: "MiMo-V2.5",         modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "opencode-go/hy3-preview",       providerId: "opencode-go", name: "Hunyuan 3 Preview", modelType: "llm", contextWindow: 128000,  capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  // MiniMax — OpenAI-compatible (platform.minimaxi.com)
  { id: "MiniMax-M3",              providerId: "minimax", name: "MiniMax M3",              modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","vision","function_calling","streaming","reasoning"]) },
  { id: "MiniMax-M2.7",            providerId: "minimax", name: "MiniMax M2.7",            modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "MiniMax-M2.7-highspeed",  providerId: "minimax", name: "MiniMax M2.7 Highspeed",  modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "MiniMax-M2.5",            providerId: "minimax", name: "MiniMax M2.5",            modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
  { id: "MiniMax-M2.5-highspeed",  providerId: "minimax", name: "MiniMax M2.5 Highspeed",  modelType: "llm", contextWindow: 1000000, capabilities: JSON.stringify(["chat","code","function_calling","streaming"]) },
]

const PATCH_CODE_BRIDGE: SeedData["codeBridge"] = [
  { id: "codex-cli", name: "Codex CLI", cliCommand: "codex", port: 18795 },
]

/**
 * Inserta providers, modelos y code bridges nuevos en BDs ya existentes.
 * Usa INSERT OR IGNORE — nunca sobreescribe datos del usuario.
 * Se llama siempre al arrancar, independiente de si el seed ya corrió.
 */
export async function patchMissingData(): Promise<void> {
  let added = 0;
  const now = Date.now();
  const globalUserId = toIndexable(null);

  const providers = await col<ProviderDoc>("providers");
  for (const provider of PATCH_PROVIDERS) {
    const didAdd = await putIfAbsent(providers, provider.id, {
      id: provider.id,
      name: provider.name,
      base_url: provider.baseUrl ?? null,
      category: (provider.category ?? "llm") as ProviderDoc["category"],
      num_ctx: null,
      num_gpu: -1,
      enabled: false,
      active: false,
      is_free_tier: false,
      created_at: now,
    });
    if (didAdd) added++;
  }

  const models = await col<ModelDoc>("models");
  for (const model of PATCH_MODELS) {
    const didAdd = await putIfAbsent(models, model.id, {
      id: model.id,
      provider_id: model.providerId,
      name: model.name,
      model_type: model.modelType as ModelDoc["model_type"],
      context_window: model.contextWindow ?? 20000,
      capabilities: model.capabilities ?? null,
      enabled: true,
      active: false,
    });
    if (didAdd) added++;
  }

  const codeBridge = await col<CodeBridgeDoc>("codeBridge");
  for (const bridge of PATCH_CODE_BRIDGE) {
    const didAdd = await putIfAbsent(codeBridge, bridge.id, {
      id: bridge.id,
      user_id: globalUserId,
      name: bridge.name,
      cli_command: bridge.cliCommand,
      enabled: false,
      active: false,
      port: bridge.port,
      config: null,
    });
    if (didAdd) added++;
  }

  if (added > 0) log.info(`[patch] ✅ ${added} registros nuevos insertados en HiveDB existente`);
}

/**
 * Obtiene todos los elementos disponibles (activos e inactivos)
 */
export async function getAllElements<T extends Record<string, any>>(
  collectionName: string
): Promise<T[]> {
  const collection = await col<T>(collectionName);
  const results = await collection.scan();
  return results.map((entry) => entry.doc);
}

/**
 * Obtiene todos los elementos activos
 */
export async function getActiveElements<T extends Record<string, any>>(
  collectionName: string
): Promise<T[]> {
  const collection = await col<T>(collectionName);
  const results = await collection.scan();
  return results.map((entry) => entry.doc).filter((doc) => Boolean(doc.active));
}

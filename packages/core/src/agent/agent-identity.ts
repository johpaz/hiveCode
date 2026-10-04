/**
 * Identidad del enjambre — alias, rol interno y función, en un solo lugar.
 *
 * Este módulo **no** arma el roster: eso lo sigue haciendo
 * `describeSwarmCapabilities()` en `jev-planner.ts`, que lee `AgentDoc` y ya sabe
 * qué herramientas y qué MCP tiene cada agente de verdad. Aquí vive solo el
 * Mapping rol → nombre legible, que es dato de presentación y no de capacidad.
 *
 * Por qué no un roster paralelo: `AgentDoc` tiene cuatro campos de capacidad
 * (`tools_json` amplio, `tool_allowlist_json` estrecho, `skills_json`,
 * `mcp_server_ids_json`). Un segundo roster acabaría leyendo el campo distinto y
 * la TUI mostraría herramientas que el agente no tiene. Un solo roster, una sola
 * lectura.
 *
 * Los alias son de fauna latinoamericana y el proyecto es 100 % en español: lo
 * que el usuario lee es "Topo · Backend", no "BackendEngineer".
 */

/** Rol interno → identidad visible. */
export interface AgentIdentity {
  /** Alias: lo que el ojo lee. */
  alias: string
  /** Función en una línea, sin jerga. */
  funcion: string
  /**
   * Nivel en la jerarquía, 0 = comandante. Es el mismo 0-5 que el `AgentTier` de
   * la TUI, para que el grafo de ambos lados hable el mismo idioma.
   */
  nivel: 0 | 1 | 2 | 3 | 4 | 5
}

/**
 * Tabla canónica. La clave es el **rol interno**, que es lo que viaja por el
 * bus, lo que usa la bitmask de sesión y lo que aparece en los logs.
 */
const IDENTIDADES: Record<string, AgentIdentity> = {
  bee:            { alias: "Abeja Reina", funcion: "Comandante. Pregunta lo que falta, arma el plan y reparte el trabajo.", nivel: 0 },
  product_manager:{ alias: "Ocelote",     funcion: "Producto. Traduce tu idea difusa en requisitos verificables.",        nivel: 1 },
  architecture:   { alias: "Cóndor",      funcion: "Arquitecto. Diseña: ADRs, contratos de API, orden de las fases.",     nivel: 1 },
  backend:        { alias: "Topo",        funcion: "Backend. Excava la infraestructura: servicios, endpoints, esquemas.", nivel: 2 },
  frontend:       { alias: "Quetzal",     funcion: "Frontend. Construye la interfaz y la verifica en navegador real.",  nivel: 2 },
  data_scientist: { alias: "Tecolote",    funcion: "Datos. Analiza, entrena modelos, escribe pipelines.",                 nivel: 2 },
  security:       { alias: "Jaguar",      funcion: "Seguridad. Audita lo escrito; un CRITICAL detiene el enjambre.",       nivel: 3 },
  test:           { alias: "Chapulín",    funcion: "Pruebas. Escribe y repara tests hasta que pasan.",                  nivel: 3 },
  devops:         { alias: "Águila",      funcion: "Entrega. Empaqueta, despliega, abre el PR.",                          nivel: 3 },
  // Capa 4 fusiona `verifier` y `reviewer` en un solo rol de calidad.
  quality:        { alias: "Puma",        funcion: "Calidad. Reproduce los criterios y revisa el código. Nunca escribe.", nivel: 4 },
  forensic:       { alias: "Zorro",       funcion: "Perito. Responde «por qué falló» y recomienda relanzar o escalar.",    nivel: 5 },
  librarian:      { alias: "Armadillo",   funcion: "Cronista. Destila la sesión en memoria persistente.",                 nivel: 5 },

  // On-demand: se activan cuando hacen falta, no viven en el pool.
  spider:         { alias: "Araña",       funcion: "Automatización web — 37 herramientas de navegador.",                   nivel: 5 },
  scout:          { alias: "Halcón",      funcion: "Reconocimiento rápido: lee y resume sin tocar nada.",                 nivel: 5 },
}

/** Alias de un rol conocido, o el propio rol en Title Case si no está en la tabla. */
export function agentAlias(role: string): string {
  return IDENTIDADES[role]?.alias ?? titleCase(role)
}

/** Función de un rol conocido, o `""` si no hay descripción. */
export function agentFunction(role: string): string {
  return IDENTIDADES[role]?.funcion ?? ""
}

/** Nivel jerárquico. Un rol desconocido cae en 5 (on-demand) para no fingir que es central. */
export function agentTierLevel(role: string): 0 | 1 | 2 | 3 | 4 | 5 {
  return IDENTIDADES[role]?.nivel ?? 5
}

/** ¿Este rol tiene identidad descrita en la tabla? */
export function isKnownRole(role: string): boolean {
  return Object.hasOwn(IDENTIDADES, role)
}

/**
 * Alias para un subagente temporal.
 *
 * Los subagentes (`spawn_agent`, `registerSubAgent`) no tienen rol fijo: se
 * crean y se caen. "Hormiga-01", "Hormiga-02" comunica cantidad en vuelo sin
 * prometer que Hormiga-03 signifique algo distinto de Hormiga-01.
 */
export function subagentAlias(sequence: number): string {
  return `Hormiga-${String(sequence).padStart(2, "0")}`
}

/** Roles donde el color es por alias y no por rol (los efímeros). */
export function isEphemeralRole(role: string): boolean {
  return role.startsWith("subagent") || role.startsWith("hormiga") || role.startsWith("spawn:")
}

function titleCase(s: string): string {
  return s
    .replace(/[_-]+/g, " ")
    .split(" ")
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ")
}
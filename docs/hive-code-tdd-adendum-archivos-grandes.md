# Hive-Code — TDD Adendum
## Sección 39: Estrategia de Lectura de Archivos Grandes en el System Prompt de Bee
**Versión:** 1.0.0 | **Fecha:** Mayo 2026 | **Autor:** @johpaz
**Complementa:** Sección 29 del TDD continuación + Sección 4 del TDD principal

---

## 39. LECTURA DE ARCHIVOS GRANDES — INSTRUCCIÓN EXPLÍCITA EN BEE

### 39.1 El problema real

Hive-Code tiene `parse_ast`, `search_in_files`, y `read_file` con `offset`/`limit`. Las tools existen. El problema es que **sin instrucción explícita en el system prompt, el LLM tiende a pedir el archivo completo** porque es la estrategia más segura desde su perspectiva — menos riesgo de perder contexto relevante.

Un archivo de 3000 líneas leído completo consume ~2,500 tokens solo de contexto. Con el formato toon del Context Compiler se reduce, pero si Bee llama `read_file` directamente sobre el archivo completo sin pasar por el mapa AST primero, el ahorro desaparece.

La solución no es solo tener las tools — es que el system prompt de Bee le diga **explícitamente cuándo y en qué orden usarlas**. Los LLMs siguen instrucciones explícitas con alta fidelidad cuando son concretas y tienen ejemplos.

---

### 39.2 El bloque que falta en el system prompt de Bee

Este bloque se agrega al system prompt de Bee en la sección de **LECTURA DE CÓDIGO**, después de las reglas de edición y antes de las reglas de narración:

```
═══════════════════════════════════════════════════════
LECTURA DE ARCHIVOS — PROTOCOLO OBLIGATORIO
═══════════════════════════════════════════════════════

NUNCA leas un archivo completo como primer paso.
SIEMPRE sigue este protocolo según el tamaño del archivo:

── ARCHIVOS PEQUEÑOS (< 100 líneas) ──────────────────
Puedes leer completo con read_file(path).
No necesitas parse_ast primero.

── ARCHIVOS MEDIANOS (100-500 líneas) ────────────────
1. parse_ast(path)
   → Obtén el mapa: funciones, clases, exports, imports
   → Identifica en qué función/clase está lo que buscas
2. read_file(path, offset=lineaRelevante-5, limit=60)
   → Lee solo el fragmento relevante con contexto

── ARCHIVOS GRANDES (> 500 líneas) ───────────────────
Este es el protocolo que DEBES seguir sin excepción:

PASO 1 — Mapa estructural (nunca omitir)
  parse_ast(path)
  → Te da: qué funciones hay, en qué líneas están,
    qué exporta, qué importa, complejidad por función
  → Costo: 0 tokens de contexto — es análisis, no lectura

PASO 2 — Localizar con grep (antes de leer)
  search_in_files("nombreFuncion|nombreClase|lo-que-buscas", path)
  → Te da: línea exacta donde está lo que necesitas
  → Si no sabes exactamente qué buscar: busca los exports
    relevantes que encontraste en el PASO 1

PASO 3 — Leer solo el fragmento necesario
  read_file(path, offset=lineaEncontrada-10, limit=50)
  → 10 líneas antes para contexto
  → La función/bloque completo
  → Ajusta el limit según el tamaño de lo que vas a leer
  → Si la función tiene 80 líneas: limit=100

PASO 4 — Expandir solo si es necesario
  Si después de leer el fragmento necesitas más contexto:
  lee el fragmento adyacente, no el archivo completo.
  read_file(path, offset=lineaAnterior, limit=30)

EJEMPLO CORRECTO para modificar la función verifyToken en jwt.ts:

  parse_ast("src/auth/jwt.ts")
  → resultado: { functions: [{ name: "verifyToken", line: 47, lines: 23 }] }

  read_file("src/auth/jwt.ts", offset=42, limit=35)
  → lees líneas 42-77 (5 de contexto antes + 23 de la función + 7 de margen)

EJEMPLO INCORRECTO (nunca hacer esto):

  read_file("src/auth/jwt.ts")
  → lees 3000 líneas innecesariamente
  → consume ~2,500 tokens de contexto sin necesidad
  → PROHIBIDO para archivos > 500 líneas

── PARA ENTENDER EL IMPACTO DE UN CAMBIO ────────────
Antes de modificar cualquier archivo:

  find_imports(path)
  → ¿Quién importa este archivo?
  → Para cada dependiente: parse_ast() rápido
  → ¿Usan el símbolo que voy a cambiar?
  → Incluye esos archivos en el scope del arnés

No esperes a que un test falle para descubrir
que un archivo dependiente necesitaba actualización.

── REGLA DE ORO ──────────────────────────────────────
Si no sabes en qué línea está lo que buscas:
  → GREP primero, LEER después.
Si sabes la línea exacta:
  → LEER con offset y limit, nunca el archivo completo.
Si necesitas entender la estructura general:
  → AST primero, leer solo lo relevante después.
═══════════════════════════════════════════════════════
```

---

### 39.3 El mismo protocolo para los subagentes

Cuando Bee crea un subagente dinámico que va a trabajar con código, el `systemPrompt` que le pasa debe incluir este mismo bloque. No es responsabilidad del subagente inventar la estrategia — Bee se la entrega en el mandato.

En la función `spawn_agent`, el Context Compiler agrega automáticamente el bloque de lectura si entre las tools disponibles del subagente están `read_file`, `parse_ast`, o `search_in_files`:

```typescript
function buildSubagentSystemPrompt(
  purpose: string,
  basePrompt: string,
  tools: ToolName[]
): string {

  const needsReadingProtocol = tools.some(t =>
    ['read_file', 'parse_ast', 'search_in_files'].includes(t)
  );

  if (needsReadingProtocol) {
    return basePrompt + '\n\n' + FILE_READING_PROTOCOL_BLOCK;
  }

  return basePrompt;
}
```

Donde `FILE_READING_PROTOCOL_BLOCK` es exactamente el bloque de la sección 39.2.

---

### 39.4 El umbral de 500 líneas — cómo se determina

El `parse_ast` ya retorna el número de líneas del archivo. El protocolo se dispara automáticamente:

```typescript
interface ParseAstResult {
  path: string
  totalLines: number        // ← aquí está el umbral
  imports: Import[]
  exports: Export[]
  functions: FunctionInfo[] // { name, startLine, endLine, complexity }
  classes: ClassInfo[]
  complexity: number
}

// En el agent loop — cuando Bee llama read_file directamente
// sin parse_ast previo, el main thread verifica el tamaño
async function handleReadFileTool(
  input: FileReadInput
): Promise<FileReadOutput> {

  const stat = await Bun.file(input.file_path).stat();
  const estimatedLines = Math.floor(stat.size / 40); // ~40 bytes por línea promedio

  // Si el archivo es grande y Bee no especificó offset/limit
  // → devolver advertencia + mapa AST en vez del contenido completo
  if (estimatedLines > 500 && !input.offset && !input.limit) {
    const ast = await parseAst(input.file_path);
    return {
      content: null,
      warning: `Archivo grande (${ast.totalLines} líneas). ` +
               `Usa parse_ast + search_in_files primero. ` +
               `Mapa estructural incluido a continuación.`,
      structuralMap: formatAstAsContext(ast),
    };
  }

  // Archivo pequeño o con offset/limit especificado → leer normalmente
  return await readFileRange(input);
}
```

Esto significa que aunque Bee intente leer un archivo grande completo, el sistema lo intercepta y le da el mapa AST en cambio — forzando el protocolo correcto.

---

### 39.5 Formato del mapa AST en el contexto

Cuando `parse_ast` retorna el mapa, el Context Compiler lo formatea en una representación comprimida que Bee puede leer eficientemente:

```
[MAPA: src/auth/jwt.ts — 847 líneas]

IMPORTS:
  jose          → SignJWT, jwtVerify, decodeJwt (línea 1)
  ../config     → JWT_SECRET, JWT_EXPIRES_IN (línea 2)
  ./types       → TokenPayload, RefreshTokenPayload (línea 3)

EXPORTS:
  signToken(payload: TokenPayload): Promise<string>        línea 12
  verifyToken(token: string): Promise<TokenPayload>        línea 34
  refreshToken(token: string): Promise<RotatedToken>       línea 67  ← PENDIENTE según narrativo
  decodeWithoutVerify(token: string): TokenPayload | null  línea 102

DEPENDIENTES (find_imports):
  src/middleware.ts    → usa verifyToken
  src/routes/auth.ts  → usa signToken, refreshToken
  tests/auth.test.ts  → usa todos

COMPLEJIDAD:
  refreshToken: 12  ← alta — revisar antes de modificar
  verifyToken:   6  ← media
  signToken:     3  ← baja

Para leer una función específica:
  read_file("src/auth/jwt.ts", offset=67, limit=45)  ← refreshToken completa
  read_file("src/auth/jwt.ts", offset=34, limit=35)  ← verifyToken completa
```

Con este mapa, Bee sabe exactamente qué `read_file` hacer sin adivinar ni leer de más.

---

### 39.6 Métricas de validación

El ACE Reflector mide la eficiencia de lectura de archivos como parte de sus trazas. Si Bee consistentemente lee archivos completos cuando podría usar el protocolo, el ACE genera una regla en el playbook:

```
Regla detectada: "Bee tiende a leer archivos completos para archivos > 500 líneas.
Recordar el protocolo: parse_ast → search → read_file(offset, limit)"
```

Esta regla se inyecta en el Context Compiler para las siguientes sesiones.

Los criterios de aceptación específicos:

- [ ] Un archivo de > 500 líneas sin `offset`/`limit` en `read_file` retorna el mapa AST, no el contenido
- [ ] El system prompt de Bee incluye el bloque `FILE_READING_PROTOCOL_BLOCK`
- [ ] Los subagentes con tools de lectura reciben el mismo bloque en su mandato
- [ ] El Context Compiler formatea el resultado de `parse_ast` como mapa comprimido legible
- [ ] El ACE detecta y registra cuando Bee no sigue el protocolo de lectura

---

*Hive-Code TDD — Adendum · Sección 39: Lectura de Archivos Grandes*
*@johpaz · Mayo 2026*
*"Las tools sin instrucciones son herramientas sin manual. El manual va en el prompt."*

# Benchmark de compactación

¿Cuánto de lo importante sobrevive a varias compactaciones seguidas? Compara tres variantes sobre
conversaciones largas y reproducibles con datos plantados (hechos exactos, una preferencia, una decisión,
enfoques que ya fallaron y un paso pendiente), entre relleno con valores señuelo.

| Variante | Qué es |
|---|---|
| `legacy` | El comportamiento anterior de `compaction.ts`: resumen de 3–5 oraciones, últimos 30 mensajes de todo el historial, sin ver el resumen previo. |
| `legacy-incremental` | El mismo prompt, pero incorporando el resumen anterior y solo lo nuevo. Aísla cuánto del cambio viene de la corrección incremental. |
| `recall-paraphrase` | **Sin modelo**, con la pregunta parafraseada: casi sin palabras en común con la frase plantada. Es la cota pesimista de `recall`. Con `HIVE_EMBEDDER=local` (y `HIVEDB_OFFLINE=1` si los pesos ya están en caché) mide cuánto ayudan los embeddings. |
| `recall` | **Sin modelo.** Los mensajes se guardan como en el uso real (se indexan al guardarse) y, para cada dato, se busca con la pregunta y se miran los 3 mensajes que trae el índice. Cero llamadas. |
| `handoff` | El actual: traspaso de seis campos (`handoff.ts`), límites nuevos e incremental. |

`legacy` y `legacy-incremental` reconstruyen código que ya no existe, así que su prompt vive en
`variants.ts`, copiado del original. `handoff` usa las funciones y los límites reales
(`COMPACTION_LIMITS`), así que el benchmark mide lo que el código hace de verdad.

> **Cota optimista de `recall`.** La consulta es la pregunta que se hizo con el dato delante, y comparte la mayoría de sus palabras con la frase plantada; en el uso real la consulta es lo que dice la persona, a menudo con otras palabras. Un 100 % aquí dice que el índice encuentra el dato cuando se le pregunta bien, no que el modelo preguntará bien. Las paráfrasis (sin palabras en común) las mide `recall-paraphrase`: 0 % solo con BM25 y 15 % con el embedder local (`HIVE_EMBEDDER=local`, opt-in).

## Qué mide — y qué no

- **Retención:** si el dato plantado aparece, literal, en el texto que verá la siguiente instancia.
  Determinista, sin juez.
- **Preguntas (`--probe`):** una llamada más por variante, en la que un modelo con SOLO el resumen delante
  responde una pregunta por dato. Comprueba que el resumen es *utilizable*, no solo que contiene el texto.
- Solo cuentan los datos que ya habían pasado por la compactación; los de la cola viva no.
- **No mide** si una tarea se resolvería, ni la ayuda de `conversation_read` (que recupera lo que el
  resumen perdió). Eso pide una evaluación de extremo a extremo (SWE-bench, Terminal-Bench…).

## Uso

Lo corre `hivecode`, con su propio código de compactación y su propia configuración de proveedores: la clave
sale de su almacén de secretos (`Bun.secrets`) y nunca se imprime ni se escribe. Usa `~/.hivecode`; cambia
`HIVE_HOME` para apuntar a otro directorio.

```bash
# Validar la tubería, sin red ni gasto. Los números NO significan nada (el modelo falso copia líneas).
bun run bench:compaction -- --fake

# Corrida real con el proveedor tal como está configurado en hivecode.
bun run bench:compaction -- --provider gemini --model gemini-3.8-flash --probe --out resultados.json
```

Opciones: `--seeds 3` (cuántos escenarios, o una lista `1,2,3`) · `--segments 4` · `--per-segment 30` ·
`--probe` · `--out archivo.json`.

Con los valores por defecto son unas 45 llamadas (3 escenarios × 3 variantes × 4 compactaciones, más 9 de
preguntas). Repite con varios modelos, y con uno local pequeño en particular: ahí es donde el JSON del
traspaso puede fallar más, y los fallos aparecen en la columna `fallos`.

## Leer los resultados

- Si `handoff` no supera a `legacy-incremental`, el beneficio viene de la corrección incremental y no del
  prompt de seis campos.
- Mira *Por antigüedad*: el tramo 0 es el que más compactaciones sufrió.
- Mira los `fallos` y los tokens del resumen: un traspaso más largo gasta parte del ahorro de contexto.

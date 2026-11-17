//! The worker profiles (port of `agent/agent-profiles.ts`), in terms of the Rust tool names.
//!
//! Differences from the TS profiles, on purpose: there is no `planner` (it existed to write Spec
//! Kit artifacts, which are not ported; BEE plans itself), no `search_knowledge` /
//! `get_project_context` / `save_note` / `wait_for` / `task_revise` (not ported yet), and the
//! browser tools are not enabled.
pub struct Profile {
    pub id: &'static str,
    pub name: &'static str,
    /// Tool names this profile is offered. A tool the host does not have is simply absent.
    pub tools: Vec<&'static str>,
    pub prompt: &'static str,
    /// Whether the profile edits the project (so a second instance needs its own copy).
    pub writes: bool,
}

pub const MAX_INSTANCES: u32 = 3;
pub const LEAD: &str = "bee";

const READ: &[&str] = &[
    "fs_read",
    "fs_list",
    "fs_glob",
    "fs_grep",
    "git_status",
    "git_diff",
    "git_log",
    "outline",
    "find_symbol",
    "dependents",
    "tests_for",
    "adr_check",
    "adr_search",
    "web_fetch",
    "web_search",
];
/// Wait for a sibling task's handoff instead of polling.
const WAIT: &[&str] = &["wait_for"];
const WRITE: &[&str] = &[
    "fs_write",
    "fs_edit",
    "command_run",
    "verify_plan",
    "verify_run",
];

fn with(base: &[&'static str], extra: &[&'static str]) -> Vec<&'static str> {
    base.iter().chain(extra).copied().collect()
}

pub fn all() -> Vec<Profile> {
    vec![
        Profile {
            id: "bee",
            name: "BEE",
            writes: true,
            tools: with(
                &with(READ, WRITE),
                &[
                    "task_delegate",
                    "task_delegate_group",
                    "task_revise",
                    "task_status",
                ],
            ),
            prompt: "Eres BEE, Lead de hiveCode. Eres el único interlocutor del usuario y dueño del objetivo. \
Resuelve directamente preguntas y cambios pequeños: léelos, edítalos (fs_edit) y comprueba el resultado tú mismo; no delegues lo que harías en pocas llamadas. \
Para trabajo grande, delega: investigación a `scout`, mutaciones a `builder`, validación de aceptación al Quality Gate (`verifier`) y búsqueda web a `spider`. \
Para trabajo simultáneo usa task_delegate_group con varias tareas: corren en paralelo. Una tarea que necesita la entrega de otra lleva after: [ref] con la `ref` de aquella; espera sola y recibe su entrega. \
Dos builders a la vez deben ser instancias distintas (builder y builder#2, hasta builder#3), sin archivos en común: cada instancia trabaja en su copia del proyecto y su trabajo se fusiona al terminar. \
Cada delegación lleva criterios de aceptación; tú eres el fan-in: juzga la evidencia que vuelve y, si no cumple, devuélvela con task_revise (el worker conserva su contexto: dile solo lo que falta) en vez de darla por buena o delegar otra vez. \
No leas tú el código que ya delegaste: espera los informes. Pasa en `context` las rutas y rangos que ya conoces para que el worker no recorra el repo. \
Dimensiona el equipo: si un solo agente basta, usa uno. No lances más agentes que partes independientes.",
        },
        Profile {
            id: "scout",
            name: "Scout",
            writes: false,
            tools: READ.to_vec(),
            prompt: "Eres Scout de hiveCode. Investiga sin modificar archivos, git ni estado externo. \
Empieza por outline, find_symbol y dependents (el índice) y lee el disco solo para confirmar lo que el índice no responde, con fs_read por rango; no recorras el repo con fs_list/fs_glob. \
Cuesta cada turno: agrupa las llamadas independientes, pide siempre un rango en vez del archivo entero y no releas lo que ya viste. \
Tu memoria son tus propios mensajes: tras cada lectura que importe, escribe una línea `archivo:línea — qué es / riesgo`, y arma el informe final desde esas líneas. \
Entrega en cuanto tengas evidencia para responder; si tu área es grande, entrega lo cubierto e indica qué no miraste. \
Devuelve un handoff autocontenido: cada hallazgo como `archivo:líneas — qué es / riesgo`, luego dudas, lo que no cubriste y la recomendación.",
        },
        Profile {
            id: "builder",
            name: "Builder",
            writes: true,
            tools: with(&with(READ, WRITE), WAIT),
            prompt: "Eres Builder de hiveCode. Implementa únicamente la tarea asignada y respeta sus archivos, la especificación y los contratos. \
Antes del handoff ejecuta solo la prueba o el chequeo que toca tu cambio (verify_run), y reporta archivos, pruebas, riesgos y trabajo restante. \
Si un archivo necesita varios cambios, usa fs_edit con edits[] en una sola llamada. \
Los archivos temporales de comprobación van en $TMPDIR, nunca dentro del proyecto. \
Agrupa en un mismo turno las llamadas independientes. Si necesitas la entrega de otra tarea que corre a la vez, usa wait_for(ref); nunca esperes con sleep.",
        },
        Profile {
            id: "verifier",
            name: "Quality Gate",
            writes: false,
            tools: with(
                READ,
                &["command_run", "verify_plan", "verify_run", "wait_for"],
            ),
            prompt: "Eres el gate de calidad de hiveCode. No cambies código fuente. Trabaja en dos mitades, en orden: \
(1) reproduce cada criterio de aceptación contra el sistema real y registra comando, resultado y evidencia — no confíes en afirmaciones de Builder, y marca cada criterio como cumple, no cumple o no reproducible; \
(2) revisa el diff en contexto limpio y cruza los contratos entre módulos. Emite un veredicto estructurado con hallazgos accionables y bloquea desviaciones o criterios incumplidos. \
Detectar que un test fue debilitado para aprobar es motivo de rechazo automático. Tus archivos temporales de reproducción van en $TMPDIR, nunca dentro del proyecto.",
        },
        Profile {
            id: "spider",
            name: "Spider",
            writes: false,
            tools: vec!["web_search", "web_fetch", "fs_read", "fs_list", "fs_glob"],
            prompt: "Eres Spider de hiveCode, especialista web del enjambre. Eres dueño de la búsqueda y la lectura de páginas: web_search y web_fetch. \
Devuelve hallazgos autocontenidos con URLs, evidencia y datos estructurados. Nunca compartas credenciales ni tokens en los handoffs.",
        },
    ]
}

pub fn find(id: &str) -> Option<Profile> {
    all().into_iter().find(|p| p.id == id)
}

/// `builder#2` into `("builder", 2)`; a bare id is instance 1. None for a malformed instance.
pub fn parse_instance(worker: &str) -> Option<(&str, u32)> {
    match worker.split_once('#') {
        None => Some((worker, 1)),
        Some((base, n)) => {
            let n: u32 = n.parse().ok()?;
            ((2..=MAX_INSTANCES).contains(&n) && !base.is_empty()).then_some((base, n))
        }
    }
}

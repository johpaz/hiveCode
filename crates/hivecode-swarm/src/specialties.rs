//! Specialties (port of `agent/specialties.ts`): not more agents, but extra instructions for one
//! worker on one task. A builder asked for an endpoint gets the `backend` guidance; a verifier asked
//! about permissions gets `security`. They go in the task brief, so the worker's session (and its
//! tools) stay exactly the profile's.
use regex::Regex;
use std::sync::LazyLock;

#[derive(Debug)]
pub struct Specialty {
    pub id: &'static str,
    /// The profile that can take it.
    pub owner: &'static str,
    pub description: &'static str,
    pub instructions: &'static str,
    matcher: &'static str,
}

const TABLE: &[Specialty] = &[
    Specialty {
        id: "backend",
        owner: "builder",
        description: "Servicios, APIs y lógica de negocio",
        instructions: "Define contratos de entrada/salida, valida errores y prueba el servicio real. Modifica únicamente los archivos asignados.",
        matcher: r"(?i)backend|endpoint|api\b|servicio|service|autentic|auth",
    },
    Specialty {
        id: "frontend",
        owner: "builder",
        description: "Interfaces, interacción y accesibilidad",
        instructions: "Respeta contratos del backend; verifica estados de carga, error y accesibilidad. Para una TUI verifica tamaños, entrada y renderizado real.",
        matcher: r"(?i)frontend|interfaz|interface|react|pantalla|tui|accesibilidad",
    },
    Specialty {
        id: "data",
        owner: "builder",
        description: "Esquemas, consultas y persistencia",
        instructions: "Verifica compatibilidad de esquemas, idempotencia y consistencia. Prueba migraciones y consultas con fixtures; conserva la evidencia.",
        matcher: r"(?i)database|sql|datos|schema|esquema|persist|migraci|hivedb",
    },
    Specialty {
        id: "devops",
        owner: "builder",
        description: "CI, entorno y empaquetado",
        instructions: "Reproduce build y entorno; prepara entrega con comandos verificables. Mantén los límites de ejecución y permisos del responsable.",
        matcher: r"(?i)devops|docker|pipeline|deploy|desplieg|empaquet|\bci\b",
    },
    Specialty {
        id: "integration",
        owner: "builder",
        description: "Cambios pequeños e integración transversal",
        instructions: "Resuelve directamente cambios pequeños. Coordina contratos entre módulos y evita subdividir trabajo que comparte archivos.",
        matcher: r"(?i)integraci|integration|refactor",
    },
    Specialty {
        id: "repository",
        owner: "scout",
        description: "Investigación del repositorio",
        instructions: "Busca símbolos y dependencias antes de leer archivos completos. Entrega rangos y referencias frescas, con incógnitas explícitas.",
        matcher: ".",
    },
    Specialty {
        id: "security",
        owner: "verifier",
        description: "Auditoría independiente",
        instructions: "Audita permisos, secretos y límites de confianza; no modifiques código fuente. Entrega hallazgos reproducibles al responsable.",
        matcher: r"(?i)seguridad|security|vulnerab|owasp|permiso|secret",
    },
    Specialty {
        id: "acceptance",
        owner: "verifier",
        description: "Aceptación y pruebas reales",
        instructions: "Reproduce criterios de aceptación y registra comando, resultado y evidencia. Mantén un único veredicto.",
        matcher: ".",
    },
    Specialty {
        id: "web",
        owner: "spider",
        description: "Fuentes externas y APIs",
        instructions: "Investiga fuentes externas por pregunta concreta. Prefiere texto y referencias, y cita la URL de cada dato.",
        matcher: ".",
    },
];

fn matches(spec: &Specialty, task: &str) -> bool {
    static CACHE: LazyLock<std::sync::Mutex<std::collections::HashMap<&'static str, Regex>>> =
        LazyLock::new(Default::default);
    let mut cache = CACHE.lock().unwrap_or_else(|e| e.into_inner());
    cache
        .entry(spec.matcher)
        .or_insert_with(|| Regex::new(spec.matcher).expect("static pattern"))
        .is_match(task)
}

pub fn for_owner(owner: &str) -> Vec<&'static str> {
    TABLE
        .iter()
        .filter(|s| s.owner == owner)
        .map(|s| s.id)
        .collect()
}

/// The specialty for a task. A requested one (`security`, or `verifier/security`: models write both)
/// must belong to the profile; otherwise the first of the profile's whose pattern matches the task,
/// and for a builder with no match, `integration`. A profile without specialties gets none.
pub fn select(
    owner: &str,
    task: &str,
    requested: Option<&str>,
) -> Result<Option<&'static Specialty>, String> {
    if let Some(requested) = requested.map(str::trim).filter(|r| !r.is_empty()) {
        let id = requested.to_lowercase();
        let id = id.rsplit(['/', ':']).next().unwrap_or(&id).to_owned();
        return TABLE
            .iter()
            .find(|s| s.id == id && s.owner == owner)
            .map(Some)
            .ok_or_else(|| {
                let valid = for_owner(owner);
                format!(
                    "specialty `{requested}` is not available to {owner}. Valid specialties: {}",
                    if valid.is_empty() {
                        "none".to_owned()
                    } else {
                        valid.join(", ")
                    }
                )
            });
    }
    Ok(TABLE
        .iter()
        .find(|s| s.owner == owner && matches(s, task))
        .or_else(|| {
            TABLE
                .iter()
                .find(|s| s.owner == owner && s.id == "integration")
        }))
}

/// How the specialty reads in the task brief.
pub fn brief(spec: &Specialty) -> String {
    format!(
        "Especialidad `{}` — {}. {}",
        spec.id, spec.description, spec.instructions
    )
}

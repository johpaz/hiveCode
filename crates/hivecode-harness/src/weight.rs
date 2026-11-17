//! The weight of a change: how many areas it touches, how coupled it is and whether it fits one
//! worker (port of `harness/task-weight.ts`).
//!
//! The route is decided by what the change really costs, not by how the sentence is phrased: a long,
//! detailed statement is evidence that the task is bounded. `docs/rutas-por-costo.md` has the why.
use regex::Regex;
use std::{path::Path, sync::LazyLock};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier {
    Conversation,
    Scoped,
    Feature,
}
impl Tier {
    pub fn as_str(self) -> &'static str {
        match self {
            Tier::Conversation => "conversation",
            Tier::Scoped => "scoped",
            Tier::Feature => "feature",
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Statement {
    /// There is an order to change something (it is not a question).
    pub mutating: bool,
    /// Signals that alone justify splitting the work among workers.
    pub coupled: Vec<&'static str>,
    pub areas: Vec<&'static str>,
    /// Artifacts the statement enumerates (commands, endpoints, files, routes).
    pub deliverables: u32,
    /// Asks for something new from scratch: nothing to couple or break.
    pub greenfield: bool,
    /// Asks to read, audit or investigate without changing anything.
    pub reading: bool,
    /// Also asks for a plan (roadmap, proposed improvements).
    pub planning: bool,
}

const MUTATION: &[&str] = &[
    "implement",
    "implementa",
    "implementar",
    "fix",
    "corrige",
    "corregir",
    "arregla",
    "arreglar",
    "cambia",
    "cambiar",
    "change",
    "add",
    "agrega",
    "agregar",
    "añade",
    "añadir",
    "crea",
    "creas",
    "crear",
    "create",
    "remove",
    "elimina",
    "eliminar",
    "borra",
    "borrar",
    "delete",
    "quita",
    "quitar",
    "renombra",
    "renombrar",
    "rename",
    "mueve",
    "mover",
    "move",
    "modifica",
    "modificar",
    "edita",
    "editar",
    "escribe",
    "escribir",
    "write",
    "actualiza",
    "actualizar",
    "update",
    "reemplaza",
    "reemplazar",
    "replace",
    "refactor",
    "refactoriza",
    "refactorizar",
    "instala",
    "instalar",
    "install",
    "construye",
    "construir",
    "build",
    "desarrolla",
    "desarrollar",
    "develop",
    "scaffold",
    // Planning, migrating and designing are orders to change even before a file is touched.
    "planifica",
    "planificar",
    "plan",
    "diseña",
    "diseñar",
    "migra",
    "migrar",
    "migrate",
    "optimiza",
    "optimizar",
    "mejora",
    "mejorar",
    "documenta",
    "documentar",
    "estructura",
    "estructurar",
];
const READING: &[&str] = &[
    "audita",
    "auditar",
    "audit",
    "revisa",
    "revisar",
    "review",
    "inspecciona",
    "inspeccionar",
    "inspect",
    "investiga",
    "investigar",
    "investigate",
    "analiza",
    "analizar",
    "analyze",
    "analyse",
    "mapea",
    "mapear",
    "map",
    "explora",
    "explorar",
    "explore",
    "compara",
    "comparar",
    "compare",
    "diagnostica",
    "diagnosticar",
    "diagnose",
    "levanta",
    "relevamiento",
    "inventario",
    "evalúa",
    "evalua",
    "evaluar",
    "evaluate",
];
const PLANNING: &[&str] = &[
    "planea",
    "planear",
    "planeo",
    "planean",
    "planeemos",
    "planifica",
    "planificar",
    "planificame",
    "propon",
    "propón",
    "propone",
    "proponer",
    "roadmap",
    "hoja de ruta",
    "plan de mejora",
    "plan de mejoras",
    "plan de accion",
    "plan de acción",
];

/// «meejoras» and «planeea» read like «mejoras» and «planea»: repeated letters are collapsed.
fn collapse(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut last = None;
    for c in text.chars() {
        if Some(c) != last {
            out.push(c);
        }
        last = Some(c);
    }
    out
}

fn words(list: &[&str], collapsed: bool) -> Regex {
    let parts: Vec<String> = list
        .iter()
        .map(|w| {
            regex::escape(&if collapsed {
                collapse(w)
            } else {
                (*w).to_owned()
            })
        })
        .collect();
    Regex::new(&format!(r"\b(?:{})\b", parts.join("|"))).expect("static word list")
}

static MUTATION_RE: LazyLock<Regex> = LazyLock::new(|| words(MUTATION, false));
static READING_RE: LazyLock<Regex> = LazyLock::new(|| words(READING, false));
static PLANNING_RE: LazyLock<Regex> = LazyLock::new(|| words(PLANNING, true));

fn table(rows: &[(&'static str, &str)]) -> Vec<(&'static str, Regex)> {
    rows.iter()
        .map(|(n, p)| (*n, Regex::new(p).expect("static pattern")))
        .collect()
}
static COUPLED: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    table(&[
        ("arquitectura", r"\b(architecture|arquitectura)\b"),
        ("migración", r"\b(migration|migraci[oó]n|migrate|migrar)\b"),
        (
            "esquema de datos",
            r"\b(database schema|esquema de base de datos|schema change)\b",
        ),
        (
            "refactor amplio",
            r"\b(large refactor|refactor amplio|wide refactor)\b",
        ),
        (
            "funcionalidad nueva",
            r"\b(new feature|nueva funcionalidad|nuevo m[oó]dulo|new module)\b",
        ),
        (
            "varios módulos",
            r"\b(multi[- ]module|multi[- ]m[oó]dulo|cross[- ]cutting|cross[- ]m[oó]dulo)\b",
        ),
        (
            "cambio incompatible",
            r"\b(breaking change|cambio incompatible)\b",
        ),
        ("rediseño", r"\b(redesign|rediseñ[oa])\b"),
        (
            "autenticación",
            r"\b(authentication|autorizaci[oó]n|autenticaci[oó]n)\b",
        ),
        ("permisos", r"\b(permissions|permisos|roles y permisos)\b"),
    ])
});
static AREAS: LazyLock<Vec<(&'static str, Regex)>> = LazyLock::new(|| {
    table(&[
        ("api", r"\b(api|rest|endpoints?|server|servidor|backend)\b"),
        (
            "frontend",
            r"\b(frontend|front-end|interfaz|ui|html|css|p[aá]gina|web)",
        ),
        (
            "datos",
            r"\b(base de datos|databases?|persistencia|storage|sqlite|postgres|mongo)\b",
        ),
        (
            "infra",
            r"\b(deploy|despliegue|docker|ci/cd|github actions|kubernetes|terraform)\b",
        ),
        ("docs", r"\b(documentaci[oó]n|readme|docs\b|manual)"),
        (
            "tests",
            r"\b(suite de pruebas|tests? unitarios|e2e|end-to-end|playwright|cypress)\b",
        ),
    ])
});
static DELIVERABLES: LazyLock<Vec<Regex>> = LazyLock::new(|| {
    vec![
        Regex::new(r"\b(\d{1,2})\s+(comandos?|endpoints?|rutas?|ficheros?|archivos?|m[oó]dulos?|tablas?|pantallas?)\b").unwrap(),
        Regex::new(r"\b(\d{1,2})\s+(commands?|endpoints?|routes?|files?|modules?)\b").unwrap(),
    ]
});
static NUMBERED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^\s*\d{1,2}[.)]\s+").unwrap());
static GREENFIELD: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\b(crea(?:r|s)?\s+(?:un|una)\s+(proyecto|app|aplicaci[oó]n|sitio)|create\s+(?:a\s+)?(new\s+)?(project|app)|from scratch|en el directorio actual|in the current directory)\b").unwrap()
});

/// Reads the statement and separates the signals that matter. Pure: no I/O.
pub fn analyze(objective: &str) -> Statement {
    let text = objective.trim().to_lowercase();
    let mut deliverables = 0;
    for pattern in DELIVERABLES.iter() {
        for m in pattern.captures_iter(&text) {
            deliverables = deliverables.max(m[1].parse().unwrap_or(0));
        }
    }
    deliverables = deliverables.max(NUMBERED.find_iter(&text).count() as u32);
    Statement {
        mutating: MUTATION_RE.is_match(&text),
        reading: READING_RE.is_match(&text),
        planning: PLANNING_RE.is_match(&collapse(&text)),
        coupled: COUPLED
            .iter()
            .filter(|(_, re)| re.is_match(&text))
            .map(|(n, _)| *n)
            .collect(),
        areas: AREAS
            .iter()
            .filter(|(_, re)| re.is_match(&text))
            .map(|(n, _)| *n)
            .collect(),
        deliverables,
        greenfield: GREENFIELD.is_match(&text),
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProjectFacts {
    pub files: u32,
    /// First-level directories (each one is a module).
    pub modules: u32,
    pub has_tests: bool,
    pub has_typescript: bool,
    pub has_dependencies: bool,
    pub has_javascript: bool,
    pub has_package_json: bool,
    pub scripts: Vec<String>,
    pub package_manager: Option<&'static str>,
    pub ecosystems: Vec<String>,
}

const IGNORED: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    "target",
    ".next",
    "coverage",
    ".cache",
];
const LOCKFILES: &[(&str, &str)] = &[
    ("bun.lock", "bun"),
    ("bun.lockb", "bun"),
    ("pnpm-lock.yaml", "pnpm"),
    ("yarn.lock", "yarn"),
    ("package-lock.json", "npm"),
];
static JS_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\.[cm]?[jt]sx?$").unwrap());
static JS_TEST: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\.(test|spec)\.[cm]?[jt]sx?$").unwrap());

/// What the statement cannot know: how many files, how many modules, whether there are tests and
/// which scripts the project offers. Cheap: a bounded walk.
pub fn project_facts(workspace: &Path) -> ProjectFacts {
    let mut facts = ProjectFacts::default();
    if !workspace.is_dir() {
        return facts;
    }
    let mut js_tests = false;
    let mut stack = vec![workspace.to_path_buf()];
    let mut visited = 0;
    while let Some(dir) = stack.pop() {
        if visited >= 400 {
            break;
        }
        visited += 1;
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let name = entry.file_name().to_string_lossy().into_owned();
            if IGNORED.contains(&name.as_str()) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                if dir == workspace {
                    facts.modules += 1;
                }
                if matches!(name.as_str(), "tests" | "test" | "__tests__" | "spec") {
                    js_tests = true;
                }
                stack.push(entry.path());
            } else if kind.is_file() {
                facts.files += 1;
                if JS_TEST.is_match(&name) {
                    js_tests = true;
                }
                if JS_FILE.is_match(&name) && !name.ends_with(".d.ts") {
                    facts.has_javascript = true;
                }
                if name == "package.json" && dir == workspace {
                    facts.has_package_json = true;
                }
            }
        }
    }
    if let Ok(text) = std::fs::read_to_string(workspace.join("package.json"))
        && let Ok(pkg) = serde_json::from_str::<serde_json::Value>(&text)
    {
        facts.scripts = pkg["scripts"]
            .as_object()
            .map(|s| s.keys().cloned().collect())
            .unwrap_or_default();
        js_tests = js_tests || facts.scripts.iter().any(|s| s == "test");
        facts.has_package_json = true;
        facts.has_javascript = true;
    }
    facts.has_typescript =
        workspace.join("tsconfig.json").exists() || workspace.join("jsconfig.json").exists();
    facts.has_dependencies = workspace.join("node_modules").exists();
    facts.package_manager = LOCKFILES
        .iter()
        .find(|(f, _)| workspace.join(f).exists())
        .map(|(_, m)| *m);
    let (ecosystems, other_tests) = hivecode_verify::detect(workspace);
    facts.ecosystems = if facts.has_javascript {
        vec!["node".to_owned()]
    } else {
        vec![]
    };
    facts.ecosystems.extend(ecosystems);
    facts.has_tests = js_tests || other_tests;
    facts
}

/// What the agent needs to know about the project so it does not spend turns finding out.
pub fn describe_facts(facts: &ProjectFacts, checks: &[String], notes: &[String]) -> String {
    if facts.files == 0 && !facts.has_package_json {
        return String::new();
    }
    let mut lines = vec![
        "Proyecto (ya inspeccionado: no lo explores para averiguar esto):".to_owned(),
        format!(
            "- {} ficheros, {} directorios de primer nivel con código",
            facts.files, facts.modules
        ),
    ];
    if let Some(manager) = facts.package_manager {
        lines.push(format!("- gestor de paquetes: {manager}"));
    }
    if !facts.scripts.is_empty() {
        lines.push(format!(
            "- scripts de package.json: {}",
            facts.scripts.join(", ")
        ));
    }
    lines.push(format!(
        "- pruebas: {}",
        if facts.has_tests { "sí" } else { "no hay" }
    ));
    let others: Vec<&str> = facts
        .ecosystems
        .iter()
        .map(String::as_str)
        .filter(|e| *e != "node")
        .collect();
    if !others.is_empty() {
        lines.push(format!("- ecosistema: {}", others.join(", ")));
    }
    if checks.is_empty() {
        lines.push("- no hay nada que el harness pueda ejecutar solo al terminar (sin pruebas, tipos ni build): comprueba tu cambio tú".into());
    } else {
        lines.push(format!(
            "- al terminar, el harness ejecuta solo ({}): corre antes tú solo lo que toca tu cambio, no el proyecto entero",
            checks.join(", ")
        ));
    }
    lines.extend(notes.iter().map(|n| format!("- {n}")));
    lines.join("\n")
}

#[derive(Debug, Clone)]
pub struct Weight {
    pub tier: Tier,
    pub score: i32,
    pub signals: Vec<String>,
    pub statement: Statement,
    pub project: Option<ProjectFacts>,
}

/// The route. Order matters: intent first (is there something to change?), then coupling and
/// breadth, and project size last, as context.
pub fn decide(statement: &Statement, project: Option<&ProjectFacts>) -> (Tier, i32, Vec<String>) {
    if !statement.mutating {
        let mut signals = vec!["no hay orden de mutar".to_owned()];
        if statement.reading {
            signals.push("pide leer o auditar el código".into());
        }
        if statement.planning {
            signals.push("pide un plan como entrega".into());
        }
        return (Tier::Conversation, 0, signals);
    }
    let mut signals = vec!["hay una orden de mutar".to_owned()];
    let mut score = 0;
    for name in &statement.coupled {
        score += 35;
        signals.push(format!("acoplado: {name}"));
    }
    match statement.areas.len() {
        n if n >= 3 => {
            score += 30;
            signals.push(format!("toca {n} áreas: {}", statement.areas.join(", ")));
        }
        2 => {
            score += 10;
            signals.push(format!("toca 2 áreas: {}", statement.areas.join(", ")));
        }
        _ => {}
    }
    if statement.greenfield {
        score -= 15;
        signals.push("proyecto nuevo desde cero".into());
    }
    if let Some(project) = project {
        if project.files >= 60 && statement.areas.len() >= 2 {
            score += 25;
            signals.push(format!(
                "proyecto grande ({} ficheros) y cambio en {} áreas",
                project.files,
                statement.areas.len()
            ));
        } else if project.files >= 60 {
            score += 5;
            signals.push(format!("proyecto grande ({} ficheros)", project.files));
        }
        if !project.has_tests && !statement.greenfield {
            score += 10;
            signals.push(
                "el proyecto no tiene suite de pruebas: el cambio no se puede verificar".into(),
            );
        }
        if project.has_tests {
            signals
                .push("el proyecto tiene suite de pruebas: el resultado se puede verificar".into());
        }
    }
    let tier = if score >= 45 {
        Tier::Feature
    } else {
        Tier::Scoped
    };
    signals.push(format!("puntuación {score} → ruta {}", tier.as_str()));
    (tier, score, signals)
}

pub fn estimate(objective: &str, workspace: Option<&Path>) -> Weight {
    let statement = analyze(objective);
    let project = workspace.map(project_facts);
    let (tier, score, signals) = decide(&statement, project.as_ref());
    Weight {
        tier,
        score,
        signals,
        statement,
        project,
    }
}

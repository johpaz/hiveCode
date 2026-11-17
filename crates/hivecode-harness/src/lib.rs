//! Routes a task by its weight and verifies the result (port of `harness/profile-harness.ts`).
//!
//! Three routes (see `docs/rutas-por-costo.md`):
//! - **conversation**: nothing to change. The lead answers; reading or planning requests get
//!   guidance on how to read the project cheaply.
//! - **scoped**: a bounded change. The lead does it itself, then the project is run (tests, types,
//!   build); if that is red, one repair cycle, and if it is still red the task is reported as failed
//!   with the evidence, never as good.
//! - **feature**: a coupled or wide change. The lead splits it among workers, a Quality Gate worker
//!   ends with `VERDICT: PASS|FAIL`, up to two repair cycles, then a convergence summary.
//!
//! There is no Spec Kit step (not ported): in `plan` mode the lead answers with a short plan, and in
//! execution it plans on its own before delegating. Without the swarm the lead has no workers to
//! delegate to, so a feature is run like a scoped change.
pub mod checks;
pub mod weight;

use hivecode_host::{BoxFuture, Mode, Result};
use regex::Regex;
use std::{path::PathBuf, sync::LazyLock};
pub use weight::{Tier, Weight};

pub const MAX_REPAIR_CYCLES: u32 = 2;

/// Something that can run the lead agent on a prompt and return its answer.
pub trait Lead: Send {
    fn invoke<'a>(&'a mut self, prompt: String) -> BoxFuture<'a, Result<String>>;
}

pub struct Options {
    pub workspace: PathBuf,
    pub mode: Mode,
    /// The lead has workers to delegate to (`--swarm`).
    pub swarm: bool,
    /// Run the project's checks after a change.
    pub verify: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Completed,
    Failed,
    /// `plan` mode: the plan is the answer, nothing was executed.
    Ready,
    /// `approval` mode: the person has not accepted the result.
    WaitingUser,
}

#[derive(Debug, Clone)]
pub struct Outcome {
    pub route: Tier,
    pub signals: Vec<String>,
    pub status: Status,
    pub response: String,
    pub repair_cycles: u32,
}

static PASS: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:PASS|PASSED|APPROVED|APROBADO|CUMPLE)\b").unwrap()
});
static FAIL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b(?:VERDICT|VEREDICTO|STATUS|ESTADO)\s*:\s*(?:FAIL|FAILED|REJECTED|RECHAZADO|NO CUMPLE)\b").unwrap()
});
pub fn passed(output: &str) -> bool {
    PASS.is_match(output) && !FAIL.is_match(output)
}

const READING_WITH_WORKERS: &str = "Lee con el índice (outline, find_symbol, dependents) y fs_read solo con rango; no recorras el repo con fs_list/fs_glob. Reparte por módulo: un scout por área con rutas concretas, todos en un mismo task_delegate_group, no «todo el repo». Cada scout entrega hallazgos con ruta:línea, no listados. Cada turno reenvía todo el contexto: lo que no necesitas leer, no lo leas.";
const READING_ALONE: &str = "Lee con el índice (outline, find_symbol, dependents) y fs_read solo con rango; no recorras el repo con fs_list/fs_glob. Cada turno reenvía todo el contexto: lo que no necesitas leer, no lo leas.";
const PLAN_WITH_WORKERS: &str = "Te piden un plan, no sólo hallazgos. Hazlo en este orden y no te saltes el final:\n1. Investiga con tantos scouts como módulos independientes haya, todos en un mismo task_delegate_group, cada uno con un área y rutas concretas. Pide hallazgos con ruta:línea.\n2. Cuando vuelvan, arma tú el roadmap priorizado (P0/P1/P2) con archivos afectados, pruebas de aceptación y dependencias. Es lo que se te pidió: no releas ni verifiques los informes leyendo código, y no abras otra ronda de scouts para completar criterios.\n3. Si no llegas a cubrir todo, entrega igualmente el plan con lo ya encontrado y di qué quedó sin revisar.";
const PLAN_ALONE: &str = "Te piden un plan, no sólo hallazgos: investiga lo imprescindible y entrega un roadmap priorizado (P0/P1/P2) con archivos afectados, pruebas de aceptación y dependencias. Si no llegas a cubrir todo, entrega el plan con lo encontrado y di qué quedó sin revisar.";

fn plan_prompt(objective: &str, swarm: bool) -> String {
    let research = if swarm {
        "Investiga lo imprescindible (puedes delegar lectura a scouts en paralelo) y responde"
    } else {
        "Investiga lo imprescindible y responde"
    };
    format!(
        "Modo plan: entrega un plan claro y localizado para esta tarea. {research} con: pasos ordenados, archivos afectados, riesgos y cómo se verificará. No modifiques código ni delegues construcción.\n\n{objective}"
    )
}

pub async fn run(
    objective: &str,
    options: &Options,
    lead: &mut dyn Lead,
    approve: &mut (dyn FnMut(&str, &str) -> bool + Send),
) -> Result<Outcome> {
    let workspace = options.workspace.clone();
    let weight = weight::estimate(objective, Some(&workspace));
    let done = |status, response: String, repair_cycles| Outcome {
        route: weight.tier,
        signals: weight.signals.clone(),
        status,
        response,
        repair_cycles,
    };

    // Planning mode never executes: whatever the route, the plan is the answer.
    if options.mode == Mode::Plan && weight.tier != Tier::Conversation {
        let response = lead.invoke(plan_prompt(objective, options.swarm)).await?;
        return Ok(done(Status::Ready, response, 0));
    }

    let project = weight.project.clone().unwrap_or_default();
    match weight.tier {
        Tier::Conversation => {
            let reading = weight.statement.reading || weight.statement.planning;
            let prompt = if reading {
                let lead_text = [
                    if weight.statement.reading {
                        if options.swarm {
                            READING_WITH_WORKERS
                        } else {
                            READING_ALONE
                        }
                    } else {
                        ""
                    },
                    if weight.statement.planning {
                        if options.swarm {
                            PLAN_WITH_WORKERS
                        } else {
                            PLAN_ALONE
                        }
                    } else {
                        ""
                    },
                ]
                .iter()
                .filter(|t| !t.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n\n");
                let facts = weight::describe_facts(&project, &[], &[]);
                let facts = if facts.is_empty() {
                    String::new()
                } else {
                    format!("\n{facts}\n")
                };
                format!("{lead_text}\n{facts}\nObjetivo:\n{objective}")
            } else {
                objective.to_owned()
            };
            Ok(done(Status::Completed, lead.invoke(prompt).await?, 0))
        }
        Tier::Feature if options.swarm => feature(objective, options, lead, approve, done).await,
        // A scoped change, or a feature when there are no workers to split it among.
        _ => scoped(objective, options, lead, &project, done).await,
    }
}

async fn scoped(
    objective: &str,
    options: &Options,
    lead: &mut dyn Lead,
    project: &weight::ProjectFacts,
    done: impl Fn(Status, String, u32) -> Outcome,
) -> Result<Outcome> {
    // What the lead would otherwise spend turns finding out: how the project runs and what will be
    // checked by itself at the end (and what will not, and why).
    let planned = if options.verify {
        checks::planned(&options.workspace).await
    } else {
        vec![]
    };
    let labels: Vec<String> = {
        let mut seen = vec![];
        for c in planned.iter().filter(|c| c.skip.is_none()) {
            let l = c.label.as_str().to_owned();
            if !seen.contains(&l) {
                seen.push(l);
            }
        }
        seen
    };
    let notes: Vec<String> = planned
        .iter()
        .map(|c| match &c.skip {
            Some(why) => format!(
                "{} ({}): no se comprobará — {why}",
                c.label.as_str(),
                c.ecosystem
            ),
            None => format!("{} ({}): `{}`", c.label.as_str(), c.ecosystem, c.command),
        })
        .collect();
    let facts = weight::describe_facts(project, &labels, &notes);
    let delegate = if options.swarm {
        "No lo delegues al worker builder salvo que el trabajo resulte ser grande o tenga bloques independientes que ganen en paralelo; si empieza a crecer, delega ese bloque con task_delegate y criterios de aceptación concretos.\nNo llames al worker verifier: la verificación determinista (pruebas, tipos, build) ya se ejecuta sola sobre el resultado y su veredicto va en el informe."
    } else {
        "No hay workers: hazlo todo tú."
    };
    let prompt = format!(
        "Cambio pequeño y localizado. Hazlo tú directamente: busca y lee lo necesario (agrupa en un mismo paso las lecturas independientes), edita (fs_edit admite varios cambios por llamada con edits[]) y comprueba tu cambio con la prueba o el chequeo que le toque.\n{delegate}\nResponde con un resumen compacto: archivos tocados y pruebas ejecutadas, sin repetir logs ni afirmar pruebas que no estén en la evidencia.\n{}\nObjetivo:\n{objective}",
        if facts.is_empty() {
            String::new()
        } else {
            format!("\n{facts}\n")
        }
    );
    let mut response = lead.invoke(prompt).await?;
    if !options.verify {
        return Ok(done(Status::Completed, response, 0));
    }

    // Running the project costs seconds and its verdict does not depend on who judges. If it is red,
    // one repair cycle; if it is red again the task is reported as failed, with the evidence.
    let mut verdict = checks::verify(&options.workspace).await;
    let mut cycles = 0;
    if !verdict.ok {
        let failed: Vec<String> = verdict
            .checks
            .iter()
            .filter(|c| c.status == checks::Status::Failed)
            .map(|c| format!("- {}: {}", c.name, c.detail))
            .collect();
        response = lead
            .invoke(format!(
                "La verificación del proyecto salió en rojo. Corrígelo tú directamente y después resume qué cambiaste. No afirmes que las pruebas pasan si no lo has comprobado.\n\nComprobaciones en rojo:\n{}\n\nObjetivo original:\n{objective}",
                failed.join("\n")
            ))
            .await?;
        cycles = 1;
        verdict = checks::verify(&options.workspace).await;
    }
    let status = if verdict.ok {
        Status::Completed
    } else {
        Status::Failed
    };
    Ok(done(
        status,
        format!("{response}\n\n{}", checks::describe(&verdict)),
        cycles,
    ))
}

async fn feature(
    objective: &str,
    options: &Options,
    lead: &mut dyn Lead,
    approve: &mut (dyn FnMut(&str, &str) -> bool + Send),
    done: impl Fn(Status, String, u32) -> Outcome,
) -> Result<Outcome> {
    let mut prompt = format!(
        "Tarea compleja: no la hagas tú de una vez.\n1. Investiga lo imprescindible (scouts en paralelo, un task_delegate_group) y divide el trabajo en tareas con sus archivos y dependencias. Un objetivo pequeño lleva 2 a 4 tareas, no una por archivo; una tarea incluye su propia prueba y agrupa lo que comparte archivos.\n2. Delega las tareas con task_delegate_group: las que no comparten archivos van en el mismo grupo (para dos builders a la vez, instancias builder y builder#2, hasta builder#3); una que necesita el resultado de otra lleva after: [ref].\n3. Cada delegación lleva criterios de aceptación verificables. Juzga la evidencia; si no cumple, task_revise con feedback concreto (como mucho dos veces por tarea).\n4. Cuando todas estén hechas, delega al worker verifier (Quality Gate): reproducir cada criterio de aceptación contra el sistema real y revisar el diff. Debe terminar con «VERDICT: PASS» o «VERDICT: FAIL».\n5. Termina con el veredicto del Quality Gate tal cual, la evidencia y los archivos tocados.\n\nObjetivo:\n{objective}"
    );
    let mut cycles = 0;
    let quality = loop {
        let quality = lead.invoke(prompt).await?;
        if passed(&quality) {
            break quality;
        }
        if cycles >= MAX_REPAIR_CYCLES {
            return Ok(done(
                Status::Failed,
                format!(
                    "El Quality Gate no convergió tras {cycles} ciclos de reparación.\n\n{quality}"
                ),
                cycles,
            ));
        }
        cycles += 1;
        prompt = format!(
            "Ciclo de reparación {cycles}/{MAX_REPAIR_CYCLES}. Corrige solo los fallos accionables del Quality Gate (task_revise a la tarea que falló, o delega de nuevo), conserva lo que ya pasa y vuelve a delegar el Quality Gate al verifier. Termina con «VERDICT: PASS» o «VERDICT: FAIL».\n\nQUALITY GATE ANTERIOR:\n{quality}\n\nObjetivo original:\n{objective}"
        );
    };
    let convergence = lead
        .invoke(format!(
            "Consolida la tarea. Responde al usuario con un resumen compacto de resultado, archivos y pruebas, sin afirmar nada que no esté en la evidencia.\n\nGATE DE CALIDAD (verificación + revisión):\n{quality}"
        ))
        .await?;
    // The project is also run: the Quality Gate is a model's judgement, this is a measurement.
    let mut response = convergence;
    if options.verify {
        let verdict = checks::verify(&options.workspace).await;
        response = format!("{response}\n\n{}", checks::describe(&verdict));
        if !verdict.ok {
            return Ok(done(Status::Failed, response, cycles));
        }
    }
    if options.mode == Mode::Approval && !approve("convergence", &response) {
        return Ok(done(Status::WaitingUser, response, cycles));
    }
    Ok(done(Status::Completed, response, cycles))
}

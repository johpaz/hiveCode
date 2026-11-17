//! Where a run shows what it does and asks what it must. The terminal is one `Ui`; the TUI is another.
use hivecode_host::Event;
use serde_json::{Value, json};
use std::io::Write;

/// What a finished run reports.
pub struct Report {
    pub run_id: String,
    pub answer: String,
    pub integration: String,
    pub budget: Option<Value>,
    pub harness: Option<Value>,
    pub undoable: bool,
    /// Changed files an architecture decision makes `high` or `critical` to touch.
    pub risks: Vec<Value>,
    /// What the run was asked, shortened (the description of its checkpoint).
    pub objective: String,
    /// The files the run changed in the project.
    pub changed: Vec<String>,
}

pub trait Ui: Send + Sync {
    /// A progress line or a warning (`· ...`, `⚠ ...`).
    fn note(&self, text: &str);
    /// What the lead (`worker == None`) or a worker does.
    fn event(&self, worker: Option<&str>, event: &Event);
    /// A mutating tool in `approval` mode. Without anybody to ask, `false`.
    fn approve(&self, name: &str, arguments: &Value) -> bool;
    /// The harness' convergence gate.
    fn gate(&self, gate: &str, text: &str) -> bool;
    fn done(&self, report: &Report);
    /// The lead delegating to a worker, a worker waiting, a worker ending.
    fn swarm(&self, _event: &hivecode_swarm::SwarmEvent) {}
}

/// The command line: `--headless` is NDJSON on stdout, otherwise text with progress on stderr.
pub struct Terminal {
    pub headless: bool,
}

fn yes(line: &str) -> bool {
    matches!(
        line.trim().to_lowercase().as_str(),
        "s" | "si" | "sí" | "y" | "yes"
    )
}

impl Ui for Terminal {
    fn note(&self, text: &str) {
        eprintln!("{text}");
    }

    fn event(&self, worker: Option<&str>, event: &Event) {
        match (worker, self.headless) {
            (Some(worker), true) => {
                if let Event::ToolStart { name, .. } = event {
                    println!(
                        "{}",
                        json!({"type": "worker_tool", "worker": worker, "name": name})
                    );
                }
            }
            (Some(worker), false) => match event {
                Event::ToolStart { name, .. } => eprintln!("  · {worker}: {name}"),
                Event::ToolDenied { name, reason } => eprintln!("  ✗ {worker}: {name}: {reason}"),
                _ => {}
            },
            (None, true) => {
                let line = match event {
                    Event::Text(text) => json!({"type": "text", "text": text}),
                    Event::ToolStart { name, arguments } => {
                        json!({"type": "tool_start", "name": name, "arguments": arguments})
                    }
                    Event::ToolDone { name, ok } => {
                        json!({"type": "tool_done", "name": name, "ok": ok})
                    }
                    Event::ToolDenied { name, reason } => {
                        json!({"type": "tool_denied", "name": name, "reason": reason})
                    }
                };
                println!("{line}");
            }
            (None, false) => match event {
                Event::ToolDenied { name, reason } => eprintln!("✗ {name}: {reason}"),
                Event::Text(text) => {
                    print!("{text}");
                    let _ = std::io::stdout().flush();
                }
                Event::ToolStart { name, .. } => eprintln!("· {name}"),
                Event::ToolDone { .. } => {}
            },
        }
    }

    fn approve(&self, name: &str, arguments: &Value) -> bool {
        use std::io::{BufRead, IsTerminal};
        if !std::io::stdin().is_terminal() {
            return false;
        }
        let shown: String = arguments.to_string().chars().take(300).collect();
        eprint!("¿Permitir {name} {shown}? [s/N] ");
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).is_ok() && yes(&line)
    }

    fn gate(&self, gate: &str, text: &str) -> bool {
        use std::io::{BufRead, IsTerminal};
        if !std::io::stdin().is_terminal() {
            return false;
        }
        let shown: String = text.chars().take(1500).collect();
        eprintln!("\n── {gate} ──\n{shown}");
        eprint!("¿Aceptar el resultado? [s/N] ");
        let mut line = String::new();
        std::io::stdin().lock().read_line(&mut line).is_ok() && yes(&line)
    }

    fn swarm(&self, event: &hivecode_swarm::SwarmEvent) {
        use hivecode_swarm::SwarmEvent::*;
        match (event, self.headless) {
            (
                Delegated {
                    id, to, summary, ..
                },
                true,
            ) => {
                println!(
                    "{}",
                    json!({"type": "delegation", "id": id, "worker": to, "summary": summary})
                );
            }
            (
                Finished {
                    id,
                    to,
                    ok,
                    summary,
                    ..
                },
                true,
            ) => {
                println!(
                    "{}",
                    json!({"type": "handoff", "id": id, "worker": to, "ok": ok, "summary": summary})
                );
            }
            (
                Waiting {
                    worker, for_refs, ..
                },
                true,
            ) => {
                println!(
                    "{}",
                    json!({"type": "waiting", "worker": worker, "for": for_refs})
                );
            }
            (Delegated { to, summary, .. }, false) => eprintln!("  → {to}: {summary}"),
            (Finished { to, ok, .. }, false) => eprintln!("  {} {to}", if *ok { "✓" } else { "✗" }),
            (
                Waiting {
                    worker, for_refs, ..
                },
                false,
            ) => eprintln!("  … {worker} espera a {}", for_refs.join(", ")),
        }
    }

    fn done(&self, report: &Report) {
        if self.headless {
            println!(
                "{}",
                json!({"type": "done", "run_id": report.run_id, "content": report.answer,
                    "integration": report.integration, "budget": report.budget,
                    "harness": report.harness, "undoable": report.undoable, "risks": report.risks})
            );
        } else {
            println!();
            if let Some(used) = &report.budget {
                eprintln!(
                    "· presupuesto usado: {} llamadas al modelo, {} de herramientas, {} tokens de salida",
                    used["model_calls"], used["tool_calls"], used["output_tokens"]
                );
            }
        }
    }
}

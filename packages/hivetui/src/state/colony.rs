//! Task-scoped scene projection. Legacy MESA telemetry remains independent.
use super::{BeeState, StreamEntry, SwarmState, ToolCall, WaitingAgent};
use crate::ipc::BunMessage;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
pub struct Collaboration {
    pub id: String,
    pub from: String,
    pub to: String,
    pub kind: String,
    pub summary: String,
    pub received_at: std::time::Instant,
}

#[derive(Debug, Default)]
pub struct ColonyState {
    pub task_id: Option<String>,
    pub session_id: String,
    pub members: HashSet<String>,
    pub parents: HashMap<String, String>,
    pub activity: HashMap<String, String>,
    pub statuses: HashMap<String, String>,
    pub tasks: HashMap<String, String>,
    pub workers: HashMap<String, super::Worker>,
    pub telemetry: SwarmState,
    pub entries: Vec<StreamEntry>,
    pub relations: Vec<Collaboration>,
    seen: HashSet<String>,
}

impl ColonyState {
    pub(super) fn accepts(&self, task: &Option<String>) -> bool {
        task.as_ref()
            .zip(self.task_id.as_ref())
            .is_none_or(|(a, b)| a == b)
    }

    fn terminal(&self, agent: &str) -> bool {
        self.statuses.get(agent).is_some_and(|s| {
            matches!(
                s.as_str(),
                "done" | "completed" | "failed" | "cancelled" | "idle"
            )
        })
    }

    fn push(&mut self, mut entry: StreamEntry) {
        // Bound token-heavy payloads as well as event count.
        match &mut entry {
            StreamEntry::Razonamiento { texto, .. } | StreamEntry::Narracion { texto, .. } => {
                *texto = texto.chars().take(16_384).collect();
            }
            _ => {}
        }
        let merged = match (self.entries.last_mut(), &entry) {
            (
                Some(StreamEntry::Razonamiento {
                    agent: a,
                    texto: text,
                    ..
                }),
                StreamEntry::Razonamiento {
                    agent: b,
                    texto: next,
                    ..
                },
            )
            | (
                Some(StreamEntry::Narracion {
                    agent: a,
                    texto: text,
                    ..
                }),
                StreamEntry::Narracion {
                    agent: b,
                    texto: next,
                    ..
                },
            ) if a == b && text.chars().count() + next.chars().count() <= 16_384 => {
                *text = text.chars().chain(next.chars()).take(16_384).collect();
                true
            }
            _ => false,
        };
        if !merged {
            self.entries.push(entry);
        }
        if self.entries.len() > 400 {
            self.entries.remove(0);
        }
    }

    pub fn observe(&mut self, msg: &BunMessage) {
        match msg {
            BunMessage::Init { session_id, .. } => self.session_id = session_id.clone(),
            BunMessage::SessionChanged { session_id, fresh } => {
                if !fresh {
                    *self = Self::default();
                }
                self.session_id = session_id.clone();
            }
            BunMessage::TaskUpdate {
                task_id, status, ..
            } => {
                if matches!(
                    status.as_str(),
                    "running" | "planning" | "approval" | "paused"
                ) && self.task_id.as_ref() != Some(task_id)
                {
                    let session_id = self.session_id.clone();
                    *self = Self {
                        task_id: Some(task_id.clone()),
                        session_id,
                        ..Self::default()
                    };
                }
                if self.task_id.as_ref() == Some(task_id)
                    && matches!(
                        status.as_str(),
                        "completed" | "done" | "failed" | "cancelled"
                    )
                {
                    let agents: Vec<_> = self.members.iter().cloned().collect();
                    for agent in agents {
                        self.telemetry
                            .release_agent(&agent, status != "failed" && status != "cancelled");
                        self.statuses.insert(
                            agent,
                            if status == "failed" || status == "cancelled" {
                                "failed"
                            } else {
                                "done"
                            }
                            .into(),
                        );
                    }
                }
            }
            BunMessage::WorkerUpdate {
                worker,
                parent_id,
                task_id,
                status,
                current_action,
                ..
            } if self.accepts(task_id) => {
                self.members.insert(worker.clone());
                self.statuses.insert(worker.clone(), status.clone());
                if let Some(parent) = parent_id {
                    self.parents.insert(worker.clone(), parent.clone());
                }
                if let Some(task) = current_action {
                    self.tasks.insert(worker.clone(), task.clone());
                }
                self.release(worker, status);
            }
            BunMessage::ActivityUpdate {
                coordinator,
                task_id,
                status,
                current_action,
                ..
            } if self.accepts(task_id) => {
                if coordinator.is_empty() {
                    return;
                }
                self.members.insert(coordinator.clone());
                self.statuses.insert(coordinator.clone(), status.clone());
                if let Some(task) = current_action {
                    self.tasks.insert(coordinator.clone(), task.clone());
                }
                self.release(coordinator, status);
            }
            BunMessage::WorkersSnapshot { workers }
            | BunMessage::DashboardSnapshot { workers, .. } => {
                for w in workers {
                    if !self.accepts(&w.task_id) {
                        continue;
                    }
                    self.members.insert(w.name.clone());
                    self.statuses.insert(w.name.clone(), w.status.clone());
                    if let Some(parent) = &w.parent_id {
                        self.parents.insert(w.name.clone(), parent.clone());
                    }
                    if let Some(task) = &w.current_action {
                        self.tasks.insert(w.name.clone(), task.clone());
                    }
                }
                let ended: Vec<_> = self
                    .statuses
                    .iter()
                    .map(|(a, s)| (a.clone(), s.clone()))
                    .collect();
                for (a, s) in ended {
                    self.release(&a, &s);
                }
            }
            BunMessage::ThoughtChunk {
                task_id,
                coordinator,
                content,
                ..
            } if self.accepts(task_id) => {
                self.members.insert(coordinator.clone());
                if !self.terminal(coordinator) {
                    self.activity
                        .insert(coordinator.clone(), "razonando".into());
                    self.statuses.insert(coordinator.clone(), "running".into());
                    self.telemetry.clear_waiting(coordinator);
                }
                self.push(StreamEntry::Razonamiento {
                    agent: coordinator.clone(),
                    ts: 0,
                    texto: content.clone(),
                });
            }
            BunMessage::NarrativeChunk {
                task_id,
                coordinator,
                content,
                replay,
                ..
            } if self.accepts(task_id) => {
                if !replay && !self.terminal(coordinator) {
                    self.members.insert(coordinator.clone());
                    self.activity.insert(coordinator.clone(), "narrando".into());
                    self.statuses.insert(coordinator.clone(), "running".into());
                    self.telemetry.clear_waiting(coordinator);
                }
                self.push(StreamEntry::Narracion {
                    agent: coordinator.clone(),
                    ts: 0,
                    texto: content.clone(),
                });
            }
            BunMessage::ToolCall {
                task_id,
                agent,
                tool,
                call_id,
                args_summary,
                bee_state,
                at,
            } if self.accepts(task_id) => {
                self.members.insert(agent.clone());
                self.telemetry.clear_waiting(agent);
                self.statuses.insert(agent.clone(), "running".into());
                self.activity.remove(agent);
                self.telemetry.start_call(ToolCall {
                    call_id: call_id.clone(),
                    agent: agent.clone(),
                    tool: tool.clone(),
                    args_summary: args_summary.clone(),
                    bee_state: BeeState::from_str(bee_state),
                    started_at: *at,
                    settled: false,
                    ok: None,
                    duration_ms: None,
                });
                self.push(StreamEntry::ToolStart {
                    agent: agent.clone(),
                    ts: *at,
                    call_id: call_id.clone(),
                    tool: tool.clone(),
                    resumen: args_summary.clone(),
                    bee_state: BeeState::from_str(bee_state),
                });
            }
            BunMessage::ToolDone {
                task_id,
                agent,
                tool,
                call_id,
                ok,
                duration_ms,
                result_summary,
                at,
            } if self.accepts(task_id) => {
                self.telemetry.settle_call(call_id, *ok, *duration_ms);
                self.activity.remove(agent);
                self.telemetry.clear_waiting(agent);
                self.push(StreamEntry::ToolDone {
                    agent: agent.clone(),
                    ts: *at,
                    call_id: call_id.clone(),
                    tool: tool.clone(),
                    ok: *ok,
                    duracion_ms: *duration_ms,
                    resumen: result_summary.clone(),
                });
            }
            BunMessage::Esperando {
                task_id,
                agent,
                esperando_a,
                razon,
                at,
            } if self.accepts(task_id) => {
                self.members.insert(agent.clone());
                self.telemetry.set_waiting(WaitingAgent {
                    agent: agent.clone(),
                    waiting_for: esperando_a.clone(),
                    reason: razon.clone(),
                    since: *at,
                });
                self.push(StreamEntry::Bloqueado {
                    agent: agent.clone(),
                    ts: *at,
                    esperando_a: esperando_a.clone(),
                    razon: razon.clone(),
                });
            }
            BunMessage::SwarmCollaboration {
                event_id,
                delegation_id,
                task_id,
                session_id,
                from,
                to,
                kind,
                summary,
                ..
            } if self.accepts(task_id)
                && session_id.as_ref().is_none_or(|s| s == &self.session_id) =>
            {
                if !matches!(kind.as_str(), "delegation" | "handoff" | "failed") {
                    return;
                }
                if !self.seen.insert(event_id.clone()) {
                    return;
                }
                if self.seen.len() > 800 {
                    self.seen.clear();
                    self.seen.insert(event_id.clone());
                }
                self.members.extend([from.clone(), to.clone()]);
                self.parents.insert(to.clone(), from.clone());
                if kind == "delegation" {
                    self.tasks.insert(to.clone(), summary.clone());
                    self.statuses.insert(to.clone(), "running".into());
                } else {
                    self.release(to, if kind == "failed" { "failed" } else { "done" });
                    self.statuses.insert(
                        to.clone(),
                        if kind == "failed" { "failed" } else { "done" }.into(),
                    );
                }
                self.relations.push(Collaboration {
                    id: delegation_id.clone(),
                    from: from.clone(),
                    to: to.clone(),
                    kind: kind.clone(),
                    summary: summary.clone(),
                    received_at: std::time::Instant::now(),
                });
                if self.relations.len() > 200 {
                    self.relations.remove(0);
                }
            }
            _ => {}
        }
    }

    fn release(&mut self, agent: &str, status: &str) {
        if matches!(
            status,
            "done" | "completed" | "failed" | "cancelled" | "idle"
        ) {
            self.telemetry
                .release_agent(agent, !matches!(status, "failed" | "cancelled"));
            self.activity.remove(agent);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn send(state: &mut ColonyState, json: &str) {
        state.observe(&sonic_rs::from_str::<BunMessage>(json).unwrap());
    }

    #[test]
    fn instances_and_parallel_calls_are_independent_and_terminal_events_release_them() {
        let mut state = ColonyState::default();
        for (agent, call) in [("builder", "a"), ("builder#2", "b"), ("builder#2", "c")] {
            send(
                &mut state,
                &format!(
                    r#"{{"type":"tool_call","agent":"{agent}","tool":"fs_write","call_id":"{call}","args_summary":"src/a.ts","bee_state":"writing","at":100}}"#
                ),
            );
        }
        assert_eq!(state.telemetry.calls_for("builder#2").len(), 2);
        send(
            &mut state,
            r#"{"type":"tool_done","agent":"builder#2","tool":"fs_write","call_id":"b","ok":false,"duration_ms":20,"result_summary":"denied","at":120}"#,
        );
        assert_eq!(state.telemetry.calls_for("builder#2").len(), 1);
        assert_eq!(state.telemetry.calls_for("builder").len(), 1);
        send(
            &mut state,
            r#"{"type":"worker_update","worker":"builder#2","phase":"edit","status":"failed"}"#,
        );
        assert_eq!(state.telemetry.calls_for("builder#2").len(), 0);
        assert_eq!(state.telemetry.calls_for("builder").len(), 1);
    }

    #[test]
    fn task_switch_and_session_switch_drop_old_scene_and_ignore_late_events() {
        let mut state = ColonyState::default();
        send(
            &mut state,
            r#"{"type":"task_update","task_id":"old","status":"running"}"#,
        );
        send(
            &mut state,
            r#"{"type":"thought_chunk","coordinator":"builder","task_id":"old","phase":"thinking","content":"old content"}"#,
        );
        send(
            &mut state,
            r#"{"type":"task_update","task_id":"new","status":"running"}"#,
        );
        send(
            &mut state,
            r#"{"type":"thought_chunk","coordinator":"builder","task_id":"old","phase":"thinking","content":"late content"}"#,
        );
        assert!(state.entries.is_empty());
        send(
            &mut state,
            r#"{"type":"narrative_chunk","coordinator":"builder","task_id":"new","phase":"narrative","content":"current"}"#,
        );
        assert_eq!(state.entries.len(), 1);
        send(
            &mut state,
            r#"{"type":"session_changed","session_id":"next"}"#,
        );
        assert!(state.entries.is_empty());
        assert!(state.members.is_empty());
        assert_eq!(state.session_id, "next");
    }

    #[test]
    fn replay_never_animates_a_worker_and_reasoning_stays_separate_from_narration() {
        let mut state = ColonyState::default();
        send(
            &mut state,
            r#"{"type":"narrative_chunk","coordinator":"builder","phase":"narrative","content":"historical","replay":true}"#,
        );
        assert!(state.activity.is_empty());
        assert!(state.members.is_empty());
        send(
            &mut state,
            r#"{"type":"thought_chunk","coordinator":"builder","phase":"thinking","content":"reason"}"#,
        );
        assert!(matches!(
            &state.entries[1],
            StreamEntry::Razonamiento { .. }
        ));
        send(
            &mut state,
            r#"{"type":"narrative_chunk","coordinator":"builder","phase":"narrative","content":"spoken"}"#,
        );
        assert!(matches!(&state.entries[2], StreamEntry::Narracion { .. }));
        assert_eq!(state.activity["builder"], "narrando");
    }

    #[test]
    fn structured_delegations_are_deduplicated_and_terminal_handoffs_release_calls() {
        let mut state = ColonyState::default();
        let start = r#"{"type":"swarm_collaboration","event_id":"start","delegation_id":"d","from":"bee","to":"builder#2","kind":"delegation","summary":"implement auth","at":10}"#;
        send(&mut state, start);
        send(&mut state, start);
        assert_eq!(state.relations.len(), 1);
        assert_eq!(state.parents["builder#2"], "bee");
        send(
            &mut state,
            r#"{"type":"tool_call","agent":"builder#2","tool":"fs_read","call_id":"open","args_summary":"src/a","bee_state":"reading","at":10}"#,
        );
        send(
            &mut state,
            r#"{"type":"swarm_collaboration","event_id":"end","delegation_id":"d","from":"bee","to":"builder#2","kind":"handoff","summary":"evidence","at":20}"#,
        );
        assert!(state.telemetry.in_flight.is_empty());
        assert_eq!(state.statuses["builder#2"], "done");
    }

    #[test]
    fn journals_and_stream_payloads_are_bounded() {
        let mut state = ColonyState::default();
        for n in 0..500 {
            state.push(StreamEntry::Narracion {
                agent: format!("a{n}"),
                ts: 0,
                texto: "x".repeat(20000),
            });
        }
        assert_eq!(state.entries.len(), 400);
        assert_eq!(state.entries[0].summary().len(), 16384);
    }
    #[test]
    fn delayed_reasoning_cannot_reactivate_a_terminal_worker() {
        let mut state = ColonyState::default();
        send(
            &mut state,
            r#"{"type":"worker_update","worker":"builder","phase":"work","status":"done"}"#,
        );
        send(
            &mut state,
            r#"{"type":"thought_chunk","coordinator":"builder","phase":"thinking","content":"delayed"}"#,
        );
        assert_eq!(state.statuses["builder"], "done");
        assert!(state.activity.is_empty());
        assert_eq!(state.entries.len(), 1);
    }

    #[test]
    fn full_chunks_roll_over_so_new_output_is_never_silently_discarded() {
        let mut state = ColonyState::default();
        state.push(StreamEntry::Narracion {
            agent: "builder".into(),
            ts: 0,
            texto: "x".repeat(16_384),
        });
        state.push(StreamEntry::Narracion {
            agent: "builder".into(),
            ts: 0,
            texto: "newest".into(),
        });
        assert_eq!(state.entries.len(), 2);
        assert_eq!(state.entries.last().unwrap().summary(), "newest");
    }
}

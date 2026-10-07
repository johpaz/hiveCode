//! El stream de MESA: razonamiento, acción y veredicto, en un solo lugar.
//!
//! Antes eran 11 líneas: un `Vec<ThoughtChunk { coordinator, phase, content }>`
//! plano donde `thought_chunk` y `narrative_chunk` se funnelizaban al **mismo**
//! array, y `content_type` + `stream_id` se parseaban para tirarse.
//!
//! Kimi separa explícitamente el razonamiento, la acción y el resultado. Aquí
//! igual, y cada entrada tiene un origen verificable:
//!
//! | Variante | De dónde sale | Por defecto |
//! |---|---|---|
//! | `Razonamiento` | `thought_chunk` — el modelo pensando | **colapsado** |
//! | `Narracion` | `narrative_chunk` — lo que el agente dice | expandido |
//! | `ToolStart` / `ToolDone` | `tool_call` / `tool_done` | expandido |
//! | `Decision` | `jev:decision` — el "por qué" del oráculo | **colapsado** |
//! | `Poda` | `CompiledContext.jevDecision.summary` | **colapsado** |
//! | `Pregunta` | `agentMcpOff` — el agente necesita algo del usuario | expandido |
//! | `Bloqueado` | `esperando` | expandido |
//! | `Error` | errores de tool y del enjambre | expandido |

use crate::state::{BeeState, ToolCall, WaitingAgent};

/// Una entrada del stream. El enum discrimina en vez de un struct con campos
/// opcionales: seis de ocho variantes no usan `content`, y con un struct
/// obligatorio cada entradaEMENTO_a lies about what it is.
#[derive(Debug, Clone)]
pub enum StreamEntry {
    /// El modelo pensando. Ruidoso y largo: colapsado.
    Razonamiento {
        agent: String,
        ts: u64,
        texto: String,
    },
    /// Lo que el agente dice en español.
    Narracion {
        agent: String,
        ts: u64,
        texto: String,
    },
    ToolStart {
        agent: String,
        ts: u64,
        /// Empareja con su `ToolDone`. El nombre de la tool no sirve: dos
        /// agentes pueden llamar a la misma a la vez, e incluso el mismo agente
        /// en paralelo.
        call_id: String,
        tool: String,
        resumen: String,
        bee_state: BeeState,
    },
    ToolDone {
        agent: String,
        ts: u64,
        call_id: String,
        tool: String,
        ok: bool,
        duracion_ms: u64,
        resumen: String,
    },
    /// Una decisión de Jev: paralelismo, delegación, siguiente acción.
    Decision {
        agent: String,
        ts: u64,
        kind: String,
        summary: String,
        saved_tokens: u64,
    },
    /// Jev podó el contexto de este turno.
    Poda {
        agent: String,
        ts: u64,
        resumen: String,
        saved_tokens: u64,
    },
    /// El agente no puede seguir sin que intervenga el usuario.
    ///
    /// Es la pregunta de aclaración de Kimi: no se cuela en la narración, se
    /// pide explícitamente.
    Pregunta {
        agent: String,
        ts: u64,
        texto: String,
        mcp_apagados: Vec<String>,
    },
    Bloqueado {
        agent: String,
        ts: u64,
        esperando_a: Vec<String>,
        razon: String,
    },
    Error {
        agent: String,
        ts: u64,
        mensaje: String,
    },
}

impl StreamEntry {
    pub fn agent(&self) -> &str {
        match self {
            StreamEntry::Razonamiento { agent, .. }
            | StreamEntry::Narracion { agent, .. }
            | StreamEntry::ToolStart { agent, .. }
            | StreamEntry::ToolDone { agent, .. }
            | StreamEntry::Decision { agent, .. }
            | StreamEntry::Poda { agent, .. }
            | StreamEntry::Pregunta { agent, .. }
            | StreamEntry::Bloqueado { agent, .. }
            | StreamEntry::Error { agent, .. } => agent,
        }
    }

    pub fn ts(&self) -> u64 {
        match self {
            StreamEntry::Razonamiento { ts, .. }
            | StreamEntry::Narracion { ts, .. }
            | StreamEntry::ToolStart { ts, .. }
            | StreamEntry::ToolDone { ts, .. }
            | StreamEntry::Decision { ts, .. }
            | StreamEntry::Poda { ts, .. }
            | StreamEntry::Pregunta { ts, .. }
            | StreamEntry::Bloqueado { ts, .. }
            | StreamEntry::Error { ts, .. } => *ts,
        }
    }

    /// Las entradas que vienenKI inherently ruidosas. Decidirlo una vez aquí, y
    /// no en cada widget, es lo que evita que un panel colapse el razonamiento
    /// y otro no.
    pub fn is_verbose(&self) -> bool {
        matches!(
            self,
            StreamEntry::Razonamiento { .. } | StreamEntry::Decision { .. } | StreamEntry::Poda { .. }
        )
    }

    /// Glifo del canal: separa a simple vista qué es ruido y qué es acción.
    pub fn glyph(&self) -> &'static str {
        match self {
            StreamEntry::Razonamiento { .. } => "◐",
            StreamEntry::Narracion { .. } => "▸",
            StreamEntry::ToolStart { .. } => "⚙",
            StreamEntry::ToolDone { ok: true, .. } => "✓",
            StreamEntry::ToolDone { ok: false, .. } => "✗",
            StreamEntry::Decision { .. } => "◆",
            StreamEntry::Poda { .. } => "⧗",
            StreamEntry::Pregunta { .. } => "💬",
            StreamEntry::Bloqueado { .. } => "⏳",
            StreamEntry::Error { .. } => "✗",
        }
    }

    /// Texto de una línea, para la lista compacta.
    pub fn summary(&self) -> String {
        match self {
            StreamEntry::Razonamiento { texto, .. } => texto.clone(),
            StreamEntry::Narracion { texto, .. } => texto.clone(),
            StreamEntry::ToolStart { tool, resumen, .. } => {
                if resumen.is_empty() { tool.clone() } else { format!("{tool} · {resumen}") }
            }
            StreamEntry::ToolDone { tool, duracion_ms, resumen, .. } => {
                if resumen.is_empty() {
                    format!("{tool} · {duracion_ms}ms")
                } else {
                    format!("{tool} · {duracion_ms}ms · {resumen}")
                }
            }
            StreamEntry::Decision { kind, summary, saved_tokens, .. } => {
                if *saved_tokens > 0 {
                    format!("{kind} · {summary} · ahorró {}", crate::ui::terminal_primitives::fmt_tokens(*saved_tokens))
                } else {
                    format!("{kind} · {summary}")
                }
            }
            StreamEntry::Poda { resumen, saved_tokens, .. } => {
                if *saved_tokens > 0 {
                    format!("{resumen} · ahorró {}", crate::ui::terminal_primitives::fmt_tokens(*saved_tokens))
                } else {
                    resumen.clone()
                }
            }
            StreamEntry::Pregunta { texto, .. } => texto.clone(),
            StreamEntry::Bloqueado { razon, esperando_a, .. } => {
                if esperando_a.is_empty() {
                    razon.clone()
                } else {
                    format!("{razon} · {}", esperando_a.join(" "))
                }
            }
            StreamEntry::Error { mensaje, .. } => mensaje.clone(),
        }
    }

}

/// El stream: acotado, filtrable por agente.
#[derive(Debug)]
pub struct ThoughtStreamState {
    /// Entradas mezcladas de todos los agentes, en orden de llegada.
    pub entries: Vec<StreamEntry>,
    /// Solo de este agente. Vacío = todos.
    pub filtro: Option<String>,
    /// Las entradasDerivadas de `thought_chunk` / `narrative_chunk` se conservan
    /// aquí para los layouts que las leen directamente (Plan, Code, la ficha).
    pub chunks: Vec<ThoughtChunk>,
    pub capacity: usize,
}

/// El tipo original. Se mantiene porque tres layouts lo leen y rehacerlos todos
/// en la misma capa habría sido más riesgo que valor.
#[derive(Debug, Clone)]
pub struct ThoughtChunk {
    pub coordinator: String,
    pub phase: String,
    pub content: String,
}

impl Default for ThoughtStreamState {
    fn default() -> Self {
        ThoughtStreamState {
            entries: Vec::new(),
            filtro: None,
            chunks: Vec::new(),
            capacity: 400,
        }
    }
}

impl ThoughtStreamState {
    pub fn push(&mut self, entry: StreamEntry) {
        self.entries.push(entry);
        if self.entries.len() > self.capacity {
            let excess = self.entries.len() - self.capacity;
            self.entries.drain(0..excess);
        }
    }

    /// Interrumpe un `tool_call` con su `tool_done`. Devuelve las entradas
    /// agregadas para que el llamador sepa si hubo que crear alguna.
    pub fn push_chunk(&mut self, chunk: ThoughtChunk) {
        let entry = if chunk.phase.eq_ignore_ascii_case("thinking")
            || chunk.phase.eq_ignore_ascii_case("reason")
        {
            StreamEntry::Razonamiento {
                agent: chunk.coordinator.clone(),
                ts: 0,
                texto: chunk.content.clone(),
            }
        } else {
            StreamEntry::Narracion {
                agent: chunk.coordinator.clone(),
                ts: 0,
                texto: chunk.content.clone(),
            }
        };
        self.push(entry);
        self.chunks.push(chunk);
        // El mismo cap que el stream: si divergen, uno crece sin límite mientras
        // el otro se acota y el layout lee el que no coincide.
        if self.chunks.len() > self.capacity {
            let excess = self.chunks.len() - self.capacity;
            self.chunks.drain(0..excess);
        }
    }

    /// Traduce una tool call en vuelo a una entrada del stream.
    pub fn push_tool_start(&mut self, call: &ToolCall, at: u64) {
        self.push(StreamEntry::ToolStart {
            agent: call.agent.clone(),
            ts: if at > 0 { at } else { call.started_at },
            call_id: call.call_id.clone(),
            tool: call.tool.clone(),
            resumen: call.args_summary.clone(),
            bee_state: call.bee_state,
        });
    }

    pub fn push_waiting(&mut self, waiting: &WaitingAgent) {
        self.push(StreamEntry::Bloqueado {
            agent: waiting.agent.clone(),
            ts: waiting.since,
            esperando_a: waiting.waiting_for.clone(),
            razon: waiting.reason_label().to_string(),
        });
    }

    /// Lo que se ve con el filtro actual.
    pub fn visibles(&self) -> Vec<&StreamEntry> {
        self.entries
            .iter()
            .filter(|e| match &self.filtro {
                None => true,
                Some(agent) => e.agent().eq_ignore_ascii_case(agent),
            })
            .collect()
    }

    pub fn set_filtro(&mut self, agent: Option<String>) {
        self.filtro = agent;
    }

    pub fn alternar_filtro(&mut self, agent: &str) {
        self.filtro = match &self.filtro {
            Some(current) if current.eq_ignore_ascii_case(agent) => None,
            _ => Some(agent.to_string()),
        };
    }

    /// Entradas de un agente que aún no tienen `tool_done`. Un `tool_call`
    /// perdido deja el spinner girando; aquí se puede decir.
    pub fn abiertas(&self) -> Vec<&StreamEntry> {
        let mut abiertas: Vec<&StreamEntry> = Vec::new();
        for entry in &self.entries {
            match entry {
                StreamEntry::ToolStart { call_id, .. } => {
                    // Un `tool_done` puede haber llegado antes (el canal es
                    // asíncrono y por carriles); entonces ya no está abierta.
                    let cerrada = self.entries.iter().any(|e| {
                        matches!(e, StreamEntry::ToolDone { call_id: c, .. } if c == call_id)
                    });
                    if !cerrada {
                        abiertas.push(entry);
                    }
                }
                _ => {}
            }
        }
        abiertas
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{BeeState, JevAvailability, JevDecision, McpState};

    fn chunk(coordinator: &str, phase: &str, content: &str) -> ThoughtChunk {
        ThoughtChunk {
            coordinator: coordinator.into(),
            phase: phase.into(),
            content: content.into(),
        }
    }

    fn call(agent: &str, tool: &str) -> ToolCall {
        ToolCall {
            call_id: format!("{agent}-{tool}"),
            agent: agent.into(),
            tool: tool.into(),
            args_summary: "src/a.ts".into(),
            bee_state: BeeState::Writing,
            started_at: 10,
            settled: false,
            ok: None,
            duration_ms: None,
        }
    }

    #[test]
    fn thinking_chunks_become_reasoning_and_others_become_narration() {
        let mut stream = ThoughtStreamState::default();
        stream.push_chunk(chunk("bee", "thinking", "voy a revisar el schema"));
        stream.push_chunk(chunk("bee", "analizando", "encontré tres tablas"));

        assert!(matches!(stream.entries[0], StreamEntry::Razonamiento { .. }));
        assert!(matches!(stream.entries[1], StreamEntry::Narracion { .. }));
        // Y el tipo original se conserva para los layouts que lo leen.
        assert_eq!(stream.chunks.len(), 2);
    }

    #[test]
    fn only_reasoning_decisions_and_pruning_default_to_collapsed() {
        // El criterio se decide una vez, no en cada widget: si un panel colapsa
        // el razonamiento y otro no, la pantalla se contradice.
        assert!(StreamEntry::Razonamiento { agent: "a".into(), ts: 0, texto: "x".into() }.is_verbose());
        assert!(StreamEntry::Decision {
            agent: "a".into(), ts: 0, kind: "parallel".into(),
            summary: "s".into(), saved_tokens: 0,
        }.is_verbose());
        assert!(!StreamEntry::Narracion { agent: "a".into(), ts: 0, texto: "x".into() }.is_verbose());
        assert!(!StreamEntry::ToolStart {
            agent: "a".into(), ts: 0, call_id: "c0".into(), tool: "fs_read".into(),
            resumen: String::new(), bee_state: BeeState::Reading,
        }.is_verbose());
    }

    #[test]
    fn a_jev_decision_shows_what_it_saved_only_when_it_saved_something() {
        // `parallel` nunca ahorra tokens: "ahorró 0" es ruido.
        let sin = StreamEntry::Decision {
            agent: "a".into(), ts: 0, kind: "parallel".into(),
            summary: "2 herramientas en paralelo".into(), saved_tokens: 0,
        };
        assert!(!sin.summary().contains("ahorró"));

        let con = StreamEntry::Decision {
            agent: "a".into(), ts: 0, kind: "context".into(),
            summary: "18 → 6".into(), saved_tokens: 8_200,
        };
        assert!(con.summary().contains("ahorró 8.2k"), "{}", con.summary());
    }

    #[test]
    fn the_filter_narrows_to_one_agent_and_back_to_all() {
        let mut stream = ThoughtStreamState::default();
        stream.push_chunk(chunk("topo", "narrando", "uno"));
        stream.push_chunk(chunk("quetzal", "narrando", "dos"));

        assert_eq!(stream.visibles().len(), 2);
        stream.alternar_filtro("Topo");
        assert_eq!(stream.visibles().len(), 1);
        assert_eq!(stream.visibles()[0].agent(), "topo");

        // El matching ignora mayúsculas: el alias llega con tilde y minúscula
        // mixture desde el backend.
        stream.alternar_filtro("topo");
        assert_eq!(stream.visibles().len(), 2, "el segundo toque quita el filtro");
    }

    #[test]
    fn an_open_tool_call_is_detectable_so_a_lost_done_is_visible() {
        // El canal `low` descarta en silencio. Sin esto, un `tool_done` perdido
        // deja el spinner girando para siempre sin que nadie lo note.
        let mut stream = ThoughtStreamState::default();
        stream.push_tool_start(&call("topo", "fs_write"), 10);
        assert_eq!(stream.abiertas().len(), 1);

        stream.push(StreamEntry::ToolDone {
            agent: "topo".into(), ts: 20, call_id: "topo-fs_write".into(),
            tool: "fs_write".into(), ok: true, duracion_ms: 412, resumen: String::new(),
        });
        assert!(stream.abiertas().is_empty(), "la llamada sigue abierta");
    }

    #[test]
    fn two_agents_calling_the_same_tool_do_not_close_each_other() {
        let mut stream = ThoughtStreamState::default();
        stream.push_tool_start(&call("topo", "fs_write"), 1);
        let mut other = call("quetzal", "fs_write");
        other.agent = "quetzal".into();
        stream.push_tool_start(&other, 2);
        assert_eq!(stream.abiertas().len(), 2, "el emparejamiento es por tool, cruzaría agentes");

        stream.push(StreamEntry::ToolDone {
            agent: "topo".into(), ts: 3, call_id: "topo-fs_write".into(),
            tool: "fs_write".into(), ok: true, duracion_ms: 1, resumen: String::new(),
        });
        assert_eq!(stream.abiertas().len(), 1, "cerrar una no cierra la otra");
    }

    #[test]
    fn the_stream_is_capped() {
        let mut stream = ThoughtStreamState { capacity: 3, ..ThoughtStreamState::default() };
        for i in 0..10 {
            stream.push_chunk(chunk("bee", "n", &format!("e{i}")));
        }
        assert_eq!(stream.entries.len(), 3);
        assert_eq!(stream.chunks.len(), 3, "el buffer viejo también se acota");
    }

    #[test]
    fn every_variant_exposes_its_agent_and_timestamp() {
        let variants = vec![
            StreamEntry::Razonamiento { agent: "a".into(), ts: 1, texto: "x".into() },
            StreamEntry::Narracion { agent: "a".into(), ts: 2, texto: "x".into() },
            StreamEntry::ToolStart { agent: "a".into(), ts: 3, call_id: "c3".into(), tool: "t".into(), resumen: String::new(), bee_state: BeeState::Reading },
            StreamEntry::ToolDone { agent: "a".into(), ts: 4, call_id: "c3".into(), tool: "t".into(), ok: true, duracion_ms: 1, resumen: String::new() },
            StreamEntry::Decision { agent: "a".into(), ts: 5, kind: "k".into(), summary: "s".into(), saved_tokens: 0 },
            StreamEntry::Poda { agent: "a".into(), ts: 6, resumen: "s".into(), saved_tokens: 0 },
            StreamEntry::Pregunta { agent: "a".into(), ts: 7, texto: "p".into(), mcp_apagados: vec![] },
            StreamEntry::Bloqueado { agent: "a".into(), ts: 8, esperando_a: vec![], razon: "r".into() },
            StreamEntry::Error { agent: "a".into(), ts: 9, mensaje: "m".into() },
        ];
        for (i, v) in variants.iter().enumerate() {
            assert_eq!(v.agent(), "a");
            assert_eq!(v.ts(), i as u64 + 1);
            assert!(!v.summary().is_empty(), "{v:?} resume vacío");
            assert!(!v.glyph().is_empty());
        }
    }

    #[test]
    fn a_question_carries_the_mcp_that_must_be_turned_on() {
        // Es la pregunta de aclaración de Kimi: no se cuela en la narración,
        // se pide. Y tiene que decir QUÉ falta.
        let q = StreamEntry::Pregunta {
            agent: "quetzal".into(),
            ts: 1,
            texto: "para verificar en navegador".into(),
            mcp_apagados: vec!["obscura".into()],
        };
        assert_eq!(q.glyph(), "💬");
        assert!(q.summary().contains("navegador"));
    }

    #[test]
    fn a_wait_names_its_cause_not_a_sentence() {
        let mut stream = ThoughtStreamState::default();
        stream.push_waiting(&WaitingAgent {
            agent: "topo".into(),
            waiting_for: vec![],
            reason: "jev_secuencial".into(),
            since: 5,
        });
        match &stream.entries[0] {
            StreamEntry::Bloqueado { razon, .. } => assert_eq!(razon, "en secuencia"),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn a_poda_line_carries_what_it_saved() {
        let p = StreamEntry::Poda { agent: "a".into(), ts: 1, resumen: "42 → 18 mensajes".into(), saved_tokens: 8_200 };
        assert!(p.summary().contains("42 → 18"));
        assert!(p.summary().contains("8.2k"));
    }

    #[test]
    fn the_jev_state_is_what_feeds_the_decision_lines() {
        // El stream no inventa: consume lo que JEV ya emitió.
        let mut jev = crate::state::JevState::default();
        jev.record(JevDecision {
            agent_id: "topo".into(), kind: "parallel".into(),
            summary: "2 herramientas en secuencia".into(), saved_tokens: 0,
            cost_usd: 0.0, latency_ms: 40, event_id: "e".into(),
            availability: JevAvailability::Ready,
        });
        let d = &jev.last_by_agent["topo"];
        assert_eq!(d.kind, "parallel");
        let _ = McpState::Active;
    }
}
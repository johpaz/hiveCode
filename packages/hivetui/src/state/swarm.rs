//! Telemetría del enjambre: qué herramienta está corriendo cada agente y qué
//! agente está esperando a qué.
//!
//! Hasta ahora la TUI recibía `current_action`, un texto libre que el backend
//! llenaba con `"ejecutando <phase>"` — no decía qué herramienta corría, ni
//! cuánto duraba, ni por qué un agente se detendría. Estos eventos son el
//! pulso real del enjambre.
//!
//! El par `tool_call` / `tool_done` se empareja por `call_id`. Eso importa:
//! `call_id` es la única forma de saber que una llamada **empezó** sin cerrar,
//! lo que la distingue de una que terminó de verdad y de una que se perdió.

use std::collections::HashMap;

/// Actividad legible de un agente, reutilizando la clasificación que ya existía
/// en el backend (`toolToBeeState`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BeeState {
    Thinking,
    Searching,
    Reading,
    Writing,
    Executing,
    Done,
    Error,
    Unknown,
}

impl BeeState {
    pub fn from_str(raw: &str) -> Self {
        match raw {
            "thinking" => BeeState::Thinking,
            "searching" => BeeState::Searching,
            "reading" => BeeState::Reading,
            "writing" => BeeState::Writing,
            "executing" => BeeState::Executing,
            "done" => BeeState::Done,
            "error" => BeeState::Error,
            _ => BeeState::Unknown,
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            BeeState::Reading => "◍",
            BeeState::Writing => "✎",
            BeeState::Executing => "⚙",
            BeeState::Searching => "⌕",
            BeeState::Thinking => "◐",
            BeeState::Done => "✓",
            BeeState::Error => "✗",
            // Un estado desconocido no debe inventarse: se muestra como
            // actividad genérica, nunca como un error.
            BeeState::Unknown => "◌",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            BeeState::Reading => "leyendo",
            BeeState::Writing => "escribiendo",
            BeeState::Executing => "ejecutando",
            BeeState::Searching => "buscando",
            BeeState::Thinking => "pensando",
            BeeState::Done => "listo",
            BeeState::Error => "falló",
            BeeState::Unknown => "activo",
        }
    }

    /// Color de la actividad. Vive aquí y no en el widget porque el mismo
    /// estado se pinta igual en la tarjeta del enjambre y en el stream de MESA.
    pub fn color(self) -> crate::term::Color {
        use crate::term::{AMBER, BLUE, CYAN, GREEN, RED, SECONDARY, WHITE};
        match self {
            BeeState::Reading => CYAN,
            BeeState::Writing => AMBER,
            BeeState::Executing => BLUE,
            BeeState::Searching => SECONDARY,
            BeeState::Error => RED,
            BeeState::Done => GREEN,
            BeeState::Thinking | BeeState::Unknown => WHITE,
        }
    }
}

/// Una llamada en vuelo.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub call_id: String,
    pub agent: String,
    pub tool: String,
    pub args_summary: String,
    pub bee_state: BeeState,
    /// Reloj del backend al empezar. No es local a propósito: comparar contra
    /// un reloj de la TUI daría duraciones negativas si los dos procesos no
    /// comparten reloj.
    pub started_at: u64,
    /// `true` una vez que llegó su `tool_done`. Una llamada que queda en `false`
    /// para siempre es una llamada **perdida**, y la UI debe poder decirlo en
    /// vez de mostrar un spinner eterno.
    pub settled: bool,
    pub ok: Option<bool>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct WaitingAgent {
    pub agent: String,
    pub waiting_for: Vec<String>,
    pub reason: String,
    pub since: u64,
}

impl WaitingAgent {
    /// Etiqueta legible del motivo. Se agrupa por etiqueta, no por frase, para
    /// que varios agentes esperando lo mismo se vean como una sola causa.
    pub fn reason_label(&self) -> &'static str {
        match self.reason.as_str() {
            "jev_secuencial" => "en secuencia",
            "subagente" => "esperando subagente",
            "dependencia" => "esperando dependencia",
            "turno" => "esperando turno",
            _ => "en espera",
        }
    }
}

#[derive(Debug, Clone)]
pub struct SwarmState {
    /// Llamadas en vuelo por `call_id`.
    pub in_flight: HashMap<String, ToolCall>,
    /// Agentes que no pueden avanzar, por agente.
    pub waiting: HashMap<String, WaitingAgent>,
    /// Historial de llamadas cerradas, acotado. Alimenta el stream de MESA.
    pub history: Vec<ToolCall>,
    pub history_capacity: usize,
    /// Última tool por agente, para la tarjeta del enjambre sin historial.
    pub last_tool: HashMap<String, ToolCall>,
}

impl Default for SwarmState {
    fn default() -> Self {
        SwarmState {
            in_flight: HashMap::new(),
            waiting: HashMap::new(),
            history: Vec::new(),
            history_capacity: 200,
            last_tool: HashMap::new(),
        }
    }
}

impl SwarmState {
    pub fn start_call(&mut self, call: ToolCall) {
        self.last_tool.insert(call.agent.clone(), call.clone());
        self.in_flight.insert(call.call_id.clone(), call);
    }

    /// Cierra una llamada. Si el `call_id` no estaba en vuelo, la llamada se
    /// perdió en el transporte: se registra igual en el historial, marcada como
    /// no liquidada, en vez de inventar una duración.
    pub fn settle_call(&mut self, call_id: &str, ok: bool, duration_ms: u64) -> bool {
        let Some(mut call) = self.in_flight.remove(call_id) else {
            return false;
        };
        call.settled = true;
        call.ok = Some(ok);
        call.duration_ms = Some(duration_ms);
        if let Some(last) = self.last_tool.get_mut(&call.agent) {
            if last.call_id == call.call_id {
                *last = call.clone();
            }
        }
        self.push_history(call);
        true
    }

    fn push_history(&mut self, call: ToolCall) {
        self.history.push(call);
        if self.history.len() > self.history_capacity {
            let excess = self.history.len() - self.history_capacity;
            self.history.drain(0..excess);
        }
    }

    /// Marca un agente como en espera. Repetir el mismo motivo no crea entradas
    /// nuevas: la UI solo necesita "este agente espera por esto", no un log.
    pub fn set_waiting(&mut self, waiting: WaitingAgent) {
        if let Some(existing) = self.waiting.get(&waiting.agent) {
            if existing.reason == waiting.reason && existing.waiting_for == waiting.waiting_for {
                return;
            }
        }
        self.waiting.insert(waiting.agent.clone(), waiting);
    }

    /// El agente volvió a avanzar.
    pub fn clear_waiting(&mut self, agent: &str) {
        self.waiting.remove(agent);
    }

    /// Llamadas que ROC no cerró. Un `tool_done` perdido deja el spinner
    /// girando para siempre; contarlas permite dizerlo en voz alta.
    pub fn orphaned_calls(&self) -> usize {
        self.in_flight.len()
    }

    /// Duración de una llamada en vuelo, o `None` si no está.
    pub fn elapsed_ms(&self, call_id: &str, now_ms: u64) -> Option<u64> {
        self.in_flight
            .get(call_id)
            .map(|c| now_ms.saturating_sub(c.started_at))
    }

    /// Llamadas en vuelo de un agente.
    pub fn calls_for(&self, agent: &str) -> Vec<&ToolCall> {
        self.in_flight.values().filter(|c| c.agent == agent).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(id: &str, agent: &str, tool: &str, at: u64) -> ToolCall {
        ToolCall {
            call_id: id.to_string(),
            agent: agent.to_string(),
            tool: tool.to_string(),
            args_summary: String::new(),
            bee_state: BeeState::Reading,
            started_at: at,
            settled: false,
            ok: None,
            duration_ms: None,
        }
    }

    #[test]
    fn a_call_starts_in_flight_and_leaves_when_settled() {
        let mut swarm = SwarmState::default();
        swarm.start_call(call("c1", "topo", "fs_read", 1_000));

        assert_eq!(swarm.orphaned_calls(), 1);
        assert_eq!(swarm.elapsed_ms("c1", 1_400), Some(400));

        assert!(swarm.settle_call("c1", true, 412));
        assert_eq!(swarm.orphaned_calls(), 0);
        assert_eq!(swarm.history.len(), 1);
        assert_eq!(swarm.history[0].duration_ms, Some(412));
        assert_eq!(swarm.history[0].ok, Some(true));
    }

    #[test]
    fn a_done_without_a_call_is_reported_not_silently_invented() {
        // El canal `low` descarta con `try_send`. Si un `tool_done` se pierde,
        // la llamada queda en vuelo para siempre y el spinner miente.
        let mut swarm = SwarmState::default();
        swarm.start_call(call("c1", "topo", "fs_read", 0));
        swarm.settle_call("c1", true, 10);

        assert!(!swarm.settle_call("perdido", true, 20));
        assert_eq!(swarm.history.len(), 1, "no se fabrica una duración inexistente");
    }

    #[test]
    fn lost_calls_are_visible_instead_of_spinning_forever() {
        let mut swarm = SwarmState::default();
        swarm.start_call(call("c1", "topo", "fs_read", 0));
        swarm.start_call(call("c2", "quetzal", "shell_executor", 0));
        swarm.settle_call("c1", true, 5);

        assert_eq!(swarm.orphaned_calls(), 1, "c2 nunca cerró");
        assert_eq!(swarm.calls_for("quetzal").len(), 1);
        assert_eq!(swarm.calls_for("topo").len(), 0);
    }

    #[test]
    fn repeating_the_same_wait_is_not_duplicated() {
        let mut swarm = SwarmState::default();
        let w = WaitingAgent {
            agent: "topo".to_string(),
            waiting_for: vec![],
            reason: "jev_secuencial".to_string(),
            since: 0,
        };
        swarm.set_waiting(w.clone());
        swarm.set_waiting(w.clone());
        assert_eq!(swarm.waiting.len(), 1);

        // Un motivo distinto sí reemplaza: la causa cambió.
        swarm.set_waiting(WaitingAgent { reason: "subagente".to_string(), ..w });
        assert_eq!(swarm.waiting.len(), 1);
        assert_eq!(swarm.waiting["topo"].reason_label(), "esperando subagente");
    }

    #[test]
    fn moving_forward_clears_the_wait() {
        let mut swarm = SwarmState::default();
        swarm.set_waiting(WaitingAgent {
            agent: "topo".to_string(),
            waiting_for: vec!["condor".to_string()],
            reason: "dependencia".to_string(),
            since: 0,
        });
        assert!(swarm.waiting.contains_key("topo"));

        swarm.clear_waiting("topo");
        assert!(!swarm.waiting.contains_key("topo"));
    }

    #[test]
    fn a_call_that_moves_on_updates_the_last_tool_of_the_agent() {
        let mut swarm = SwarmState::default();
        swarm.start_call(call("c1", "topo", "fs_read", 0));
        swarm.settle_call("c1", true, 10);
        swarm.start_call(call("c2", "topo", "fs_write", 20));

        // La tarjeta del enjambre muestra la última tool, con su resultado.
        let last = &swarm.last_tool["topo"];
        assert_eq!(last.tool, "fs_write");
        assert!(!last.settled);
    }

    #[test]
    fn history_is_capped() {
        let mut swarm = SwarmState { history_capacity: 3, ..SwarmState::default() };
        for i in 0..10 {
            swarm.start_call(call(&format!("c{i}"), "topo", "fs_read", i));
            swarm.settle_call(&format!("c{i}"), true, 1);
        }
        assert_eq!(swarm.history.len(), 3);
    }

    #[test]
    fn an_unknown_bee_state_reads_as_active_never_as_an_error() {
        // Un estado no reconocido no debe aparecer como fallo.
        assert_eq!(BeeState::from_str("banana"), BeeState::Unknown);
        assert_ne!(BeeState::Unknown.glyph(), BeeState::Error.glyph());
        assert_eq!(BeeState::Unknown.label(), "activo");
    }

    #[test]
    fn elapsed_never_goes_negative_across_processes() {
        // El reloj del backend y el de la TUI pueden no coincidir. `saturating_sub`
        // evita mostrar "-3s".
        let mut swarm = SwarmState::default();
        swarm.start_call(call("c1", "topo", "fs_read", 5_000));
        assert_eq!(swarm.elapsed_ms("c1", 4_000), Some(0));
    }
}
//! Estado del plano de decisión (Jev) en la TUI.
//!
//! Jev ya emitía `jev:decision` y `jev:status` en el event bus del backend y
//! nadie estaba suscrito, así que el rastro completo de decisiones —qué podó,
//! cuántos tokens ahorró, si las herramientas pueden ir en paralelo— se
//! calculaba y se descartaba. Acá se conserva.
//!
//! `JevDecision` alimenta el stream de narración de MESA (Capa 6) y el bloque
//! "última decisión" de la ficha del especialista (Capa 3). `JevStatus` alimenta
//! el punto de disponibilidad del statusbar.

use crate::ipc::IpcJevTotals;

/// Capacidad del oráculo.
///
/// `off` significa "no configurado" y **no** es un error: el sistema funciona
/// igual sin él. `fallback` significa que está enfriándose tras fallos y sí
/// merece una advertencia.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JevAvailability {
    Off,
    Ready,
    Fallback,
}

impl JevAvailability {
    pub fn from_str(raw: &str) -> Self {
        match raw {
            "ready" => JevAvailability::Ready,
            "fallback" => JevAvailability::Fallback,
            // `off` y cualquier valor desconocido: no configurado.
            _ => JevAvailability::Off,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            JevAvailability::Off => "oráculo apagado",
            JevAvailability::Ready => "oráculo",
            JevAvailability::Fallback => "oráculo enfriando",
        }
    }

    /// `off` es DIM a propósito: no configurado no es una avería y no debe
    /// aparecer en ámbar ni en rojo junto a errores reales.
    pub fn color(self) -> crate::term::Color {
        match self {
            JevAvailability::Off => crate::term::DIM,
            JevAvailability::Ready => crate::term::GREEN,
            JevAvailability::Fallback => crate::term::YELLOW,
        }
    }

    pub fn glyph(self) -> &'static str {
        match self {
            JevAvailability::Off => "·",
            JevAvailability::Ready => "●",
            JevAvailability::Fallback => "⚠",
        }
    }

    pub fn is_configured(self) -> bool {
        !matches!(self, JevAvailability::Off)
    }
}

/// Una decisión servida por el oráculo.
#[derive(Debug, Clone)]
pub struct JevDecision {
    pub agent_id: String,
    /// "context" (podar + delegar), "parallel", "iteration".
    pub kind: String,
    pub summary: String,
    pub saved_tokens: u64,
    pub cost_usd: f64,
    pub latency_ms: u64,
    /// Id estable del evento, para deduplicar.
    pub event_id: String,
    /// Último `jev_status` conocido, para opcionalidad.
    pub availability: JevAvailability,
}

impl JevDecision {
    /// Una decisión que no ahorró nada (p. ej. `parallel` es siempre 0) no
    /// necesita mostrar el contador de ahorro.
    pub fn saved_tokens_display(&self) -> Option<String> {
        if self.saved_tokens == 0 {
            None
        } else {
            Some(crate::ui::terminal_primitives::fmt_tokens(self.saved_tokens))
        }
    }
}

/// Acumulado del oráculo para la corrida.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct JevTotals {
    pub decisions: u64,
    pub saved_tokens: u64,
    pub cost_usd: f64,
}

impl From<&IpcJevTotals> for JevTotals {
    fn from(t: &IpcJevTotals) -> Self {
        JevTotals {
            decisions: t.decisions,
            saved_tokens: t.saved_tokens,
            cost_usd: t.cost_usd,
        }
    }
}

#[derive(Debug, Clone)]
pub struct JevState {
    pub availability: JevAvailability,
    pub last_error: Option<String>,
    pub last_success_at: Option<u64>,
    pub totals: JevTotals,
    /// Última decisión por agente, para el bloque "última decisión" de la ficha.
    pub last_by_agent: std::collections::HashMap<String, JevDecision>,
    /// Historial global, acotado. MESA lo lee; el cap evita que una sesión
    /// larga crezca sin límite.
    pub decisions: Vec<JevDecision>,
    pub capacity: usize,
}

impl Default for JevState {
    fn default() -> Self {
        // `off` hasta que el backend anuncie su estado: antes de ese primer
        // mensaje no se sabe nada, y "no configurado" es la lectura correcta.
        JevState {
            availability: JevAvailability::Off,
            last_error: None,
            last_success_at: None,
            totals: JevTotals::default(),
            last_by_agent: std::collections::HashMap::new(),
            decisions: Vec::new(),
            capacity: 200,
        }
    }
}

impl JevState {
    pub fn record(&mut self, decision: JevDecision) {
        self.last_by_agent
            .insert(decision.agent_id.clone(), decision.clone());
        self.decisions.push(decision);
        if self.decisions.len() > self.capacity {
            let excess = self.decisions.len() - self.capacity;
            self.decisions.drain(0..excess);
        }
    }

    pub fn set_availability(&mut self, availability: JevAvailability, last_error: Option<String>, last_success_at: Option<u64>, totals: JevTotals) {
        self.availability = availability;
        self.last_error = last_error;
        self.last_success_at = last_success_at;
        self.totals = totals;
    }

    /// Resumen para el statusbar: "● oráculo · 12 decisiones · ahorró 48.2k".
    /// Devuelve `None` cuando no está configurado, para que el statusbar no
    /// gaste ancho en un oráculo que el usuario no activó.
    pub fn statusbar_summary(&self) -> Option<String> {
        if !self.availability.is_configured() {
            return None;
        }
        let mut s = String::new();
        s.push_str(self.availability.label());
        if self.totals.decisions > 0 {
            s.push_str(&format!(" · {} dec", self.totals.decisions));
        }
        if self.totals.saved_tokens > 0 {
            s.push_str(&format!(
                " · ahorró {}",
                crate::ui::terminal_primitives::fmt_tokens(self.totals.saved_tokens)
            ));
        }
        Some(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decision(agent: &str, kind: &str, saved: u64) -> JevDecision {
        JevDecision {
            agent_id: agent.to_string(),
            kind: kind.to_string(),
            summary: "resumen".to_string(),
            saved_tokens: saved,
            cost_usd: 0.0001,
            latency_ms: 42,
            event_id: "jev:1".to_string(),
            availability: JevAvailability::Ready,
        }
    }

    #[test]
    fn off_is_not_an_error() {
        // El caso que el plan marca como riesgo: "no configurado" no puede
        // pintarse igual que "enfriándose".
        assert_eq!(JevAvailability::from_str("off"), JevAvailability::Off);
        assert_ne!(
            JevAvailability::Off.color(),
            JevAvailability::Fallback.color()
        );
        assert!(!JevAvailability::Off.is_configured());
        assert!(JevAvailability::Fallback.is_configured());
    }

    #[test]
    fn an_unknown_state_degrades_to_off_rather_than_panicking() {
        assert_eq!(JevAvailability::from_str("banana"), JevAvailability::Off);
        assert_eq!(JevAvailability::from_str(""), JevAvailability::Off);
    }

    #[test]
    fn the_statusbar_stays_silent_while_jev_is_off() {
        // Si el oráculo no está configurado, el statusbar no debe gastar ancho.
        let mut state = JevState::default();
        assert!(state.statusbar_summary().is_none());

        state.set_availability(
            JevAvailability::Ready,
            None,
            Some(1),
            JevTotals { decisions: 3, saved_tokens: 4800, cost_usd: 0.01 },
        );
        let summary = state.statusbar_summary().expect("oráculo activo debe resumirse");
        assert!(summary.contains("oráculo"));
        assert!(summary.contains("3 dec"));
        assert!(summary.contains("ahorró"));
    }

    #[test]
    fn the_history_is_capped_so_a_long_session_cannot_grow_unbounded() {
        let mut state = JevState { capacity: 3, ..JevState::default() };
        for i in 0..10 {
            state.record(decision("topo", "parallel", 0));
            let _ = i;
        }
        assert_eq!(state.decisions.len(), 3);
    }

    #[test]
    fn the_last_decision_per_agent_survives_the_history_cap() {
        let mut state = JevState { capacity: 2, ..JevState::default() };
        state.record(decision("topo", "context", 9000));
        state.record(decision("quetzal", "context", 500));
        state.record(decision("ocelote", "parallel", 0));

        // Aunque las antiguas salieron del historial, la ficha de cada agente
        // sigue sabiendo qué decidió la última vez.
        let topo = state.last_by_agent.get("topo").expect("topo");
        assert_eq!(topo.saved_tokens, 9000);
        assert_eq!(topo.saved_tokens_display().as_deref(), Some("9.0k"));
        assert!(state.last_by_agent.contains_key("quetzal"));
        assert!(state.last_by_agent.contains_key("ocelote"));
    }

    #[test]
    fn a_decision_with_no_saving_hides_the_counter() {
        // `parallel` nunca ahorra tokens; mostrar "ahorró 0" sería ruido.
        assert!(decision("topo", "parallel", 0).saved_tokens_display().is_none());
        assert!(decision("topo", "context", 1500).saved_tokens_display().is_some());
    }
}
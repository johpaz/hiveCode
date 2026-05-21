use crate::app::{AppState, MascotState};
use crate::term::{Canvas, Rect, Style, AMBER, DIM, GREEN, RED};
use crossterm::style::Color;

// Frames de animación por estado — mismos que antes
const THINKING_FRAMES:  &[&str] = &["(~•~)", "(~-~)", "(~•~)", "(>•<)"];
const SEARCHING_FRAMES: &[&str] = &["(o•-)", "(-•o)", "(o•-)", "(-•-)"];
const READING_FRAMES:   &[&str] = &["(^•^)", "(^-^)", "(^•^)", "(^_^)"];
const WRITING_FRAMES:   &[&str] = &["(>•<)", "(>-<)", "(>•<)", "(>•.)"];
const EXECUTING_FRAMES: &[&str] = &["(•ᴗ•)", "(•ᴗ-)", "(-ᴗ•)", "(•ᴗ•)"];

/// Dibuja la mascota animada en la esquina inferior derecha del rect.
///
/// ## Por qué recibe `rect` en lugar de calcular la posición interna:
/// ─────────────────────────────────────────────────────────────────────
/// El widget NO sabe dónde vive en la pantalla. Solo sabe que puede usar
/// el espacio dentro de `rect`. El layout en screens/repl.rs decide qué
/// parte de la pantalla le corresponde a cada widget.
/// Esta separación permite mover la mascota sin tocar este archivo.
pub fn draw(canvas: &mut Canvas, state: &AppState, rect: Rect) {
    let fi = state.animation_frame as usize;

    let (face, color): (&str, Color) = match state.mascot_state {
        MascotState::Welcome   => ("\\(^•^)/", AMBER),
        MascotState::Thinking  => (THINKING_FRAMES[fi % THINKING_FRAMES.len()],   state.coordinator_color()),
        MascotState::Searching => (SEARCHING_FRAMES[fi % SEARCHING_FRAMES.len()], Color::Rgb(96, 165, 250)),
        MascotState::Reading   => (READING_FRAMES[fi % READING_FRAMES.len()],     Color::Rgb(167, 243, 208)),
        MascotState::Writing   => (WRITING_FRAMES[fi % WRITING_FRAMES.len()],     Color::Rgb(196, 181, 253)),
        MascotState::Executing => (EXECUTING_FRAMES[fi % EXECUTING_FRAMES.len()], Color::Rgb(252, 211, 77)),
        MascotState::Completed => ("(★•★)", GREEN),
        MascotState::Error     => ("(x•x)", RED),
        MascotState::Idle      => ("(-•-)", DIM),
        MascotState::PlanMode  => ("(o•o)", Color::Rgb(196, 181, 253)),
        MascotState::Approval  => ("(?•?)", Color::Rgb(252, 211, 77)),
    };

    let style = Style::new().fg(color).bold();

    // Posición: esquina inferior derecha del rect, sin sobrepasar el borde.
    // `chars().count()` cuenta caracteres Unicode (no bytes) — correcto para
    // caracteres multi-byte como • ★ ᴗ que ocupan 1 celda de terminal pero
    // múltiples bytes en UTF-8.
    let text_w = face.chars().count() as u16;
    let x = rect.right().saturating_sub(text_w + 1);
    let y = rect.bottom().saturating_sub(1);

    canvas.print(x, y, face, style);
}

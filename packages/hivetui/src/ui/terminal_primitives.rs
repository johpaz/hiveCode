#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OutputKind {
    Success,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SpinnerStopKind {
    Done,
    Warn,
    Error,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionModeLabel {
    Plan,
    Approval,
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ansi;

impl Ansi {
    pub const AMBER: &'static str = "\x1b[38;5;214m";
    pub const AMBER_DIM: &'static str = "\x1b[38;5;172m";
    pub const GREEN: &'static str = "\x1b[38;5;114m";
    pub const RED: &'static str = "\x1b[38;5;203m";
    pub const BLUE: &'static str = "\x1b[38;5;111m";
    pub const PURPLE: &'static str = "\x1b[38;5;141m";
    pub const CYAN: &'static str = "\x1b[38;5;116m";
    pub const WHITE: &'static str = "\x1b[38;5;252m";
    pub const DIM: &'static str = "\x1b[2m";
    pub const BOLD: &'static str = "\x1b[1m";
    pub const RESET: &'static str = "\x1b[0m";
    pub const CLEAR_LINE: &'static str = "\x1b[2K\r";
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Symbols;

impl Symbols {
    pub const ACTIVE: &'static str = "⬡";
    pub const DONE: &'static str = "⬢";
    pub const ERROR: &'static str = "✗";
    pub const WARN: &'static str = "▲";
    pub const BAR: &'static str = "│";
    pub const BAR_END: &'static str = "└";
    pub const BULLET: &'static str = "▸";
    pub const DOT: &'static str = "·";
    pub const CHECK: &'static str = "✓";
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Mascot;

impl Mascot {
    pub const HAPPY: &'static str = "\\(^ᴗ^)/";
    pub const THINKING: &'static str = " (~ᴗ~) ";
    pub const DONE: &'static str = " (★ᴗ★)";
    pub const ERROR: &'static str = " (×ᴗ×)";
    pub const IDLE: &'static str = " (-ᴗ-) ";
    pub const PLAN: &'static str = " (oᴗo)";
    pub const WAITING: &'static str = " (?ᴗ?) ";
    pub const NEUTRAL: &'static str = " (·ᴗ·)";
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectOption {
    pub value: String,
    pub label: String,
    pub disabled: bool,
}

impl SelectOption {
    pub fn new(value: impl Into<String>, label: impl Into<String>) -> Self {
        Self {
            value: value.into(),
            label: label.into(),
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextPrompt<'a> {
    pub message: &'a str,
    pub value: &'a str,
    pub placeholder: Option<&'a str>,
    pub password: bool,
    pub error: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SelectPrompt<'a> {
    pub message: &'a str,
    pub options: &'a [SelectOption],
    pub cursor: usize,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfirmPrompt<'a> {
    pub message: &'a str,
    pub active: &'a str,
    pub inactive: &'a str,
    pub value: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CompletedCheckpoint {
    pub files_created: Vec<String>,
    pub files_modified: Vec<String>,
    pub summary: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UpcomingCheckpoint {
    pub coordinator: String,
    pub will_create: Vec<CheckpointFileCreate>,
    pub will_modify: Vec<CheckpointFileModify>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFileCreate {
    pub path: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointFileModify {
    pub path: String,
    pub lines: String,
    pub reason: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CheckpointPrompt {
    pub phase_number: usize,
    pub total_phases: usize,
    pub completed: Option<CompletedCheckpoint>,
    pub upcoming: UpcomingCheckpoint,
}

pub fn coordinator_ansi(coordinator: &str) -> &'static str {
    match coordinator {
        "architecture" => Ansi::PURPLE,
        "backend" => Ansi::BLUE,
        "frontend" => Ansi::CYAN,
        "security" => Ansi::RED,
        "test" => Ansi::GREEN,
        "devops" => Ansi::AMBER_DIM,
        "principal" => Ansi::AMBER,
        _ => Ansi::DIM,
    }
}

pub fn bar(coordinator: &str) -> String {
    format!("{}{}{}", coordinator_ansi(coordinator), Symbols::BAR, Ansi::RESET)
}

pub fn empty_line(coordinator: &str) -> String {
    format!(" {}", bar(coordinator))
}

pub fn intro(title: &str) -> String {
    format!(
        "\n {} {}{}{}{}\n {}{}{}\n",
        Mascot::HAPPY,
        Ansi::BOLD,
        Ansi::AMBER,
        title,
        Ansi::RESET,
        Ansi::AMBER,
        Symbols::BAR,
        Ansi::RESET
    )
}

pub fn outro(message: &str, kind: OutputKind) -> String {
    let (color, symbol) = match kind {
        OutputKind::Success => (Ansi::GREEN, Symbols::CHECK),
        OutputKind::Error => (Ansi::RED, Symbols::ERROR),
    };
    format!(
        " {}{}{} {}{}{} {}\n\n",
        Ansi::AMBER,
        Symbols::BAR_END,
        Ansi::RESET,
        color,
        symbol,
        Ansi::RESET,
        message
    )
}

pub fn mode_bar(mode: SessionModeLabel) -> String {
    let label = match mode {
        SessionModeLabel::Plan => format!("{}PLAN{}", Ansi::PURPLE, Ansi::RESET),
        SessionModeLabel::Approval => format!("{}APROBACIÓN{}", Ansi::AMBER, Ansi::RESET),
        SessionModeLabel::Auto => format!("{}AUTO{}", Ansi::GREEN, Ansi::RESET),
    };
    format!(
        " {} Modo: {} {}[shift+tab para cambiar]{}\n {}\n",
        bar("default"),
        label,
        Ansi::DIM,
        Ansi::RESET,
        bar("default")
    )
}

pub fn phase_complete(summary: &str) -> String {
    format!(" {} {}{}{}\n", Mascot::DONE, Ansi::WHITE, summary, Ansi::RESET)
}

pub fn phase_active(coordinator: &str, message: &str) -> String {
    format!(
        " {}{}{} {}{}{}\n",
        coordinator_ansi(coordinator),
        Symbols::ACTIVE,
        Ansi::RESET,
        Ansi::DIM,
        message,
        Ansi::RESET
    )
}

pub fn note(title: &str, lines: &[impl AsRef<str>]) -> String {
    let width = lines
        .iter()
        .map(|line| line.as_ref().chars().count() + 4)
        .chain(std::iter::once(title.chars().count() + 4))
        .max()
        .unwrap_or(44)
        .max(44);
    let top_rule = "─".repeat(width.saturating_sub(title.chars().count() + 4));
    let bottom_rule = "─".repeat(width);
    let mut out = format!(
        "\n ┌─ {}{}{} {}┐\n",
        Ansi::AMBER,
        title,
        Ansi::RESET,
        top_rule
    );

    for line in lines {
        let line = line.as_ref();
        let padding = " ".repeat(width.saturating_sub(line.chars().count() + 2));
        out.push_str(&format!(
            " {}{}{} {}{}{}{}{}\n",
            Ansi::DIM,
            Symbols::BAR,
            Ansi::RESET,
            line,
            padding,
            Ansi::DIM,
            Symbols::BAR,
            Ansi::RESET
        ));
    }
    out.push_str(&format!(" └{}┘\n\n", bottom_rule));
    out
}

pub fn spinner_frame(coordinator: &str, tick: usize, message: &str) -> String {
    const FRAMES: [&str; 3] = [Mascot::THINKING, Mascot::PLAN, Mascot::THINKING];
    let frame = FRAMES[tick % FRAMES.len()];
    format!(
        "{} {}{}{} {}{}{}",
        Ansi::CLEAR_LINE,
        coordinator_ansi(coordinator),
        frame,
        Ansi::RESET,
        Ansi::DIM,
        message,
        Ansi::RESET
    )
}

pub fn spinner_stop(coordinator: &str, message: &str, kind: SpinnerStopKind) -> String {
    let symbol = match kind {
        SpinnerStopKind::Done => Symbols::DONE,
        SpinnerStopKind::Warn => Symbols::WARN,
        SpinnerStopKind::Error => Symbols::ERROR,
    };
    let msg_color = match kind {
        SpinnerStopKind::Done => Ansi::WHITE,
        SpinnerStopKind::Warn => Ansi::AMBER,
        SpinnerStopKind::Error => Ansi::RED,
    };
    format!(
        "{} {}{}{} {}{}{}\n",
        Ansi::CLEAR_LINE,
        coordinator_ansi(coordinator),
        symbol,
        Ansi::RESET,
        msg_color,
        message,
        Ansi::RESET
    )
}

pub fn render_text_prompt(prompt: &TextPrompt<'_>) -> String {
    let display = if !prompt.value.is_empty() {
        if prompt.password {
            format!("{}{}{}", Ansi::AMBER, "*".repeat(prompt.value.chars().count()), Ansi::RESET)
        } else {
            format!("{}{}{}", Ansi::WHITE, prompt.value, Ansi::RESET)
        }
    } else if let Some(placeholder) = prompt.placeholder {
        format!("{}{}{}", Ansi::DIM, placeholder, Ansi::RESET)
    } else {
        String::new()
    };

    let mut out = format!(
        " {}{}{} {}{}{}\n {} {}\n",
        Ansi::AMBER,
        Symbols::ACTIVE,
        Ansi::RESET,
        Ansi::WHITE,
        prompt.message,
        Ansi::RESET,
        bar("default"),
        display
    );

    if let Some(error) = prompt.error {
        out.push_str(&format!(
            " {} {}{} {}{}\n",
            bar("default"),
            Ansi::RED,
            Symbols::ERROR,
            error,
            Ansi::RESET
        ));
    }

    out
}

pub fn render_select_prompt(prompt: &SelectPrompt<'_>) -> String {
    let mut out = format!(
        " {}{}{} {}{}{}\n",
        Ansi::AMBER,
        Symbols::ACTIVE,
        Ansi::RESET,
        Ansi::WHITE,
        prompt.message,
        Ansi::RESET
    );

    for (idx, option) in prompt.options.iter().enumerate() {
        let selected = idx == prompt.cursor;
        let bullet = if selected { Symbols::BULLET } else { Symbols::DOT };
        let color = if selected { Ansi::WHITE } else { Ansi::DIM };
        let bullet_color = if selected { Ansi::AMBER } else { Ansi::DIM };
        out.push_str(&format!(
            " {} {}{}{} {}{}{}\n",
            bar("default"),
            bullet_color,
            bullet,
            Ansi::RESET,
            color,
            option.label,
            Ansi::RESET
        ));
    }

    out
}

pub fn render_confirm_prompt(prompt: &ConfirmPrompt<'_>) -> String {
    let active = if prompt.value {
        format!("{}{}{}", Ansi::GREEN, prompt.active, Ansi::RESET)
    } else {
        format!("{}{}{}", Ansi::DIM, prompt.active, Ansi::RESET)
    };
    let inactive = if !prompt.value {
        format!("{}{}{}", Ansi::RED, prompt.inactive, Ansi::RESET)
    } else {
        format!("{}{}{}", Ansi::DIM, prompt.inactive, Ansi::RESET)
    };

    format!(
        " {}{}{} {}{}{} {} / {}\n",
        Ansi::AMBER,
        Symbols::ACTIVE,
        Ansi::RESET,
        Ansi::WHITE,
        prompt.message,
        Ansi::RESET,
        active,
        inactive
    )
}

pub fn render_checkpoint(prompt: &CheckpointPrompt) -> String {
    let mut out = String::new();

    if let Some(completed) = &prompt.completed {
        out.push_str(&format!(
            "\n {}{}{} {}Fase {}/{} completada{} {}{}{}\n",
            Ansi::GREEN,
            Symbols::DONE,
            Ansi::RESET,
            Ansi::WHITE,
            prompt.phase_number.saturating_sub(1),
            prompt.total_phases,
            Ansi::RESET,
            Ansi::DIM,
            completed.summary,
            Ansi::RESET
        ));
        for file in &completed.files_created {
            out.push_str(&format!(" {} {}+{} {}{}{}\n", bar("default"), Ansi::GREEN, Ansi::RESET, Ansi::DIM, file, Ansi::RESET));
        }
        for file in &completed.files_modified {
            out.push_str(&format!(" {} {}~{} {}{}{}\n", bar("default"), Ansi::AMBER, Ansi::RESET, Ansi::DIM, file, Ansi::RESET));
        }
    }

    let coordinator = &prompt.upcoming.coordinator;
    out.push_str(&format!(
        "\n {}{}{} {}Fase {}/{}: {}{}\n",
        coordinator_ansi(coordinator),
        Symbols::ACTIVE,
        Ansi::RESET,
        Ansi::WHITE,
        prompt.phase_number,
        prompt.total_phases,
        coordinator,
        Ansi::RESET
    ));

    for file in &prompt.upcoming.will_create {
        out.push_str(&format!(
            " {} {}+{} crear {}{}{} {}{}{}\n",
            bar(coordinator),
            Ansi::GREEN,
            Ansi::RESET,
            Ansi::WHITE,
            file.path,
            Ansi::RESET,
            Ansi::DIM,
            file.reason,
            Ansi::RESET
        ));
    }
    for file in &prompt.upcoming.will_modify {
        out.push_str(&format!(
            " {} {}~{} modificar {}{}{} {}{}{} {}{}{}\n",
            bar(coordinator),
            Ansi::AMBER,
            Ansi::RESET,
            Ansi::WHITE,
            file.path,
            Ansi::RESET,
            Ansi::DIM,
            file.lines,
            Ansi::RESET,
            Ansi::DIM,
            file.reason,
            Ansi::RESET
        ));
    }

    out
}

pub fn fmt_tokens(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    } else if n >= 1_000 {
        format!("{:.1}k", n as f64 / 1_000.0)
    } else {
        n.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_token_counts() {
        assert_eq!(fmt_tokens(0), "0");
        assert_eq!(fmt_tokens(999), "999");
        assert_eq!(fmt_tokens(1_000), "1.0k");
        assert_eq!(fmt_tokens(1_500), "1.5k");
        assert_eq!(fmt_tokens(2_000_000), "2.0M");
    }

    #[test]
    fn renders_intro_and_outro() {
        let intro = intro("hivecode");
        assert!(intro.contains(Mascot::HAPPY));
        assert!(intro.contains("hivecode"));

        let outro = outro("Listo", OutputKind::Success);
        assert!(outro.contains(Symbols::CHECK));
        assert!(outro.contains("Listo"));
    }

    #[test]
    fn renders_prompt_shapes() {
        let text = render_text_prompt(&TextPrompt {
            message: "API Key:",
            value: "secret",
            placeholder: Some("sk-..."),
            password: true,
            error: None,
        });
        assert!(text.contains("API Key:"));
        assert!(text.contains("******"));
        assert!(!text.contains("secret"));

        let options = [SelectOption::new("auto", "AUTO"), SelectOption::new("plan", "PLAN")];
        let select = render_select_prompt(&SelectPrompt {
            message: "Modo:",
            options: &options,
            cursor: 1,
        });
        assert!(select.contains("Modo:"));
        assert!(select.contains("PLAN"));
    }

    #[test]
    fn renders_checkpoint_summary() {
        let checkpoint = CheckpointPrompt {
            phase_number: 2,
            total_phases: 3,
            completed: Some(CompletedCheckpoint {
                files_created: vec!["src/a.rs".into()],
                files_modified: vec!["src/b.rs".into()],
                summary: "base lista".into(),
            }),
            upcoming: UpcomingCheckpoint {
                coordinator: "backend".into(),
                will_create: vec![CheckpointFileCreate {
                    path: "src/c.rs".into(),
                    reason: "nuevo flujo".into(),
                }],
                will_modify: vec![],
            },
        };

        let rendered = render_checkpoint(&checkpoint);
        assert!(rendered.contains("Fase 1/3 completada"));
        assert!(rendered.contains("src/c.rs"));
    }
}

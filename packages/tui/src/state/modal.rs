use crate::ipc::ModalField;

/// State for the config-form modal (multi-field input dialog).
#[derive(Debug, Default)]
pub struct ModalState {
    pub show: bool,
    pub title: String,
    pub command: String,
    pub fields: Vec<ModalField>,
    pub values: Vec<String>,
    pub cursors: Vec<usize>,
    pub focused: usize,
    pub errors: Vec<bool>,
    // Read-only info modal
    pub show_info: bool,
    pub info_title: String,
    pub info_content: String,
    pub info_scroll: usize,
}

impl ModalState {
    pub fn open_config(&mut self, command: String, title: String, fields: Vec<ModalField>) {
        let n = fields.len();
        self.command = command;
        self.title = title;
        let values: Vec<String> = fields.iter().map(|f| {
            if let Some(ref dv) = f.default_value {
                return dv.clone();
            }
            if f.field_type == "select" {
                return f.options.as_ref().and_then(|o| o.first().cloned()).unwrap_or_default();
            }
            String::new()
        }).collect();
        self.fields = fields;
        self.values = values;
        self.cursors = vec![0; n];
        self.errors = vec![false; n];
        self.focused = 0;
        self.show = true;
    }

    pub fn open_info(&mut self, title: String, content: String) {
        self.info_title = title;
        self.info_content = content;
        self.info_scroll = 0;
        self.show_info = true;
    }

    pub fn close_config(&mut self) {
        self.show = false;
        self.fields.clear();
        self.values.clear();
        self.cursors.clear();
        self.errors.clear();
        self.title.clear();
        self.command.clear();
        self.focused = 0;
    }

    pub fn close_info(&mut self) {
        self.show_info = false;
        self.info_title.clear();
        self.info_content.clear();
        self.info_scroll = 0;
    }

    pub fn cycle_select_option(&mut self, idx: usize) {
        let field = &self.fields[idx];
        if let Some(opts) = &field.options {
            if opts.is_empty() { return; }
            let current = &self.values[idx];
            let pos = opts.iter().position(|o| o == current).unwrap_or(0);
            let next = (pos + 1) % opts.len();
            self.values[idx] = opts[next].clone();
        }
    }

    /// Returns `true` if all required fields pass validation.
    pub fn validate(&mut self) -> bool {
        let mut ok = true;
        for (i, field) in self.fields.iter().enumerate() {
            if field.required && self.values[i].trim().is_empty() {
                self.errors[i] = true;
                ok = false;
            }
        }
        ok
    }

    pub fn collect_values(&self) -> std::collections::HashMap<String, String> {
        self.fields
            .iter()
            .enumerate()
            .map(|(i, f)| (f.key.clone(), self.values[i].clone()))
            .collect()
    }
}

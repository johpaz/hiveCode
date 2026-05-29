#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PanelLayoutState {
    pub header_height: u16,
    pub input_height: u16,
    pub footer_height: u16,
    pub code_main_percent: u16,
    pub code_workers_percent: u16,
    pub plan_main_percent: u16,
    pub plan_right_percent: u16,
    pub active_drag: Option<String>,
}

impl Default for PanelLayoutState {
    fn default() -> Self {
        Self {
            header_height: 2,
            input_height: 4,
            footer_height: 1,
            code_main_percent: 55,
            code_workers_percent: 68,
            plan_main_percent: 60,
            plan_right_percent: 65,
            active_drag: None,
        }
    }
}

impl PanelLayoutState {
    pub fn begin_drag(&mut self, id: String) {
        self.active_drag = Some(id);
    }

    pub fn end_drag(&mut self) {
        self.active_drag = None;
    }

    pub fn set_percent(&mut self, id: &str, percent: u16) {
        let percent = percent.clamp(20, 80);
        match id {
            "code:main" => self.code_main_percent = percent,
            "code:workers" => self.code_workers_percent = percent,
            "plan:main" => self.plan_main_percent = percent,
            "plan:right" => self.plan_right_percent = percent,
            _ => {}
        }
    }

    pub fn set_chrome_height(&mut self, id: &str, height: u16) {
        match id {
            "chrome:header" => self.header_height = height.clamp(1, 5),
            "chrome:input" => self.input_height = height.clamp(2, 10),
            "chrome:footer" => self.footer_height = height.clamp(1, 3),
            _ => {}
        }
    }
}

use super::TabId;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum LayoutStage {
    #[default]
    Idle,
    Classifying,
    Planning,
    Executing,
    Reviewing,
    Completed,
    Failed,
}

#[derive(Debug, Clone)]
pub struct LayoutRoutingState {
    pub stage: LayoutStage,
    pub recommended_tab: TabId,
    pub transition_reason: Option<String>,
    pub transition_ticks_remaining: u8,
}

impl Default for LayoutRoutingState {
    fn default() -> Self {
        Self {
            stage: LayoutStage::Idle,
            recommended_tab: TabId::Focus,
            transition_reason: None,
            transition_ticks_remaining: 0,
        }
    }
}

impl LayoutRoutingState {
    pub fn recommend(&mut self, tab: TabId, stage: LayoutStage, reason: impl Into<String>) {
        self.stage = stage;
        if self.recommended_tab != tab {
            self.recommended_tab = tab;
            self.transition_reason = Some(reason.into());
            self.transition_ticks_remaining = 4;
        }
    }

    pub fn tick(&mut self) {
        if self.transition_ticks_remaining == 0 {
            self.transition_reason = None;
            return;
        }
        self.transition_ticks_remaining -= 1;
    }
}

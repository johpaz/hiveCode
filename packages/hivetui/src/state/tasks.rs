#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskProjection {
    pub task_id: String,
    pub title: String,
    pub status: String,
    pub mode: String,
    pub active_workers: Vec<String>,
    pub workspace_id: Option<String>,
    pub workspace_path: Option<String>,
    pub branch_name: Option<String>,
    pub isolated: bool,
    pub integration_status: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskProjectionState {
    pub active_task_id: Option<String>,
    pub tasks: Vec<TaskProjection>,
    pub capacity: usize,
}

impl Default for TaskProjectionState {
    fn default() -> Self {
        Self {
            active_task_id: None,
            tasks: Vec::new(),
            capacity: 12,
        }
    }
}

impl TaskProjectionState {
    pub fn upsert(
        &mut self,
        task_id: String,
        title: Option<String>,
        status: String,
        mode: Option<String>,
        active_workers: Option<Vec<String>>,
        workspace_id: Option<String>,
        workspace_path: Option<String>,
        branch_name: Option<String>,
        isolated: Option<bool>,
        integration_status: Option<String>,
    ) {
        if let Some(task) = self.tasks.iter_mut().find(|task| task.task_id == task_id) {
            if let Some(title) = title.filter(|title| !title.is_empty()) {
                task.title = title;
            }
            task.status = status.clone();
            if let Some(mode) = mode.filter(|mode| !mode.is_empty()) {
                task.mode = mode;
            }
            if let Some(active_workers) = active_workers {
                task.active_workers = active_workers;
            }
            if workspace_id.is_some() {
                task.workspace_id = workspace_id;
            }
            if workspace_path.is_some() {
                task.workspace_path = workspace_path;
            }
            if branch_name.is_some() {
                task.branch_name = branch_name;
            }
            if let Some(isolated) = isolated {
                task.isolated = isolated;
            }
            if integration_status.is_some() {
                task.integration_status = integration_status;
            }
        } else {
            self.tasks.push(TaskProjection {
                task_id: task_id.clone(),
                title: title.unwrap_or_else(|| task_id.clone()),
                status: status.clone(),
                mode: mode.unwrap_or_default(),
                active_workers: active_workers.unwrap_or_default(),
                workspace_id,
                workspace_path,
                branch_name,
                isolated: isolated.unwrap_or(false),
                integration_status,
            });
        }

        if matches!(status.as_str(), "running" | "planning" | "approval" | "paused") {
            self.active_task_id = Some(task_id);
        } else if self.active_task_id.as_deref() == Some(task_id.as_str()) {
            self.active_task_id = self
                .tasks
                .iter()
                .rev()
                .find(|task| matches!(task.status.as_str(), "running" | "planning" | "approval" | "paused"))
                .map(|task| task.task_id.clone());
        }

        let overflow = self.tasks.len().saturating_sub(self.capacity);
        if overflow > 0 {
            self.tasks.drain(0..overflow);
        }
    }

    pub fn mark_worker(&mut self, task_id: String, worker: String, worker_status: &str) {
        let task_id = task_id.trim();
        let worker = worker.trim();
        if task_id.is_empty() || worker.is_empty() {
            return;
        }

        let existing_status = self
            .tasks
            .iter()
            .find(|task| task.task_id == task_id)
            .map(|task| task.status.clone());

        let status = match worker_status {
            "failed" => "failed".to_string(),
            "running" | "warn" | "thinking" => "running".to_string(),
            "done" | "idle" if existing_status.is_none() => return,
            _ => existing_status.unwrap_or_else(|| "running".to_string()),
        };

        self.upsert(task_id.to_string(), None, status, None, None, None, None, None, None, None);

        if let Some(task) = self.tasks.iter_mut().find(|task| task.task_id == task_id) {
            match worker_status {
                "running" | "warn" | "thinking" => {
                    if !task.active_workers.iter().any(|active| active == worker) {
                        task.active_workers.push(worker.to_string());
                    }
                }
                "done" | "idle" | "failed" => {
                    task.active_workers.retain(|active| active != worker);
                }
                _ => {}
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn task_projection_upserts_and_tracks_active_task() {
        let mut state = TaskProjectionState::default();

        state.upsert(
            "task-1".to_string(),
            Some("Fix auth".to_string()),
            "running".to_string(),
            Some("auto".to_string()),
            Some(vec!["backend".to_string()]),
            Some("worktree:task-1".to_string()),
            Some("/tmp/task-1".to_string()),
            Some("hivecode/task-task-1".to_string()),
            Some(true),
            Some("isolated".to_string()),
        );
        state.upsert(
            "task-1".to_string(),
            None,
            "completed".to_string(),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        );

        assert_eq!(state.tasks.len(), 1);
        assert_eq!(state.tasks[0].title, "Fix auth");
        assert_eq!(state.tasks[0].status, "completed");
        assert!(state.tasks[0].isolated);
        assert_eq!(state.tasks[0].integration_status.as_deref(), Some("isolated"));
        assert_eq!(state.active_task_id, None);
    }

    #[test]
    fn mark_worker_tracks_active_workers_without_completing_task() {
        let mut state = TaskProjectionState::default();

        state.mark_worker("task-1".to_string(), "backend".to_string(), "running");
        state.mark_worker("task-1".to_string(), "test".to_string(), "running");
        state.mark_worker("task-1".to_string(), "backend".to_string(), "done");

        assert_eq!(state.active_task_id.as_deref(), Some("task-1"));
        assert_eq!(state.tasks[0].status, "running");
        assert_eq!(state.tasks[0].active_workers, vec!["test".to_string()]);
    }
}

//! Who has finished: lets a worker wait for another task's handoff without polling.
//!
//! Every delegation announces its `ref` before it starts and settles it when it ends, so a sibling
//! that runs at the same time can `wait_for` it. A ref that is never settled (a task that waits on
//! itself, or on a task that has not started) ends in a timeout, never in a hang.
use std::{collections::HashMap, sync::Mutex, time::Duration};
use tokio::sync::watch;

#[derive(Clone, Debug, PartialEq)]
pub struct Settled {
    pub ok: bool,
    pub handoff: String,
}

#[derive(Debug, PartialEq)]
pub enum WaitError {
    /// Nothing was ever delegated under this ref.
    Unknown,
    Timeout,
    Cancelled,
}

#[derive(Default)]
pub struct Board {
    slots: Mutex<HashMap<String, watch::Sender<Option<Settled>>>>,
}

impl Board {
    /// Marks `reference` as in flight. Announcing it again starts a new, unsettled round.
    pub fn announce(&self, reference: &str) {
        let (sender, _) = watch::channel(None);
        self.slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(reference.to_owned(), sender);
    }

    pub fn settle(&self, reference: &str, ok: bool, handoff: &str) {
        if let Some(sender) = self
            .slots
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(reference)
        {
            sender.send_replace(Some(Settled {
                ok,
                handoff: handoff.to_owned(),
            }));
        }
    }

    pub async fn wait(
        &self,
        reference: &str,
        timeout: Duration,
        cancel: &hive_agent_core::provider::CancellationToken,
    ) -> Result<Settled, WaitError> {
        let mut receiver = {
            let slots = self.slots.lock().unwrap_or_else(|e| e.into_inner());
            slots.get(reference).ok_or(WaitError::Unknown)?.subscribe()
        };
        tokio::select! {
            biased;
            _ = cancel.cancelled() => Err(WaitError::Cancelled),
            result = tokio::time::timeout(timeout, receiver.wait_for(|value| value.is_some())) => {
                match result {
                    Ok(Ok(value)) => Ok(value.clone().expect("waited for a settled value")),
                    // The sender was replaced by a new round before this one settled.
                    Ok(Err(_)) => Err(WaitError::Timeout),
                    Err(_) => Err(WaitError::Timeout),
                }
            }
        }
    }
}

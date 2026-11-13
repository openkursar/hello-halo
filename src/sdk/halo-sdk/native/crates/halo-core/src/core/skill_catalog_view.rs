use crate::error::{Error, Result};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};

type Release = Box<dyn FnOnce() + Send + Sync>;

#[derive(Default)]
struct State {
    closed: bool,
    release: Option<Release>,
    snapshots: HashMap<String, Arc<Value>>,
}

pub struct SkillCatalogOwner {
    identity: String,
    state: Mutex<State>,
}

pub struct SkillCatalogSnapshot {
    pub owner: Arc<SkillCatalogOwner>,
    pub scope: String,
    value: Arc<Value>,
}

fn closed() -> Error {
    Error::new("TOOL_CONTEXT_CLOSED", "Tool context is no longer available")
}

impl SkillCatalogOwner {
    pub fn new(identity: String) -> Self {
        Self {
            identity,
            state: Mutex::new(State::default()),
        }
    }
    pub fn identity(&self) -> &str {
        &self.identity
    }
    pub fn snapshot(
        self: &Arc<Self>,
        scope: &str,
        create: impl FnOnce() -> Value,
    ) -> Result<SkillCatalogSnapshot> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(closed());
        }
        let value = state
            .snapshots
            .entry(scope.to_owned())
            .or_insert_with(|| Arc::new(create()))
            .clone();
        Ok(SkillCatalogSnapshot {
            owner: self.clone(),
            scope: scope.into(),
            value,
        })
    }
    pub fn observe_release(&self, create: impl FnOnce() -> Release) -> Result<()> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.closed {
            return Err(closed());
        }
        state.release.get_or_insert_with(create);
        Ok(())
    }
    pub fn close(&self) {
        let (snapshots, release) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return;
            }
            state.closed = true;
            (std::mem::take(&mut state.snapshots), state.release.take())
        };
        drop(snapshots);
        if let Some(release) = release {
            if std::panic::catch_unwind(std::panic::AssertUnwindSafe(release)).is_err() {
                tracing::warn!(owner = %self.identity, "Skill catalog release observer panicked");
            }
        }
    }
}

impl Drop for SkillCatalogOwner {
    fn drop(&mut self) {
        self.close();
    }
}

impl SkillCatalogSnapshot {
    pub fn value(&self) -> Result<&Value> {
        if self
            .owner
            .state
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .closed
        {
            return Err(closed());
        }
        Ok(&self.value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn close_releases_views_once_and_refuses_late_materialization() {
        let owner = Arc::new(SkillCatalogOwner::new("initial-run".into()));
        let original = owner.snapshot("", || json!([{"name":"commit"}])).unwrap();
        let retained = owner
            .snapshot("", || panic!("An existing snapshot must not be rebuilt"))
            .unwrap();
        let changed = owner
            .snapshot("model:other", || json!([{"name":"different"}]))
            .unwrap();
        assert!(Arc::ptr_eq(&original.value, &retained.value));
        assert!(!Arc::ptr_eq(&original.value, &changed.value));
        let releases = Arc::new(AtomicUsize::new(0));
        let observed = releases.clone();
        owner
            .observe_release(|| {
                Box::new(move || {
                    observed.fetch_add(1, Ordering::SeqCst);
                })
            })
            .unwrap();
        owner
            .observe_release(|| panic!("An owner must register its release observer once"))
            .unwrap();
        owner.close();
        owner.close();
        assert_eq!(releases.load(Ordering::SeqCst), 1);
        assert!(original.value().is_err());
        assert!(owner
            .snapshot("", || panic!("A retired owner must not create a view"))
            .is_err());
        assert!(owner
            .observe_release(|| panic!("A retired owner must not attach an observer"))
            .is_err());
        assert!(owner.state.lock().unwrap().snapshots.is_empty());
    }

    #[test]
    fn dropping_an_owner_releases_its_observer() {
        let releases = Arc::new(AtomicUsize::new(0));
        {
            let owner = SkillCatalogOwner::new("initial-run".into());
            let observed = releases.clone();
            owner
                .observe_release(|| {
                    Box::new(move || {
                        observed.fetch_add(1, Ordering::SeqCst);
                    })
                })
                .unwrap();
        }
        assert_eq!(releases.load(Ordering::SeqCst), 1);
    }
}

use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct ResourceSnapshot {
    pub generation: u64,
    pub active: bool,
}
type Observer = Arc<dyn Fn(ResourceSnapshot) + Send + Sync>;
#[derive(Default)]
struct State {
    count: usize,
    generation: u64,
    next_observer: u64,
    observers: HashMap<u64, Observer>,
    closed: bool,
}
#[derive(Default)]
pub struct ResourceActivity {
    state: Mutex<State>,
}
pub struct ResourceLease {
    activity: Option<Arc<ResourceActivity>>,
}
pub struct ResourceSubscription {
    activity: Weak<ResourceActivity>,
    id: u64,
}

fn notify(snapshot: ResourceSnapshot, observers: Vec<Observer>) {
    for observer in observers {
        if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| observer(snapshot))).is_err() {
            tracing::warn!(
                generation = snapshot.generation,
                "Resource activity observer panicked"
            );
        }
    }
}
impl ResourceActivity {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn snapshot(&self) -> ResourceSnapshot {
        let state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        ResourceSnapshot {
            generation: state.generation,
            active: state.count != 0,
        }
    }
    pub fn lease(self: &Arc<Self>) -> ResourceLease {
        let change = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return ResourceLease { activity: None };
            }
            state.count += 1;
            if state.count == 1 {
                state.generation += 1;
                Some((
                    ResourceSnapshot {
                        generation: state.generation,
                        active: true,
                    },
                    state.observers.values().cloned().collect(),
                ))
            } else {
                None
            }
        };
        if let Some((snapshot, observers)) = change {
            notify(snapshot, observers);
        }
        ResourceLease {
            activity: Some(self.clone()),
        }
    }
    fn release(&self) {
        let change = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return;
            }
            state.count -= 1;
            if state.count == 0 {
                state.generation += 1;
                Some((
                    ResourceSnapshot {
                        generation: state.generation,
                        active: false,
                    },
                    state.observers.values().cloned().collect(),
                ))
            } else {
                None
            }
        };
        if let Some((snapshot, observers)) = change {
            notify(snapshot, observers);
        }
    }
    pub fn subscribe(
        self: &Arc<Self>,
        observer: impl Fn(ResourceSnapshot) + Send + Sync + 'static,
    ) -> ResourceSubscription {
        let observer: Observer = Arc::new(observer);
        let (id, snapshot) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            state.next_observer += 1;
            let id = state.next_observer;
            if !state.closed {
                state.observers.insert(id, observer.clone());
            }
            (
                id,
                ResourceSnapshot {
                    generation: state.generation,
                    active: state.count != 0,
                },
            )
        };
        notify(snapshot, vec![observer]);
        ResourceSubscription {
            activity: Arc::downgrade(self),
            id,
        }
    }
    pub fn close(&self) {
        let (snapshot, observers) = {
            let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
            if state.closed {
                return;
            }
            state.closed = true;
            let observers = state
                .observers
                .drain()
                .map(|(_, observer)| observer)
                .collect();
            if state.count == 0 {
                (None, observers)
            } else {
                state.count = 0;
                state.generation += 1;
                (
                    Some(ResourceSnapshot {
                        generation: state.generation,
                        active: false,
                    }),
                    observers,
                )
            }
        };
        if let Some(snapshot) = snapshot {
            notify(snapshot, observers);
        }
    }
}
impl Drop for ResourceLease {
    fn drop(&mut self) {
        if let Some(activity) = self.activity.take() {
            activity.release();
        }
    }
}
impl Drop for ResourceSubscription {
    fn drop(&mut self) {
        if let Some(activity) = self.activity.upgrade() {
            let removed = {
                activity
                    .state
                    .lock()
                    .unwrap_or_else(|error| error.into_inner())
                    .observers
                    .remove(&self.id)
            };
            drop(removed);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn publishes_only_edges_and_releases_subscriptions() {
        let activity = Arc::new(ResourceActivity::new());
        let values = Arc::new(Mutex::new(Vec::new()));
        let observed = values.clone();
        let inspect = Arc::downgrade(&activity);
        let subscription = activity.subscribe(move |snapshot| {
            assert_eq!(inspect.upgrade().unwrap().snapshot(), snapshot);
            observed.lock().unwrap().push(snapshot);
        });
        let first = activity.lease();
        let second = activity.lease();
        drop(first);
        assert!(activity.snapshot().active);
        drop(second);
        assert_eq!(
            *values.lock().unwrap(),
            vec![
                ResourceSnapshot {
                    generation: 0,
                    active: false
                },
                ResourceSnapshot {
                    generation: 1,
                    active: true
                },
                ResourceSnapshot {
                    generation: 2,
                    active: false
                }
            ]
        );
        drop(subscription);
        drop(activity.lease());
        assert_eq!(values.lock().unwrap().len(), 3);
    }
    #[test]
    fn close_cannot_be_reopened_by_outstanding_leases() {
        let activity = Arc::new(ResourceActivity::new());
        let first = activity.lease();
        activity.close();
        let closed = activity.snapshot();
        assert!(!closed.active);
        drop(first);
        drop(activity.lease());
        activity.close();
        assert_eq!(activity.snapshot(), closed);
    }
    #[test]
    fn concurrent_leases_keep_a_single_active_edge() {
        let activity = Arc::new(ResourceActivity::new());
        let values = Arc::new(Mutex::new(Vec::new()));
        let observed = values.clone();
        let _subscription =
            activity.subscribe(move |snapshot| observed.lock().unwrap().push(snapshot));
        let root = activity.lease();
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let activity = activity.clone();
                scope.spawn(move || {
                    for _ in 0..1000 {
                        drop(activity.lease());
                    }
                });
            }
        });
        drop(root);
        assert_eq!(values.lock().unwrap().len(), 3);
        assert_eq!(
            activity.snapshot(),
            ResourceSnapshot {
                generation: 2,
                active: false
            }
        );
    }
}

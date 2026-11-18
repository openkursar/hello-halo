use crate::error::{Error, Result};
use crate::harness::TextId;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::Mutex as AsyncMutex;

#[async_trait]
pub trait ScopeStore: Send + Sync {
    fn team_id(&self) -> &str;
    fn epoch_id(&self) -> &str;
    fn rows(&self, kind: &str) -> Vec<Value>;
    fn get(&self, kind: &str, id: &str) -> Option<Value>;
    fn find_member(&self, name: &str) -> Option<Value>;
    fn try_rows(&self, kind: &str) -> Result<Vec<Value>> {
        Ok(self.rows(kind))
    }
    fn try_get(&self, kind: &str, id: &str) -> Result<Option<Value>> {
        Ok(self.get(kind, id))
    }
    fn try_find_member(&self, name: &str) -> Result<Option<Value>> {
        Ok(self.find_member(name))
    }
    fn record(&self, mutation: Value) -> Result<()>;
    fn update_task(&self, id: &str, patch: Value, now: Value) -> Result<()> {
        let mut task = self
            .try_get("task", id)?
            .ok_or_else(|| Error::new("COLLABORATION_RECORD", "Unknown collaboration task"))?;
        if let Some(patch) = patch.as_object() {
            task.as_object_mut().unwrap().extend(patch.clone());
        }
        task["updatedAt"] = now;
        self.record(json!({"kind":"task","value":task}))
    }
    async fn flush(&self) -> Result<()>;
}

#[async_trait]
pub trait JournalSink: Send + Sync {
    async fn persist(&self, mutations: &[Value]) -> Result<()>;
}

struct State {
    rows: HashMap<String, Vec<Value>>,
    names: HashMap<String, String>,
    sizes: HashMap<String, usize>,
    bytes: usize,
    pending: Vec<Value>,
}

pub struct MemoryStore {
    team_id: String,
    epoch_id: String,
    max_records: usize,
    max_bytes: usize,
    state: Mutex<State>,
    writing: AsyncMutex<()>,
    journal: Option<Arc<dyn JournalSink>>,
}

impl MemoryStore {
    pub fn new(
        team_id: String,
        epoch_id: String,
        max_records: usize,
        max_bytes: usize,
        journal: Option<Arc<dyn JournalSink>>,
    ) -> Result<Self> {
        if max_bytes == 0 {
            return Err(Error::new(
                "COLLABORATION_ARGUMENTS",
                "maxBytes must be a positive integer",
            ));
        }
        if max_records == 0 {
            return Err(Error::new(
                "COLLABORATION_ARGUMENTS",
                "maxRecords must be a positive integer",
            ));
        }
        Ok(Self {
            team_id,
            epoch_id,
            max_records,
            max_bytes,
            journal,
            writing: AsyncMutex::new(()),
            state: Mutex::new(State {
                rows: HashMap::new(),
                names: HashMap::new(),
                sizes: HashMap::new(),
                bytes: 0,
                pending: Vec::new(),
            }),
        })
    }
    pub fn apply(&self, mutation: &Value) -> Result<()> {
        self.apply_inner(mutation, false, false)
    }
    pub fn apply_encoded_scalars(&self, mutation: &Value, persist: bool) -> Result<()> {
        self.apply_inner(mutation, persist, true)
    }
    fn apply_inner(&self, mutation: &Value, persist: bool, encoded_scalars: bool) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let kind = mutation["kind"].as_str().unwrap_or("");
        if kind == "remove_member" {
            let id = mutation["id"].as_str().unwrap_or("");
            let rows = state.rows.entry("member".into()).or_default();
            if let Some(index) = rows.iter().position(|row| row["id"] == id) {
                let previous = rows.remove(index);
                if let Some(name) = previous["name"].as_str() {
                    state.names.remove(name);
                }
            }
            let key = format!("member:{id}");
            let removed = state.sizes.remove(&key).unwrap_or(0);
            state.bytes -= removed;
        } else {
            let row = &mutation["value"];
            let id = row["id"].as_str().ok_or_else(|| {
                Error::new(
                    "COLLABORATION_RECORD",
                    "Invalid collaboration journal identity",
                )
            })?;
            let rows = state.rows.entry(kind.into()).or_default();
            if !rows.iter().any(|row| row["id"] == id) && rows.len() >= self.max_records {
                return Err(Error::new("COLLABORATION_CAPACITY", "The local collaboration record limit was reached. Use a host store sized for this workload."));
            }
            if kind == "member" {
                if let Some(existing) = state.names.get(row["name"].as_str().unwrap_or("")) {
                    if existing != id {
                        return Err(Error::new(
                            "COLLABORATION_RECORD",
                            "Duplicate collaboration member name",
                        ));
                    }
                }
            } else if row["teamId"] != self.team_id || row["epochId"] != self.epoch_id {
                return Err(Error::new(
                    "COLLABORATION_RECORD",
                    "Collaboration record has a different scope",
                ));
            }
            let fields = row.as_object().ok_or_else(|| {
                Error::new("COLLABORATION_RECORD", "Missing collaboration journal row")
            })?;
            let mut size = 64;
            for (key, value) in fields {
                let undefined = encoded_scalars
                    && value.as_object().is_some_and(|fields| {
                        fields.len() == 1
                            && fields.get("__haloSdkNativeUndefined") == Some(&Value::Bool(true))
                    });
                if value.is_array() || (value.is_object() && !undefined) {
                    return Err(Error::new(
                        "COLLABORATION_RECORD",
                        "Collaboration records contain only scalar fields.",
                    ));
                }
                size += key.len() * 6 + value.as_str().map_or(16, |v| v.len() * 6);
            }
            let key = format!("{kind}:{id}");
            let next = state.bytes - state.sizes.get(&key).copied().unwrap_or(0) + size;
            if size > 1024 * 1024 || next > self.max_bytes {
                return Err(Error::new(
                    "COLLABORATION_CAPACITY",
                    "The local collaboration byte limit was reached. The record was not accepted.",
                ));
            }
            state.bytes = next;
            state.sizes.insert(key, size);
            let rows = state.rows.entry(kind.into()).or_default();
            let previous = if let Some(index) = rows.iter().position(|v| v["id"] == id) {
                Some(std::mem::replace(&mut rows[index], row.clone()))
            } else {
                rows.push(row.clone());
                None
            };
            if kind == "member" {
                if let Some(previous) = previous {
                    if previous["name"] != row["name"] {
                        state.names.remove(previous["name"].as_str().unwrap_or(""));
                    }
                }
                state
                    .names
                    .insert(row["name"].as_str().unwrap_or("").into(), id.into());
            }
        }
        if persist && self.journal.is_some() {
            state.pending.push(mutation.clone());
        }
        Ok(())
    }
}

#[async_trait]
impl ScopeStore for MemoryStore {
    fn team_id(&self) -> &str {
        &self.team_id
    }
    fn epoch_id(&self) -> &str {
        &self.epoch_id
    }
    fn rows(&self, kind: &str) -> Vec<Value> {
        self.state
            .lock()
            .unwrap()
            .rows
            .get(kind)
            .cloned()
            .unwrap_or_default()
    }
    fn get(&self, kind: &str, id: &str) -> Option<Value> {
        self.state
            .lock()
            .unwrap()
            .rows
            .get(kind)?
            .iter()
            .find(|row| row["id"] == id)
            .cloned()
    }
    fn find_member(&self, name: &str) -> Option<Value> {
        let state = self.state.lock().unwrap();
        let id = state.names.get(name)?;
        state
            .rows
            .get("member")?
            .iter()
            .find(|row| row["id"] == *id)
            .cloned()
    }
    fn record(&self, mutation: Value) -> Result<()> {
        self.apply_inner(&mutation, true, false)
    }
    async fn flush(&self) -> Result<()> {
        let _writing = self.writing.lock().await;
        let Some(journal) = &self.journal else {
            return Ok(());
        };
        let batch = std::mem::take(&mut self.state.lock().unwrap().pending);
        if batch.is_empty() {
            return Ok(());
        }
        if let Err(error) = journal.persist(&batch).await {
            let mut state = self.state.lock().unwrap();
            let following = std::mem::take(&mut state.pending);
            state.pending = batch;
            state.pending.extend(following);
            tracing::warn!("[Collaboration] Journal write failed; mutations retained: {error}");
            return Err(error);
        }
        Ok(())
    }
}

pub fn add_member(store: &dyn ScopeStore, member: Value) -> Result<()> {
    store.record(json!({"kind":"member","value":member}))
}
pub fn post_task(store: &dyn ScopeStore, input: &Value) -> Result<Value> {
    if let Some(parent) = input["parentId"].as_str().filter(|v| !v.is_empty()) {
        if !store
            .try_get("task", parent)?
            .is_some_and(|v| v["teamId"] == store.team_id() && v["epochId"] == store.epoch_id())
        {
            return Err(Error::new("task_parent_scope", "")
                .with_harness(TextId::CollaborationFeedbackTaskParentScope, &[]));
        }
    }
    let now = super::protocol::now();
    let id = super::protocol::id();
    let task = json!({"id":id,"teamId":store.team_id(),"epochId":store.epoch_id(),"title":input["title"],"assigneeAppId":input["assigneeAppId"],"status":"pending","resultRef":null,"note":null,"parentId":input["parentId"],"createdByAppId":input["callerAppId"],"createdAt":now,"updatedAt":now});
    store.record(json!({"kind":"task","value":task}))?;
    Ok(json!({"taskId":id}))
}
pub fn update_task(store: &dyn ScopeStore, input: &Value) -> Result<()> {
    let id = input["taskId"].as_str().unwrap_or("");
    store
        .try_get("task", id)?
        .filter(|v| v["teamId"] == store.team_id() && v["epochId"] == store.epoch_id())
        .ok_or_else(|| {
            Error::new("task_update_scope", "")
                .with_harness(TextId::CollaborationFeedbackTaskUpdateScope, &[])
        })?;
    let mut patch = json!({});
    for key in ["status", "resultRef", "note"] {
        if let Some(value) = input.get(key) {
            patch[key] = value.clone();
        }
    }
    store.update_task(id, patch, super::protocol::now().into())
}
pub fn post_finding(store: &dyn ScopeStore, input: &Value) -> Result<Value> {
    let id = super::protocol::id();
    let finding = json!({"id":id,"teamId":store.team_id(),"epochId":store.epoch_id(),"authorAppId":input["callerAppId"],"body":input["content"],"ref":input["ref"],"createdAt":super::protocol::now()});
    store.record(json!({"kind":"finding","value":finding}))?;
    Ok(json!({"findingId":id}))
}
pub fn post_activity(store: &dyn ScopeStore, input: &Value) -> Result<Value> {
    let id = input["id"]
        .as_str()
        .map(String::from)
        .unwrap_or_else(super::protocol::id);
    let activity = json!({"id":id,"teamId":store.team_id(),"epochId":store.epoch_id(),"kind":input["kind"],"actorAppId":input["actorAppId"],"targetAppId":input["targetAppId"],"subject":input["subject"],"body":input["body"],"refId":input["refId"],"correlationId":input["correlationId"],"status":input["status"],"createdAt":super::protocol::now()});
    store.record(json!({"kind":"activity","value":activity}))?;
    Ok(json!({"activityId":id}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_mutation_preserves_existing_records() {
        let store = MemoryStore::new("team".into(), "epoch".into(), 1, 4096, None).unwrap();
        let member =
            json!({"id":"one","name":"alice","parentId":"lead","prompt":"work","createdAt":1});
        add_member(&store, member.clone()).unwrap();
        let mut second = member.clone();
        second["id"] = "two".into();
        assert!(add_member(&store, second).is_err());
        let mut huge = member.clone();
        huge["prompt"] = "x".repeat(1000).into();
        assert!(add_member(&store, huge).is_err());
        assert_eq!(store.get("member", "one"), Some(member));
    }
}

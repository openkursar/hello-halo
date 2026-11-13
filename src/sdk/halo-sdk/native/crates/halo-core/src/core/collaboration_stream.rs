use super::{collaboration_adapter::SdkCollaboration, cost::CostTracker};
use crate::{error::Result, session::NativeSession};
use serde_json::{json, Value};
use tokio_util::sync::CancellationToken;

pub struct CollaborationStream {
    totals: CostTracker,
    started: u64,
    result: Option<Value>,
    idle: Option<Value>,
    initialized: bool,
    answer: String,
    turns: u64,
    api_time: f64,
    denials: Vec<Value>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Continuation {
    Run,
    Finish,
    Closed,
}
impl Default for CollaborationStream {
    fn default() -> Self {
        Self::new()
    }
}
impl CollaborationStream {
    pub fn new() -> Self {
        Self::at(crate::collaboration::protocol::now())
    }
    pub fn at(started: u64) -> Self {
        Self {
            totals: CostTracker::new("collaboration", 200_000.0, Value::Null),
            started,
            result: None,
            idle: None,
            initialized: false,
            answer: String::new(),
            turns: 0,
            api_time: 0.0,
            denials: Vec::new(),
        }
    }
    pub fn completed_turns(&self) -> u64 {
        self.turns
    }
    pub fn has_error(&self) -> bool {
        self.result
            .as_ref()
            .is_some_and(|result| result["is_error"] == true)
    }
    pub fn accept(&mut self, message: Value) -> Option<Value> {
        if message["type"] == "result" {
            self.totals.add_reported_usage(&message["modelUsage"]);
            self.turns += message["num_turns"].as_u64().unwrap_or(0);
            self.api_time += message["duration_api_ms"].as_f64().unwrap_or(0.0);
            if let Some(denials) = message["permission_denials"].as_array() {
                self.denials.extend(denials.clone());
            }
            if message["subtype"] == "success"
                && message["result"]
                    .as_str()
                    .is_some_and(|text| !crate::js::trim_js(text).is_empty())
            {
                self.answer = message["result"].as_str().unwrap().into();
            }
            self.result = Some(message);
            None
        } else if message["type"] == "system" && message["subtype"] == "init" {
            let first = !self.initialized;
            self.initialized = true;
            first.then_some(message)
        } else if message["type"] == "system"
            && message["subtype"] == "session_state_changed"
            && message["state"] == "idle"
        {
            self.idle = Some(message);
            None
        } else {
            Some(message)
        }
    }
    pub fn finish(self, child_usage: Value, aborted: bool) -> Vec<Value> {
        self.finish_at(child_usage, aborted, crate::collaboration::protocol::now())
    }
    pub fn finish_at(mut self, child_usage: Value, aborted: bool, now: u64) -> Vec<Value> {
        let Some(mut result) = self.result.take() else {
            return self.idle.into_iter().collect();
        };
        self.totals.add_reported_usage(&child_usage);
        result["num_turns"] = self.turns.into();
        result["duration_ms"] = json!(now as f64 - self.started as f64);
        result["duration_api_ms"] = json!(self.api_time);
        result["total_cost_usd"] = json!(self.totals.total_cost_usd());
        result["usage"] = self.totals.usage();
        result["modelUsage"] = self.totals.model_usage();
        result["permission_denials"] = self.denials.into();
        if aborted {
            result["subtype"] = "error_during_execution".into();
            result["is_error"] = true.into();
            result["errors"] = json!(["Operation was aborted"]);
            result["result"] = "Operation was aborted".into();
        } else if result["subtype"] == "success" {
            result["result"] = self.answer.into();
        }
        let mut output = vec![result];
        if let Some(idle) = self.idle {
            output.push(idle);
        }
        output
    }
    pub async fn after_run(
        &self,
        collaboration: &SdkCollaboration,
        session: &NativeSession,
        signal: &CancellationToken,
    ) -> Result<Continuation> {
        if session.lifetime.is_cancelled() {
            return Ok(Continuation::Closed);
        }
        if signal.is_cancelled() || self.has_error() {
            return settle_stopped(collaboration, session).await;
        }
        loop {
            let wake = session.wake.notified();
            tokio::pin!(wake);
            wake.as_mut().enable();
            let revision = collaboration.revision();
            if session.lifetime.is_cancelled() {
                return Ok(Continuation::Closed);
            }
            if signal.is_cancelled() {
                return settle_stopped(collaboration, session).await;
            }
            if session.has_pending_input() {
                return Ok(Continuation::Run);
            }
            if collaboration.active_count() == 0 {
                return Ok(Continuation::Finish);
            }
            tokio::select! {_=wake=>{},_=signal.cancelled()=>{},_=session.lifetime.cancelled()=>{},_=collaboration.wait_for_change(revision,signal)=>{}}
        }
    }
}
async fn settle_stopped(
    collaboration: &SdkCollaboration,
    session: &NativeSession,
) -> Result<Continuation> {
    collaboration.stop_all().await?;
    loop {
        let revision = collaboration.revision();
        if session.lifetime.is_cancelled() {
            return Ok(Continuation::Closed);
        }
        if collaboration.active_count() == 0 {
            return Ok(Continuation::Finish);
        }
        collaboration
            .wait_for_change(revision, &session.lifetime)
            .await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn result(answer: &str, input: f64, turns: u64) -> Value {
        json!({"type":"result","subtype":"success","is_error":false,"result":answer,"num_turns":turns,"duration_api_ms":3,"permission_denials":[],"modelUsage":{"fixture":{"input_tokens":input,"output_tokens":1,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"total_cost_usd":0.25,"contextWindow":200000}}})
    }
    #[test]
    fn continuations_emit_one_init_one_result_and_last_substantive_answer() {
        let mut stream = CollaborationStream::at(100);
        let init = json!({"type":"system","subtype":"init"});
        assert!(stream.accept(init.clone()).is_some());
        assert!(stream.accept(result("First answer", 10.0, 2)).is_none());
        assert_eq!(stream.completed_turns(), 2);
        assert!(stream.accept(init).is_none());
        assert!(stream.accept(result("\u{feff} ", 5.0, 1)).is_none());
        assert!(stream
            .accept(json!({"type":"system","subtype":"session_state_changed","state":"idle"}))
            .is_none());
        let output=stream.finish_at(json!({"child":{"input_tokens":7,"output_tokens":2,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"total_cost_usd":0.125,"contextWindow":200000}}),false,130);
        assert_eq!(output.len(), 2);
        assert_eq!(output[0]["result"], "First answer");
        assert_eq!(output[0]["num_turns"], 3);
        assert_eq!(output[0]["duration_ms"], 30.0);
        assert_eq!(output[0]["usage"]["input_tokens"], 22.0);
        assert_eq!(output[0]["total_cost_usd"], 0.625);
        assert_eq!(output[1]["state"], "idle");
    }
    #[test]
    fn cancellation_keeps_accounting_without_success_claim() {
        let mut stream = CollaborationStream::at(1);
        stream.accept(result("partial", 10.0, 1));
        let output = stream.finish_at(json!({}), true, 2);
        assert_eq!(output[0]["subtype"], "error_during_execution");
        assert_eq!(output[0]["errors"], json!(["Operation was aborted"]));
        assert_eq!(output[0]["usage"]["input_tokens"], 10.0);
    }
}

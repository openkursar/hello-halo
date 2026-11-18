use crate::{
    core::loop_owner::LoopExecution,
    error::{Error, Result},
    harness::{ResolvedHarness, TextId},
    tools::ToolRuntime,
};
use serde_json::Value;
use std::time::Duration;
use tokio_util::sync::CancellationToken;

/// Local collaboration state to carry into the compacted history. Hosted
/// collaboration supplies its own text through `PreCompact` hooks.
pub async fn attachment(
    session: &LoopExecution,
    tools: &ToolRuntime,
    cancellation: &CancellationToken,
    harness: &ResolvedHarness,
) -> Result<Option<Value>> {
    let reading = cancellation.child_token();
    let read = async {
        let state = tools.collaboration_compact_state(&reading).await?;
        Ok::<_, Error>(crate::collaboration::snapshot::render(&state, harness))
    };
    let result = tokio::select! {
        biased;
        _ = cancellation.cancelled() => return Err(Error::cancelled()),
        result = tokio::time::timeout(Duration::from_secs(5), read) => match result {
            Ok(result) => result,
            Err(_) => { reading.cancel(); Err(Error::new("COLLABORATION_STATE_TIMEOUT", "Collaboration state read timed out")) },
        },
    };
    let text = match result {
        Ok(text) => text,
        Err(error) => {
            if cancellation.is_cancelled() { return Err(Error::cancelled()); }
            tracing::warn!(session_id=%session.session_id,code=%error.code,"Collaboration state could not be restored at compaction; installing an explicit recovery notice");
            Some(harness.text(TextId::ContextCompactionCollaborationUnavailable).to_owned())
        }
    };
    Ok(text.map(|text| super::context::message(&text, harness)))
}

use crate::{decode, encode, failure};
use halo_core::{error::Error, harness, search::CodeSearchService};
use napi::{Env, JsFunction, JsObject, Result};
use napi_derive::napi;
use std::{collections::HashMap, sync::{Arc, Mutex}};
use tokio_util::sync::CancellationToken;

struct SearchOwner {
    service: CodeSearchService,
    operations: Mutex<HashMap<String, CancellationToken>>,
    log: Arc<SearchLog>,
}
struct SearchLog(Arc<crate::host_callbacks::Callbacks>);
impl halo_core::logging::LogSink for SearchLog {
    fn write(&self, record: serde_json::Value) { self.0.notify("log", record); }
}
impl SearchOwner {
    fn abort(&self) {
        let operations: Vec<_> = self.operations.lock().unwrap().values().cloned().collect();
        for operation in operations { operation.cancel(); }
        self.service.abort_now();
    }
}
struct PendingOperation {
    owner: Arc<SearchOwner>,
    id: String,
}
impl Drop for PendingOperation {
    fn drop(&mut self) { self.owner.operations.lock().unwrap().remove(&self.id); }
}

#[napi]
pub struct NativeCodeSearchService {
    owner: Arc<SearchOwner>,
}
#[napi]
impl NativeCodeSearchService {
    #[napi(constructor)]
    pub fn new(mut env: Env, options: String, callback: JsFunction) -> Result<Self> {
        let options = decode(&options)?;
        crate::with_runtime(|| {
            let pool = crate::environment::code_search_pool(env)?;
            let log = Arc::new(SearchLog(crate::host_callbacks::Callbacks::new_named(env, &callback, "Halo code search diagnostics")?));
            let owner = Arc::new(SearchOwner {
                service: CodeSearchService::new_with_pool(options, pool).map_err(failure)?,
                operations: Mutex::new(HashMap::new()),
                log,
            });
            crate::environment::track(&mut env, &owner, SearchOwner::abort, "code search service")?;
            Ok(Self { owner })
        })
    }

    #[napi]
    pub fn search(&self, env: Env, request: String, id: String, aborted: bool) -> Result<JsObject> {
        let request = decode(&request)?;
        let cancellation = CancellationToken::new();
        if aborted { cancellation.cancel(); }
        {
            let mut operations = self.owner.operations.lock().unwrap();
            if operations.contains_key(&id) {
                return Err(failure(Error::new("DUPLICATE_OPERATION", "Code search operation is already active")));
            }
            operations.insert(id.clone(), cancellation.clone());
        }
        let pending = PendingOperation { owner: self.owner.clone(), id };
        crate::promises::spawn(env, halo_core::logging::with_sink(self.owner.log.clone(), async move {
            let result = pending.owner.service.search(request, &cancellation).await.map_err(failure)?;
            encode(&result)
        }), |_env, value| Ok(value))
    }

    #[napi]
    pub fn cancel(&self, id: String) {
        let cancellation = self.owner.operations.lock().unwrap().get(&id).cloned();
        if let Some(cancellation) = cancellation { cancellation.cancel(); }
    }

    #[napi]
    pub fn dispose(&self, env: Env) -> Result<JsObject> {
        let closing = self.owner.service.prepare_dispose();
        crate::promises::spawn(env, halo_core::logging::with_sink(self.owner.log.clone(), async move { closing.await; Ok(()) }), |_env, value| Ok(value))
    }
}

#[napi]
pub fn code_search_diagnostics(env: Env) -> Result<String> {
    encode(&crate::environment::code_search_pool(env)?.diagnostics())
}

#[napi]
pub fn code_search_value(method: String, payload: String) -> Result<String> {
    let args = decode(&payload)?;
    let baseline = harness::baseline();
    let value = match method.as_str() {
        "definition" => baseline.resource(harness::ResourceId::CodeSearchDefinition),
        "result" => halo_core::tools::format_code_search_result(&args[0], &baseline),
        "error" => halo_core::tools::failure(if args[0].is_null() {
            baseline.text(harness::TextId::ToolsCodeSearchUnavailable).to_owned()
        } else {
            Error::from_host(args[0].clone()).render_for(&baseline)
        }),
        _ => return Err(failure(Error::new("UNKNOWN_OPERATION", "Unknown code search operation"))),
    };
    encode(&value)
}

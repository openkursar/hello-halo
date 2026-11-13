use halo_core::error::{Error as CoreError, Result as CoreResult};
use napi::{Env, JsFunction, JsObject, JsString, JsUnknown, NapiRaw, NapiValue, Result, Status};
use serde_json::Value;
use std::{
    cell::RefCell,
    collections::HashMap,
    ffi::c_void,
    future::Future,
    ptr,
    rc::Rc,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, RwLock,
    },
    task::{Context, Poll, Waker},
};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;

type Pending = Arc<Mutex<HashMap<u64, oneshot::Sender<CoreResult<Value>>>>>;
static NEXT_ROUTER: AtomicU64 = AtomicU64::new(1);
struct Frame {
    env: Env,
    callback: JsFunction,
}
thread_local! { static FRAMES: RefCell<HashMap<u64, Rc<Frame>>> = RefCell::new(HashMap::new()); }
struct Call {
    name: String,
    input: String,
    reference: Option<u64>,
}
#[derive(Clone, Copy)]
enum ReferenceSource {
    Execution = 0,
    Resources = 1,
}
type References = Arc<Mutex<[(u64, bool); 2]>>;
struct ReferenceChange {
    source: ReferenceSource,
    generation: u64,
    active: bool,
    handle: Arc<CallbackHandle>,
    applied: References,
}
impl ReferenceChange {
    fn apply(&self, env: Env) -> CoreResult<Value> {
        let mut applied = self.applied.lock().unwrap();
        let source = self.source as usize;
        if self.generation <= applied[source].0 {
            return Ok(Value::Null);
        }
        let previous = applied.iter().any(|(_, active)| *active);
        let active = self.active
            || applied
                .iter()
                .enumerate()
                .any(|(index, (_, active))| index != source && *active);
        if active != previous {
            let handle = self.handle.read().unwrap();
            let handle = handle.ok_or_else(CoreError::cancelled)?;
            let status = unsafe {
                if active {
                    napi::sys::napi_ref_threadsafe_function(env.raw(), handle)
                } else {
                    napi::sys::napi_unref_threadsafe_function(env.raw(), handle)
                }
            };
            if status == napi::sys::Status::napi_closing {return Err(CoreError::cancelled());}
            if status != napi::sys::Status::napi_ok {
                return Err(bridge_error(Status::from(status)));
            }
        }
        applied[source] = (self.generation, self.active);
        Ok(Value::Null)
    }
}
struct CallData {
    reference_change: Option<ReferenceChange>,
    call: Call,
    pending: Pending,
    closed: CancellationToken,
    reply: Option<std::sync::mpsc::SyncSender<CoreResult<Value>>>,
}
impl CallData {
    fn reject(&mut self, error: CoreError) {
        if let Some(reply) = self.reply.take() {
            let _ = reply.send(Err(error));
        } else if let Some(reference) = self.call.reference {
            if let Some(reply) = self.pending.lock().unwrap().remove(&reference) {
                let _ = reply.send(Err(error));
            }
        }
    }
}
type CallbackHandle = RwLock<Option<napi::sys::napi_threadsafe_function>>;
struct ThreadsafeCallback {
    handle: Arc<CallbackHandle>,
    referenced: References,
}
unsafe extern "C" fn finalize_callback(
    _env: napi::sys::napi_env,
    data: *mut c_void,
    _hint: *mut c_void,
) {
    let handle = unsafe { Arc::from_raw(data.cast::<CallbackHandle>()) };
    handle
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .take();
}
unsafe impl Send for ThreadsafeCallback {}
unsafe impl Sync for ThreadsafeCallback {}
impl ThreadsafeCallback {
    fn new(env: Env, callback: Option<&JsFunction>, resource: &str) -> Result<Self> {
        let name = env.create_string(resource)?;
        let state = Arc::new(RwLock::new(None));
        let retained = Arc::into_raw(state.clone()).cast_mut().cast::<c_void>();
        let mut handle = ptr::null_mut();
        let status = unsafe {
            napi::sys::napi_create_threadsafe_function(
                env.raw(),
                callback
                    .map(|callback| callback.raw())
                    .unwrap_or(ptr::null_mut()),
                ptr::null_mut(),
                name.raw(),
                0,
                1,
                retained,
                Some(finalize_callback),
                ptr::null_mut(),
                Some(call_javascript),
                &mut handle,
            )
        };
        if status != napi::sys::Status::napi_ok {
            unsafe {
                drop(Arc::from_raw(retained.cast::<CallbackHandle>()));
            }
            return Err(napi::Error::from_status(status.into()));
        }
        *state.write().unwrap() = Some(handle);
        let status = unsafe { napi::sys::napi_unref_threadsafe_function(env.raw(), handle) };
        if status != napi::sys::Status::napi_ok {
            unsafe {
                napi::sys::napi_release_threadsafe_function(
                    handle,
                    napi::sys::ThreadsafeFunctionReleaseMode::abort,
                );
            }
            return Err(napi::Error::from_status(status.into()));
        }
        Ok(Self {
            handle: state,
            referenced: Arc::new(Mutex::new([(0, false); 2])),
        })
    }
    fn send(&self, call: CallData) -> CoreResult<()> {
        let handle = self.handle.read().unwrap();
        let Some(handle) = *handle else {
            return Err(CoreError::cancelled());
        };
        let data = Box::into_raw(Box::new(call));
        let status = unsafe {
            napi::sys::napi_call_threadsafe_function(
                handle,
                data.cast(),
                napi::sys::ThreadsafeFunctionCallMode::nonblocking,
            )
        };
        if status != napi::sys::Status::napi_ok {
            unsafe {
                drop(Box::from_raw(data));
            }
            return Err(bridge_error(Status::from(status)));
        }
        Ok(())
    }
    fn shutdown(&self) {
        let mut state = self
            .handle
            .write()
            .unwrap_or_else(|error| error.into_inner());
        if let Some(handle) = state.take() {
            let status = unsafe {
                napi::sys::napi_release_threadsafe_function(
                    handle,
                    napi::sys::ThreadsafeFunctionReleaseMode::abort,
                )
            };
            if status != napi::sys::Status::napi_ok && status != napi::sys::Status::napi_closing {
                eprintln!(
                    "[Collaboration] Callback transport shutdown failed: {}",
                    Status::from(status)
                );
            }
        }
    }
}
impl Drop for ThreadsafeCallback {
    fn drop(&mut self) {
        self.shutdown();
    }
}

unsafe extern "C" fn call_javascript(
    env: napi::sys::napi_env,
    callback: napi::sys::napi_value,
    _context: *mut c_void,
    data: *mut c_void,
) {
    if data.is_null() {
        return;
    }
    // Node also drains queued calls after the environment can no longer execute JavaScript.
    let mut data = unsafe { Box::from_raw(data.cast::<CallData>()) };
    if env.is_null() || data.closed.is_cancelled() {
        data.reject(CoreError::cancelled());
        return;
    }
    if data
        .call
        .reference
        .is_some_and(|id| !data.pending.lock().unwrap().contains_key(&id))
    {
        return;
    }
    let env = unsafe { Env::from_raw(env) };
    if let Some(change) = data.reference_change.take() {
        let result = change.apply(env);
        if let Some(reply) = data.reply.take() {
            let _ = reply.send(result);
        }
        return;
    }
    if callback.is_null() {
        data.reject(CoreError::cancelled());
        return;
    }
    let callback = unsafe { JsFunction::from_raw_unchecked(env.raw(), callback) };
    match invoke(env, &callback, &data.call, data.pending.clone()) {
        Ok(value) => {
            if data.call.reference.is_none() {
                let value = value
                    .coerce_to_string()
                    .and_then(|value| value.into_utf8()?.into_owned())
                    .map_err(bridge_error)
                    .and_then(|value| response(&value));
                if let Some(reply) = data.reply.take() {
                    let _ = reply.send(value);
                } else if let Err(error) = value {
                    eprintln!(
                        "[Collaboration] Callback notification failed: operation={} code={}",
                        data.call.name, error.code
                    );
                }
            }
        }
        Err(error) => data.reject(bridge_error(error)),
    }
}
fn invoke(env: Env, callback: &JsFunction, call: &Call, pending: Pending) -> Result<JsUnknown> {
    let complete = if let Some(reference) = call.reference {
        env.create_function_from_closure("completeCollaborationCallback", move |context| {
            let value = context.get::<JsString>(0)?.into_utf8()?.into_owned()?;
            let reply = pending.lock().unwrap().remove(&reference);
            if let Some(reply) = reply {
                let _ = reply.send(response(&value));
            }
            context.env.get_undefined()
        })?
        .into_unknown()
    } else {
        env.get_undefined()?.into_unknown()
    };
    callback.call(
        None,
        &[
            env.get_null()?.into_unknown(),
            env.create_string(&call.name)?.into_unknown(),
            env.create_string(&call.input)?.into_unknown(),
            env.get_boolean(call.reference.is_some())?.into_unknown(),
            complete,
        ],
    )
}
pub struct Callbacks {
    owner_thread: std::thread::ThreadId,
    owner_env: usize,
    id: u64,
    callback: ThreadsafeCallback,
    pending: Pending,
    closed: CancellationToken,
    next_call: AtomicU64,
}
struct Scope {
    id: u64,
    previous: Option<Rc<Frame>>,
}
impl Drop for Scope {
    fn drop(&mut self) {
        FRAMES.with(|frames| {
            let mut frames = frames.borrow_mut();
            if let Some(previous) = self.previous.take() {
                frames.insert(self.id, previous);
            } else {
                frames.remove(&self.id);
            }
        });
    }
}
struct PendingGuard {
    pending: Pending,
    reference: u64,
}
impl Drop for PendingGuard {
    fn drop(&mut self) {
        self.pending.lock().unwrap().remove(&self.reference);
    }
}
fn bridge_error(error: impl std::fmt::Display) -> CoreError {
    CoreError::new("COLLABORATION_CALLBACK", error.to_string())
}
pub(crate) fn decode_callback_reply(result: &str, error: Option<&str>) -> (Value, Option<Value>) {
    let decoded = || -> std::result::Result<_, serde_json::Error> {
        Ok((serde_json::from_str(result)?, error.map(serde_json::from_str).transpose()?))
    };
    // Rejected wire data still consumes its original pending reply.
    decoded().unwrap_or_else(|error| (Value::Null, Some(serde_json::json!({
        "name":"Error", "code":"HOST_CALLBACK_RESPONSE_ENCODING", "message":error.to_string()
    }))))
}
fn response(value: &str) -> CoreResult<Value> {
    let value: Value = serde_json::from_str(value).map_err(bridge_error)?;
    if let Some(encoding) = value.get("encoding") {
        if encoding != "js-value-v1" { return Err(CoreError::new("HOST_DATA_ENCODING", "Unknown host data encoding")); }
        let field = if value["ok"] == true { "value" } else { "error" };
        let document = halo_core::js::wire::WireDocument::from_json(value[field].clone()).map_err(bridge_error)?;
        let decoded = document.clone().decode().map_err(bridge_error)?;
        return if value["ok"] == true { Ok(document.to_json()) } else { Err(CoreError::from_host_data(decoded)) };
    }
    if value["ok"] == true {
        return Ok(value["value"].clone());
    }
    let mut error=CoreError::from_host(value["error"].clone());
    if value["error"]["code"].as_str().is_none(){error.code="COLLABORATION_CALLBACK".into();}
    if value["error"]["message"].as_str().is_none(){error.message="A collaboration callback failed".into();}
    Err(error)
}
impl Callbacks {
    pub fn new(env: Env, callback: &JsFunction) -> Result<Arc<Self>> {
        Self::create(env, Some(callback), "Halo collaboration callbacks")
    }
    pub fn new_named(env: Env, callback: &JsFunction, resource: &str) -> Result<Arc<Self>> {
        Self::create(env, Some(callback), resource)
    }
    pub fn new_activity(env: Env) -> Result<Arc<Self>> {
        Self::create(env, None, "Halo native activity")
    }
    fn create(mut env: Env, callback: Option<&JsFunction>, resource: &str) -> Result<Arc<Self>> {
        halo_core::logging::initialize();
        let result = Arc::new(Self {
            owner_thread: std::thread::current().id(),
            owner_env: env.raw() as usize,
            id: NEXT_ROUTER.fetch_add(1, Ordering::Relaxed),
            callback: ThreadsafeCallback::new(env, callback, resource)?,
            pending: Arc::new(Mutex::new(HashMap::new())),
            closed: CancellationToken::new(),
            next_call: AtomicU64::new(1),
        });
        crate::environment::track(&mut env, &result, Self::shutdown, "native host callbacks")?;
        Ok(result)
    }
    pub fn scoped<T>(&self, env: Env, callback: JsFunction, run: impl FnOnce() -> T) -> T {
        let previous = FRAMES.with(|frames| {
            frames
                .borrow_mut()
                .insert(self.id, Rc::new(Frame { env, callback }))
        });
        let _scope = Scope {
            id: self.id,
            previous,
        };
        run()
    }
    fn direct(&self, call: &Call) -> Option<Result<JsUnknown>> {
        let frame = FRAMES.with(|frames| frames.borrow().get(&self.id).cloned())?;
        Some(invoke(
            frame.env,
            &frame.callback,
            call,
            self.pending.clone(),
        ))
    }
    pub fn sync(&self, name: &str, input: Value) -> CoreResult<Value> {
        if self.closed.is_cancelled() {
            return Err(CoreError::cancelled());
        }
        let call = Call {
            name: name.into(),
            input: input.to_string(),
            reference: None,
        };
        if let Some(result) = self.direct(&call) {
            return response(
                &result
                    .map_err(bridge_error)?
                    .coerce_to_string()
                    .and_then(|value| value.into_utf8()?.into_owned())
                    .map_err(bridge_error)?,
            );
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.callback.send(CallData {
            reference_change: None,
            call,
            pending: self.pending.clone(),
            closed: self.closed.clone(),
            reply: Some(sender),
        })?;
        self.receive(receiver)
    }
    fn receive(&self, receiver: std::sync::mpsc::Receiver<CoreResult<Value>>) -> CoreResult<Value> {
        let receive = || loop {
            match receiver.recv_timeout(std::time::Duration::from_millis(50)) {
                Ok(value) => return value,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(CoreError::cancelled())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) if self.closed.is_cancelled() => {
                    return Err(CoreError::cancelled())
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            }
        };
        if tokio::runtime::Handle::try_current().is_ok() {
            tokio::task::block_in_place(receive)
        } else {
            receive()
        }
    }
    pub fn set_referenced_at(&self, env: Env, generation: u64, active: bool) -> CoreResult<()> {
        self.update_reference(Some(env), ReferenceSource::Execution, generation, active)
    }
    pub fn set_referenced(&self, generation: u64, active: bool) -> CoreResult<()> {
        self.update_reference(None, ReferenceSource::Execution, generation, active)
    }
    pub fn set_resource_referenced_at(
        &self,
        env: Env,
        generation: u64,
        active: bool,
    ) -> CoreResult<()> {
        self.update_reference(Some(env), ReferenceSource::Resources, generation, active)
    }
    pub fn set_resource_referenced(&self, generation: u64, active: bool) -> CoreResult<()> {
        self.update_reference(None, ReferenceSource::Resources, generation, active)
    }
    fn update_reference(
        &self,
        env: Option<Env>,
        source: ReferenceSource,
        generation: u64,
        active: bool,
    ) -> CoreResult<()> {
        if self.closed.is_cancelled() {
            return Err(CoreError::cancelled());
        }
        if self.callback.referenced.lock().unwrap()[source as usize].0 >= generation {
            return Ok(());
        }
        let change = ReferenceChange {
            source,
            generation,
            active,
            handle: self.callback.handle.clone(),
            applied: self.callback.referenced.clone(),
        };
        if let Some(env) = env
            .or_else(|| FRAMES.with(|frames| frames.borrow().get(&self.id).map(|frame| frame.env)))
            .or_else(|| {
                (std::thread::current().id() == self.owner_thread)
                    .then(|| unsafe { Env::from_raw(self.owner_env as napi::sys::napi_env) })
            })
        {
            change.apply(env)?;
            return Ok(());
        }
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        self.callback.send(CallData {
            reference_change: Some(change),
            call: Call {
                name: String::new(),
                input: String::new(),
                reference: None,
            },
            pending: self.pending.clone(),
            closed: self.closed.clone(),
            reply: Some(sender),
        })?;
        self.receive(receiver)?;
        Ok(())
    }
    pub async fn asynchronous(&self, name: &str, input: Value) -> CoreResult<Value> {
        if self.closed.is_cancelled() {
            return Err(CoreError::cancelled());
        }
        let reference = self.next_call.fetch_add(1, Ordering::Relaxed);
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap().insert(reference, sender);
        let _pending = PendingGuard {
            pending: self.pending.clone(),
            reference,
        };
        let call = Call {
            name: name.into(),
            input: input.to_string(),
            reference: Some(reference),
        };
        match self.direct(&call) {
            Some(result) => {
                result.map_err(bridge_error)?;
            }
            None => self.callback.send(CallData {
                reference_change: None,
                call,
                pending: self.pending.clone(),
                closed: self.closed.clone(),
                reply: None,
            })?,
        }
        tokio::select! { _=self.closed.cancelled()=>Err(CoreError::cancelled()), result=receiver=>result.map_err(bridge_error)? }
    }
    pub fn notify(&self, name: &str, input: Value) {
        if self.closed.is_cancelled() {
            return;
        }
        if let Err(error) = self.callback.send(CallData {
            reference_change: None,
            call: Call {
                name: name.into(),
                input: input.to_string(),
                reference: None,
            },
            pending: self.pending.clone(),
            closed: self.closed.clone(),
            reply: None,
        }) {
            if !self.closed.is_cancelled() {
                eprintln!(
                    "[Collaboration] Callback notification failed: operation={name} code={}",
                    error.code
                );
            }
        }
    }
    pub fn notify_scoped(&self, name: &str, input: Value) {
        if self.closed.is_cancelled() {
            return;
        }
        let call = Call {
            name: name.into(),
            input: input.to_string(),
            reference: None,
        };
        if let Some(result) = self.direct(&call) {
            if let Err(error) = result {
                eprintln!("[Collaboration] Scoped callback notification failed: operation={name} status={error}");
            }
        } else {
            self.notify(name, input);
        }
    }
    pub fn shutdown(&self) {
        self.closed.cancel();
        for reply in std::mem::take(&mut *self.pending.lock().unwrap()).into_values() {
            let _ = reply.send(Err(CoreError::cancelled()));
        }
        self.callback.shutdown();
    }
}
pub fn start(
    env: Env,
    callbacks: Arc<Callbacks>,
    callback: JsFunction,
    future: impl Future<Output = CoreResult<Value>> + Send + 'static,
) -> Result<JsObject> {
    start_with_completion(env, callbacks, callback, future, |_env| Ok(()))
}

pub fn start_with_completion(
    env: Env,
    callbacks: Arc<Callbacks>,
    callback: JsFunction,
    future: impl Future<Output = CoreResult<Value>> + Send + 'static,
    complete: impl FnOnce(&mut Env) -> Result<()> + Send + 'static,
) -> Result<JsObject> {
    crate::with_runtime(|| {
        let mut future = Box::pin(future);
        let initial = callbacks.scoped(env, callback, || {
            future
                .as_mut()
                .poll(&mut Context::from_waker(Waker::noop()))
        });
        crate::promises::spawn(
            env,
            async move {
                Ok(match initial {
                    Poll::Ready(result) => result,
                    Poll::Pending => future.await,
                })
            },
            move |env, result| {
                complete(env)?;
                let value = result.map_err(crate::failure)?;
                env.create_string(&crate::encode(&value)?)
            },
        )
    })
}

pub(crate) fn bind_resource_activity(
    activity: &Arc<halo_core::resource_activity::ResourceActivity>,
    callbacks: &Arc<Callbacks>,
) -> halo_core::resource_activity::ResourceSubscription {
    let callbacks = Arc::downgrade(callbacks);
    activity.subscribe(move|snapshot|{
        if let Some(callbacks)=callbacks.upgrade(){
            if let Err(error)=callbacks.set_resource_referenced(snapshot.generation,snapshot.active){
                if error.code!="ABORTED"{eprintln!("[SDK:Native] Resource activity reference could not be updated: generation={} active={} code={}",snapshot.generation,snapshot.active,error.code);}
            }
        }
    })
}

pub(crate) fn bind_execution_activity(
    activity: &Arc<halo_core::resource_activity::ResourceActivity>,
    callbacks: &Arc<Callbacks>,
) -> halo_core::resource_activity::ResourceSubscription {
    let callbacks = Arc::downgrade(callbacks);
    activity.subscribe(move|snapshot|{
        if let Some(callbacks)=callbacks.upgrade(){
            if let Err(error)=callbacks.set_referenced(snapshot.generation,snapshot.active){
                if error.code!="ABORTED"{eprintln!("[SDK:Native] Execution activity reference could not be updated: generation={} active={} code={}",snapshot.generation,snapshot.active,error.code);}
            }
        }
    })
}

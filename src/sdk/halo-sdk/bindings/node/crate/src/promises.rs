use napi::{
    bindgen_prelude::ToNapiValue, Env, Error, JsObject, NapiRaw, NapiValue, Result, Status,
};
use std::{
    ffi::c_void,
    future::Future,
    panic::{catch_unwind, AssertUnwindSafe},
    ptr,
    sync::{Arc, RwLock},
};
use tokio_util::sync::CancellationToken;

type Resolver = Box<dyn FnOnce(Env) -> Result<napi::sys::napi_value> + Send>;
struct Payload(Resolver);
struct State {
    deferred: napi::sys::napi_deferred,
    handle: RwLock<Option<napi::sys::napi_threadsafe_function>>,
    closed: CancellationToken,
}
unsafe impl Send for State {}
unsafe impl Sync for State {}

unsafe extern "C" fn finalize(_env: napi::sys::napi_env, data: *mut c_void, _hint: *mut c_void) {
    let state = unsafe { Arc::from_raw(data.cast::<State>()) };
    state.closed.cancel();
    state
        .handle
        .write()
        .unwrap_or_else(|error| error.into_inner())
        .take();
}
unsafe extern "C" fn deliver(
    env: napi::sys::napi_env,
    _callback: napi::sys::napi_value,
    context: *mut c_void,
    data: *mut c_void,
) {
    if data.is_null() {
        return;
    }
    let payload = unsafe { Box::from_raw(data.cast::<Payload>()) };
    if env.is_null() {
        return;
    }
    let state = unsafe { &*context.cast::<State>() };
    if state.closed.is_cancelled() {
        return;
    }
    let result = catch_unwind(AssertUnwindSafe(|| {
        (payload.0)(unsafe { Env::from_raw(env) })
    }))
    .unwrap_or_else(|_| {
        Err(Error::new(
            Status::GenericFailure,
            "Panic while resolving native result",
        ))
    });
    let status = match result {
        Ok(value) => unsafe { napi::sys::napi_resolve_deferred(env, state.deferred, value) },
        Err(error) => unsafe {
            napi::sys::napi_reject_deferred(
                env,
                state.deferred,
                napi::JsError::from(error).into_value(env),
            )
        },
    };
    if status != napi::sys::Status::napi_ok && status != napi::sys::Status::napi_closing {
        eprintln!(
            "[SDK:Native] Promise settlement failed: status={}",
            Status::from(status)
        );
    }
}
impl State {
    fn new(env: Env, referenced: bool) -> Result<(Arc<Self>, JsObject)> {
        let mut promise = ptr::null_mut();
        let mut deferred = ptr::null_mut();
        let status =
            unsafe { napi::sys::napi_create_promise(env.raw(), &mut deferred, &mut promise) };
        if status != napi::sys::Status::napi_ok {
            return Err(Error::from_status(status.into()));
        }
        let state = Arc::new(Self {
            deferred,
            handle: RwLock::new(None),
            closed: CancellationToken::new(),
        });
        let name = env.create_string("Halo native promise")?;
        let retained = Arc::into_raw(state.clone()).cast_mut().cast::<c_void>();
        let mut handle = ptr::null_mut();
        let status = unsafe {
            napi::sys::napi_create_threadsafe_function(
                env.raw(),
                ptr::null_mut(),
                ptr::null_mut(),
                name.raw(),
                0,
                1,
                retained,
                Some(finalize),
                retained,
                Some(deliver),
                &mut handle,
            )
        };
        if status != napi::sys::Status::napi_ok {
            unsafe {
                drop(Arc::from_raw(retained.cast::<State>()));
            }
            return Err(Error::from_status(status.into()));
        }
        *state.handle.write().unwrap() = Some(handle);
        if !referenced {
            let status = unsafe { napi::sys::napi_unref_threadsafe_function(env.raw(), handle) };
            if status != napi::sys::Status::napi_ok {
                state.closed.cancel();
                state.handle.write().unwrap().take();
                unsafe {
                    napi::sys::napi_release_threadsafe_function(
                        handle,
                        napi::sys::ThreadsafeFunctionReleaseMode::abort,
                    );
                }
                return Err(Error::from_status(status.into()));
            }
        }
        Ok((state, unsafe {
            JsObject::from_raw_unchecked(env.raw(), promise)
        }))
    }
    fn complete(&self, resolver: Resolver) {
        let handle = self
            .handle
            .read()
            .unwrap_or_else(|error| error.into_inner());
        let Some(handle) = *handle else { return };
        if self.closed.is_cancelled() {
            return;
        }
        let data = Box::into_raw(Box::new(Payload(resolver)));
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
        }
        if status != napi::sys::Status::napi_closing {
            let released = unsafe {
                napi::sys::napi_release_threadsafe_function(
                    handle,
                    napi::sys::ThreadsafeFunctionReleaseMode::release,
                )
            };
            if released != napi::sys::Status::napi_ok && released != napi::sys::Status::napi_closing
            {
                eprintln!(
                    "[SDK:Native] Promise transport release failed: status={}",
                    Status::from(released)
                );
            }
        }
    }
}

fn spawn_with_reference<T, V, F, R>(
    env: Env,
    future: F,
    resolver: R,
    referenced: bool,
) -> Result<JsObject>
where
    T: Send + 'static,
    V: ToNapiValue + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
    R: FnOnce(&mut Env, T) -> Result<V> + Send + 'static,
{
    crate::with_runtime(|| {
        let (state, promise) = State::new(env, referenced)?;
        let mut work = halo_core::runtime::spawn(future);
        halo_core::runtime::spawn(async move {
            let result = tokio::select! {
                _ = state.closed.cancelled() => { work.abort(); return; },
                result = &mut work => match result {
                    Ok(result) => result,
                    Err(error) => Err(Error::new(Status::GenericFailure, format!("Native asynchronous operation stopped: {error}"))),
                },
            };
            state.complete(Box::new(move |mut env| {
                let value = resolver(&mut env, result?)?;
                unsafe { V::to_napi_value(env.raw(), value) }
            }));
        });
        Ok(promise)
    })
}

pub(crate) fn spawn<T, V, F, R>(env: Env, future: F, resolver: R) -> Result<JsObject>
where
    T: Send + 'static,
    V: ToNapiValue + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
    R: FnOnce(&mut Env, T) -> Result<V> + Send + 'static,
{
    spawn_with_reference(env, future, resolver, true)
}
pub(crate) fn spawn_unref<T, V, F, R>(env: Env, future: F, resolver: R) -> Result<JsObject>
where
    T: Send + 'static,
    V: ToNapiValue + 'static,
    F: Future<Output = Result<T>> + Send + 'static,
    R: FnOnce(&mut Env, T) -> Result<V> + Send + 'static,
{
    spawn_with_reference(env, future, resolver, false)
}

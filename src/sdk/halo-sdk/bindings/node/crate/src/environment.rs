use napi::{Env, Error, Result, Status};
use halo_core::{bridge::HostServices, http::HostTrust};
use std::{
    cell::RefCell,
    collections::HashMap,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{Arc, Mutex, Weak},
};

trait Resource: Send + Sync {
    fn alive(&self) -> bool;
    fn abort(&self);
}
struct Tracked<T: Send + Sync + 'static> {
    resource: Weak<T>,
    abort: fn(&T),
    kind: &'static str,
}
impl<T: Send + Sync + 'static> Resource for Tracked<T> {
    fn alive(&self) -> bool {
        self.resource.strong_count() > 0
    }
    fn abort(&self) {
        if let Some(resource) = self.resource.upgrade() {
            if catch_unwind(AssertUnwindSafe(|| (self.abort)(&resource))).is_err() {
                eprintln!(
                    "[SDK:Native] Host environment cleanup panicked: resource={}",
                    self.kind
                );
            }
        }
    }
}
struct Scope {
    closed: Mutex<bool>,
    resources: Mutex<Vec<Box<dyn Resource>>>,
    search: Mutex<Option<SearchScope>>,
    http_trust: Arc<HostTrust>,
}
struct SearchScope {
    pool: Arc<halo_core::search::CodeSearchPool>,
    activity: Arc<halo_core::resource_activity::ResourceActivity>,
    callbacks: Arc<crate::host_callbacks::Callbacks>,
    _subscription: halo_core::resource_activity::ResourceSubscription,
}
thread_local! {static SCOPES:RefCell<HashMap<usize,Weak<Scope>>>=RefCell::new(HashMap::new());}

fn scope(env: &mut Env) -> Result<Arc<Scope>> {
    let key = env.raw() as usize;
    let existing = SCOPES.with(|scopes| scopes.borrow().get(&key).and_then(Weak::upgrade));
    let scope = if let Some(scope) = existing {
        scope
    } else {
        let scope = Arc::new(Scope {
            closed: Mutex::new(false),
            resources: Mutex::new(Vec::new()),
            search: Mutex::new(None),
            http_trust: Arc::new(HostTrust::new()),
        });
        if let Err(error) = env.add_env_cleanup_hook(scope.clone(), move |scope| {
            *scope
                .closed
                .lock()
                .unwrap_or_else(|error| error.into_inner()) = true;
            let resources = std::mem::take(
                &mut *scope
                    .resources
                    .lock()
                    .unwrap_or_else(|error| error.into_inner()),
            );
            for resource in resources.into_iter().rev() {
                resource.abort();
            }
            if let Some(search) = scope
                .search
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .take()
            {
                search.pool.abort_now();
                search.activity.close();
                search.callbacks.shutdown();
            }
            let _ = SCOPES.try_with(|scopes| scopes.borrow_mut().remove(&key));
        }) {
            return Err(error);
        }
        SCOPES.with(|scopes| {
            scopes.borrow_mut().insert(key, Arc::downgrade(&scope));
        });
        scope
    };
    Ok(scope)
}

pub(crate) fn track<T: Send + Sync + 'static>(
    env: &mut Env,
    resource: &Arc<T>,
    abort: fn(&T),
    kind: &'static str,
) -> Result<()> {
    let scope = match scope(env) {
        Ok(scope) => scope,
        Err(error) => {
            abort(resource);
            return Err(error);
        }
    };
    if *scope
        .closed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
    {
        abort(resource);
        return Err(Error::new(
            Status::Closing,
            "Native host environment is closing",
        ));
    }
    let mut resources = scope
        .resources
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    resources.retain(|resource| resource.alive());
    resources.push(Box::new(Tracked {
        resource: Arc::downgrade(resource),
        abort,
        kind,
    }));
    Ok(())
}

fn open_scope(mut env: Env) -> Result<Arc<Scope>> {
    let scope = scope(&mut env)?;
    if *scope
        .closed
        .lock()
        .unwrap_or_else(|error| error.into_inner())
    {
        return Err(Error::new(
            Status::Closing,
            "Native host environment is closing",
        ));
    }
    Ok(scope)
}

pub(crate) fn http_trust(env: Env) -> Result<Arc<HostTrust>> {
    Ok(open_scope(env)?.http_trust.clone())
}

pub(crate) fn host_services(env: Env) -> Result<HostServices> {
    Ok(HostServices {
        code_search_pool: Some(code_search_pool(env)?),
        http_trust: Some(http_trust(env)?),
    })
}

pub(crate) fn code_search_pool(env: Env) -> Result<Arc<halo_core::search::CodeSearchPool>> {
    let scope = open_scope(env)?;
    let mut search = scope
        .search
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    if let Some(search) = search.as_ref() {
        return Ok(search.pool.clone());
    }
    let pool = Arc::new(halo_core::search::CodeSearchPool::new());
    let activity = pool.resource_activity();
    let callbacks = crate::host_callbacks::Callbacks::new_activity(env)?;
    let subscription = crate::host_callbacks::bind_resource_activity(&activity, &callbacks);
    *search = Some(SearchScope {
        pool: pool.clone(),
        activity,
        callbacks,
        _subscription: subscription,
    });
    Ok(pool)
}

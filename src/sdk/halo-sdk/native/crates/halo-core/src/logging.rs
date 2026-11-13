use serde_json::{json, Map, Value};
use std::{
    fmt,
    io::Write,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Once,
    },
};
use tokio::sync::mpsc;
use tracing::{
    field::{Field, Visit},
    span::{Attributes, Id, Record},
    Event, Level, Metadata, Subscriber,
};

pub trait LogSink: Send + Sync {
    fn write(&self, record: Value);
}
struct Console;
impl LogSink for Console {
    fn write(&self, record: Value) {
        console(&record);
    }
}
pub(crate) fn console(record: &Value) {
    let fields = record["fields"]
        .as_object()
        .map(|fields| {
            fields
                .iter()
                .map(|(key, value)| {
                    format!(
                        "{key}={}",
                        value
                            .as_str()
                            .map(str::to_owned)
                            .unwrap_or_else(|| crate::js::stringify(value))
                    )
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
        .unwrap_or_default();
    let _ = writeln!(
        std::io::stderr().lock(),
        "[SDK:{}] {}{}{}",
        record["component"].as_str().unwrap_or("Native"),
        record["message"].as_str().unwrap_or(""),
        if fields.is_empty() { "" } else { " " },
        fields
    );
}
struct Channel {
    output: mpsc::Sender<Value>,
}
impl LogSink for Channel {
    fn write(&self, record: Value) {
        if self
            .output
            .try_send(json!({"kind":"log","record":record}))
            .is_err()
        {
            console(&record);
        }
    }
}
struct Fields {
    message: String,
    fields: Map<String, Value>,
}
impl Visit for Fields {
    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        let value = format!("{value:?}");
        if field.name() == "message" {
            self.message = value;
        } else {
            self.fields.insert(field.name().into(), json!(value));
        }
    }
    fn record_str(&mut self, field: &Field, value: &str) {
        if field.name() == "message" {
            self.message = value.into();
        } else {
            self.fields.insert(field.name().into(), json!(value));
        }
    }
    fn record_i64(&mut self, field: &Field, value: i64) {
        self.fields.insert(field.name().into(), json!(value));
    }
    fn record_u64(&mut self, field: &Field, value: u64) {
        self.fields.insert(field.name().into(), json!(value));
    }
    fn record_bool(&mut self, field: &Field, value: bool) {
        self.fields.insert(field.name().into(), json!(value));
    }
    fn record_f64(&mut self, field: &Field, value: f64) {
        self.fields.insert(field.name().into(), json!(value));
    }
}
struct SdkSubscriber {
    sink: Arc<dyn LogSink>,
    level: Option<Level>,
    next: AtomicU64,
}
impl SdkSubscriber {
    fn new(sink: Arc<dyn LogSink>) -> Self {
        let level = match std::env::var("AGENT_SDK_LOG_LEVEL").ok().as_deref() {
            Some("debug") => Some(Level::DEBUG),
            Some("warn") => Some(Level::WARN),
            Some("error") => Some(Level::ERROR),
            Some("silent") => None,
            _ => Some(Level::INFO),
        };
        Self {
            sink,
            level,
            next: AtomicU64::new(1),
        }
    }
}
impl Subscriber for SdkSubscriber {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.target().starts_with("halo_core")
            && self.level.is_some_and(|level| *metadata.level() <= level)
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        Id::from_u64(self.next.fetch_add(1, Ordering::Relaxed))
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn event(&self, event: &Event<'_>) {
        if !self.enabled(event.metadata()) {
            return;
        }
        let mut fields = Fields {
            message: String::new(),
            fields: Map::new(),
        };
        event.record(&mut fields);
        let target = event.metadata().target();
        let component = target
            .strip_prefix("halo_core::")
            .unwrap_or(target)
            .replace("::", ":");
        let level = match *event.metadata().level() {
            Level::ERROR => "error",
            Level::WARN => "warn",
            Level::INFO => "info",
            _ => "debug",
        };
        self.sink.write(json!({"component":component,"level":level,"message":fields.message,"fields":fields.fields}));
    }
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn max_level_hint(&self) -> Option<tracing::metadata::LevelFilter> {
        Some(
            self.level
                .map(tracing::metadata::LevelFilter::from_level)
                .unwrap_or(tracing::metadata::LevelFilter::OFF),
        )
    }
}
pub fn initialize() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        let _ = tracing::subscriber::set_global_default(SdkSubscriber::new(Arc::new(Console)));
    });
}
pub fn channel_dispatch(output: mpsc::Sender<Value>) -> tracing::Dispatch {
    tracing::Dispatch::new(SdkSubscriber::new(Arc::new(Channel { output })))
}
pub fn dispatch(sink: Arc<dyn LogSink>) -> tracing::Dispatch {
    tracing::Dispatch::new(SdkSubscriber::new(sink))
}
pub fn with_sink<F: std::future::Future>(sink: Arc<dyn LogSink>, future: F) -> impl std::future::Future<Output = F::Output> {
    use tracing::instrument::WithSubscriber;
    future.with_subscriber(dispatch(sink))
}

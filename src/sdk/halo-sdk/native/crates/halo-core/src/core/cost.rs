use serde_json::{json, Map, Value};
use std::sync::Arc;

pub type UsageObserver = Arc<dyn Fn(&Value, &str) + Send + Sync>;

const KEYS: [&str; 4] = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
];
const PRICES: [&str; 4] = [
    "inputPerMtk",
    "outputPerMtk",
    "cacheCreationPerMtk",
    "cacheReadPerMtk",
];

pub struct CostTracker {
    totals: [f64; 4],
    total_cost: f64,
    pricing: Value,
    pricing_table: Value,
    context_window: f64,
    model_usage: Map<String, Value>,
    on_usage: Option<UsageObserver>,
}

impl CostTracker {
    pub fn new(model: &str, context_window: f64, pricing_table: Value) -> Self {
        Self {
            totals: [0.0; 4],
            total_cost: 0.0,
            pricing: pricing_table[model].clone(),
            pricing_table,
            context_window,
            model_usage: Map::new(),
            on_usage: None,
        }
    }

    pub fn set_on_usage(&mut self, observer: Option<UsageObserver>) {
        self.on_usage = observer;
    }

    pub fn set_model(&mut self, model: &str) {
        self.pricing = self.pricing_table[model].clone();
    }

    pub fn add(&mut self, usage: &Value, model: Option<&str>) -> Value {
        if let Some(model) = model.filter(|model| !model.is_empty()) {
            self.set_model(model);
        }
        let amounts = KEYS.map(|key| {
            usage[key]
                .as_f64()
                .filter(|n| n.is_finite() && *n >= 0.0)
                .unwrap_or(0.0)
        });
        let cost: f64 = amounts
            .iter()
            .zip(PRICES)
            .map(|(amount, price)| amount * self.pricing[price].as_f64().unwrap_or(0.0))
            .sum::<f64>()
            / 1_000_000.0;
        let mut report = Map::new();
        for (index, key) in KEYS.iter().enumerate() {
            self.totals[index] += amounts[index];
            report.insert((*key).to_owned(), json!(amounts[index]));
        }
        self.total_cost += cost;
        report.insert("total_cost_usd".into(), json!(cost));
        report.insert("contextWindow".into(), json!(self.context_window));
        self.merge_model(model.unwrap_or("unknown"), &Value::Object(report.clone()));
        let report = Value::Object(report);
        if let Some(observer) = &self.on_usage {
            observer(&report, model.unwrap_or("unknown"));
        }
        report
    }

    fn merge_model(&mut self, model: &str, entry: &Value) {
        if let Some(existing) = self.model_usage.get_mut(model) {
            for key in KEYS.into_iter().chain(["total_cost_usd"]) {
                existing[key] = json!(
                    existing[key].as_f64().unwrap_or(0.0) + entry[key].as_f64().unwrap_or(0.0)
                );
            }
        } else {
            self.model_usage.insert(model.to_owned(), entry.clone());
        }
    }

    pub fn add_reported_usage(&mut self, entries: &Value) {
        if let Some(entries) = entries.as_object() {
            for (model, entry) in entries {
                for (index, key) in KEYS.iter().enumerate() {
                    self.totals[index] += entry[key].as_f64().unwrap_or(0.0);
                }
                self.total_cost += entry["total_cost_usd"].as_f64().unwrap_or(0.0);
                self.merge_model(model, entry);
            }
        }
    }

    pub fn add_child_snapshot(&mut self, usage: &Value, cost: f64, models: &Value) {
        for (index, key) in KEYS.iter().enumerate() {
            self.totals[index] += usage[key].as_f64().unwrap_or(0.0);
        }
        self.total_cost += cost;
        if let Some(models) = models.as_object() {
            for (model, entry) in models {
                self.merge_model(model, entry);
            }
        }
    }

    pub fn call(&mut self, method: &str, args: &Value) -> crate::error::Result<Value> {
        match method {
            "setModel" => {
                self.set_model(args[0].as_str().unwrap_or(""));
                Ok(Value::Null)
            }
            "add" => Ok(self.add(&args[0], args[1].as_str())),
            "addReportedUsage" => {
                self.add_reported_usage(&args[0]);
                Ok(Value::Null)
            }
            "addChildCost" => {
                self.add_child_snapshot(
                    &args[0]["usage"],
                    args[0]["cost"].as_f64().unwrap_or(0.0),
                    &args[0]["models"],
                );
                Ok(Value::Null)
            }
            "totalCostUsd" => Ok(json!(self.total_cost_usd())),
            "totalInputTokens" => Ok(json!(self.total_input_tokens())),
            "totalOutputTokens" => Ok(json!(self.total_output_tokens())),
            "totalCacheCreationTokens" => Ok(json!(self.total_cache_creation_tokens())),
            "totalCacheReadTokens" => Ok(json!(self.total_cache_read_tokens())),
            "totalTokens" => Ok(json!(self.total_tokens())),
            "isOverBudget" => Ok(json!(
                self.is_over_budget(crate::js::number(&args[0]).unwrap_or(f64::NAN))
            )),
            "reset" => {
                self.reset();
                Ok(Value::Null)
            }
            "getUsage" => Ok(self.usage()),
            "getModelUsage" => Ok(self.model_usage()),
            "summary" => Ok(json!(self.summary())),
            _ => Err(crate::error::Error::new(
                "UNKNOWN_CONTEXT_OPERATION",
                format!("Unknown cost tracker operation: {method}"),
            )),
        }
    }

    pub fn total_input_tokens(&self) -> f64 {
        self.totals[0]
    }
    pub fn total_output_tokens(&self) -> f64 {
        self.totals[1]
    }
    pub fn total_cache_creation_tokens(&self) -> f64 {
        self.totals[2]
    }
    pub fn total_cache_read_tokens(&self) -> f64 {
        self.totals[3]
    }

    pub fn total_cost_usd(&self) -> f64 {
        self.total_cost
    }
    pub fn total_tokens(&self) -> f64 {
        self.totals.iter().sum()
    }
    pub fn is_over_budget(&self, budget: f64) -> bool {
        self.total_cost >= budget
    }
    pub fn usage(&self) -> Value {
        Value::Object(
            KEYS.iter()
                .zip(self.totals)
                .map(|(key, value)| ((*key).to_owned(), json!(value)))
                .collect(),
        )
    }
    pub fn model_usage(&self) -> Value {
        Value::Object(self.model_usage.clone())
    }
    pub fn reset(&mut self) {
        self.totals = [0.0; 4];
        self.total_cost = 0.0;
        self.model_usage.clear();
    }
    pub fn summary(&self) -> String {
        let tokens = ryu_js::Buffer::new().format(self.total_tokens()).to_owned();
        if self.total_cost < 0.01 {
            format!("{tokens} tokens (<$0.01)")
        } else {
            format!(
                "{tokens} tokens (${})",
                crate::js::to_fixed(self.total_cost, 2)
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decimal_summary_uses_javascript_tie_breaking() {
        assert_eq!(crate::js::to_fixed(1.125, 2), "1.13");
        assert_eq!(crate::js::to_fixed(2.675, 2), "2.67");
        assert_eq!(crate::js::to_fixed(1.005, 2), "1.00");
        assert_eq!(crate::js::to_fixed(1.375, 2), "1.38");
        assert_eq!(crate::js::to_fixed(0.0, 2), "0.00");
        assert_eq!(crate::js::to_fixed(-0.0, 2), "0.00");
        assert_eq!(crate::js::to_fixed(-0.001, 2), "-0.00");
    }

    #[test]
    fn changing_models_does_not_reprice_recorded_work() {
        let mut tracker = CostTracker::new(
            "a",
            200000.0,
            json!({"a":{"inputPerMtk":1},"b":{"inputPerMtk":2}}),
        );
        tracker.add(&json!({"input_tokens":1000}), Some("a"));
        tracker.add(&json!({"input_tokens":1000}), Some("b"));
        assert!((tracker.total_cost_usd() - 0.003).abs() < 1e-12);
        assert_eq!(tracker.usage()["input_tokens"], json!(2000.0));
        assert_eq!(tracker.model_usage()["a"]["contextWindow"], json!(200000.0));
    }
}

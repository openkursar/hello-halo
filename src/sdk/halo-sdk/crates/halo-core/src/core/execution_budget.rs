use serde_json::Value;
use std::sync::Mutex;

#[derive(Default)]
pub struct ExecutionBudget {
    values: Mutex<(f64, f64)>,
}
impl ExecutionBudget {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn observe(&self, usage: &Value) {
        let cost = usage["total_cost_usd"].as_f64().unwrap_or(0.0);
        let mut values = self.values.lock().unwrap();
        values.0 += cost;
        values.1 += cost;
    }
    pub fn spent(&self) -> f64 {
        self.values.lock().unwrap().0
    }
    pub fn total(&self) -> f64 {
        self.values.lock().unwrap().1
    }
    pub fn reset_request(&self) {
        self.values.lock().unwrap().0 = 0.0;
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_reset_preserves_lifetime_cost() {
        let budget = ExecutionBudget::new();
        budget.observe(&serde_json::json!({"total_cost_usd":0.25}));
        budget.observe(&serde_json::json!({"total_cost_usd":0.5}));
        assert_eq!(budget.spent(), 0.75);
        budget.reset_request();
        assert_eq!(budget.spent(), 0.0);
        assert_eq!(budget.total(), 0.75);
        budget.observe(&serde_json::json!({"total_cost_usd":0.125}));
        assert_eq!(budget.total(), 0.875);
    }
}

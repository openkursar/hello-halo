use super::token_budget::TokenBudget;
use serde_json::Value;
use std::sync::{Arc, Mutex};

pub enum LoopBudget<'a> {
    Borrowed(&'a mut TokenBudget),
    Shared(Arc<Mutex<TokenBudget>>),
}

impl LoopBudget<'_> {
    fn read<T>(&self, operation: impl FnOnce(&TokenBudget) -> T) -> T {
        match self {
            Self::Borrowed(budget) => operation(budget),
            Self::Shared(budget) => operation(&budget.lock().unwrap()),
        }
    }
    fn write<T>(&mut self, operation: impl FnOnce(&mut TokenBudget) -> T) -> T {
        match self {
            Self::Borrowed(budget) => operation(budget),
            Self::Shared(budget) => operation(&mut budget.lock().unwrap()),
        }
    }
    pub fn context_window(&self) -> f64 {
        self.read(|budget| budget.context_window)
    }
    pub fn max_output_tokens(&self) -> f64 {
        self.read(|budget| budget.max_output_tokens)
    }
    pub fn configure_output(&mut self, thinking: Value, limit: Option<f64>) {
        self.write(|budget| budget.configure_output(thinking, limit));
    }
    pub fn estimate_request(&self, request: &Value) -> f64 {
        self.read(|budget| budget.estimate_request(request))
    }
    pub fn available_input_tokens(&self) -> f64 {
        self.read(TokenBudget::available_input_tokens)
    }
    pub fn target_input_tokens(&self) -> f64 {
        self.read(TokenBudget::target_input_tokens)
    }
    pub fn should_compact_request(&self, request: &Value) -> bool {
        self.read(|budget| budget.should_compact_request(request))
    }
    pub fn request_max_tokens(&self, tokens: f64, ceiling: Option<f64>) -> f64 {
        self.read(|budget| budget.request_max_tokens(tokens, ceiling))
    }
    pub fn observe(&mut self, request: &Value, usage: &Value) {
        self.write(|budget| budget.observe(request, usage));
    }
    pub fn reset(&mut self) {
        self.write(TokenBudget::reset);
    }
}

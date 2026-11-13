use crate::harness::{ResolvedHarness, TextId};
use serde_json::Value;

pub fn content_digest(text: &str) -> String {
    format!(
        "{}:{}",
        crate::js::utf16_len(text),
        crate::js::utf16_prefix(text, 200)
    )
}

pub struct StagnationDetector {
    window_size: f64,
    repeat_threshold: f64,
    window: Vec<Value>,
    armed: bool,
}
impl Default for StagnationDetector {
    fn default() -> Self {
        Self::new(&Value::Null)
    }
}
impl StagnationDetector {
    pub fn new(options: &Value) -> Self {
        Self {
            window_size: options["windowSize"].as_f64().unwrap_or(5.0),
            repeat_threshold: options["repeatThreshold"].as_f64().unwrap_or(2.0),
            window: Vec::new(),
            armed: true,
        }
    }
    pub fn reset(&mut self) {
        self.window.clear();
        self.armed = true;
    }
    pub fn record(&mut self, record: Value) -> Option<String> {
        self.record_with_harness(record, &crate::harness::baseline())
    }
    pub fn record_with_harness(
        &mut self,
        record: Value,
        harness: &ResolvedHarness,
    ) -> Option<String> {
        let input_repeats: Vec<_> = self
            .window
            .iter()
            .filter(|previous| {
                previous["toolName"] == record["toolName"]
                    && previous["inputDigest"] == record["inputDigest"]
            })
            .collect();
        let error_repeats = if crate::js::truthy(&record["isError"]) {
            self.window
                .iter()
                .filter(|previous| {
                    previous["toolName"] == record["toolName"]
                        && crate::js::truthy(&previous["isError"])
                        && previous["errorType"].as_str().unwrap_or("")
                            == record["errorType"].as_str().unwrap_or("")
                })
                .count()
        } else {
            0
        };
        let repeating = !input_repeats.is_empty() || error_repeats > 0;
        let considered = self.window.len() + 1;
        let input_count = input_repeats.len();
        let all_errors = crate::js::truthy(&record["isError"])
            && input_repeats
                .iter()
                .all(|previous| crate::js::truthy(&previous["isError"]));
        let same_results = !all_errors
            && input_repeats
                .iter()
                .all(|previous| previous["resultDigest"] == record["resultDigest"]);
        self.window.push(record.clone());
        if self.window.len() as f64 > self.window_size {
            let remove = ((self.window.len() as f64 - self.window_size).max(0.0) as usize)
                .min(self.window.len());
            self.window.drain(..remove);
        }
        if !self.armed {
            if !repeating {
                self.armed = true;
            }
            return None;
        }
        let name = crate::js::to_string(&record["toolName"]);
        if input_count as f64 >= self.repeat_threshold {
            let detail = if all_errors {
                harness.text(TextId::ContextStagnationAllErrors)
            } else if same_results {
                harness.text(TextId::ContextStagnationIdenticalResult)
            } else {
                ""
            };
            self.armed = false;
            return Some(harness.render(
                TextId::ContextStagnationIdenticalInput,
                &[
                    ("tool", &name),
                    ("occurrences", &(input_count + 1).to_string()),
                    ("considered", &considered.to_string()),
                    ("detail", detail),
                ],
            ));
        }
        if error_repeats as f64 >= self.repeat_threshold {
            let kind = if crate::js::truthy(&record["errorType"]) {
                harness.render(
                    TextId::ContextStagnationErrorType,
                    &[("error_type", &crate::js::to_string(&record["errorType"]))],
                )
            } else {
                String::new()
            };
            self.armed = false;
            return Some(harness.render(
                TextId::ContextStagnationSameError,
                &[
                    ("tool", &name),
                    ("error_type", &kind),
                    ("occurrences", &(error_repeats + 1).to_string()),
                    ("considered", &considered.to_string()),
                ],
            ));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn detector_and_digests_match_fixture_sequences() {
        let fixture: Value =
            serde_json::from_str(include_str!("fixtures/stagnation.json")).unwrap();
        for case in fixture["digests"].as_array().unwrap() {
            assert_eq!(
                content_digest(case["text"].as_str().unwrap()),
                case["expected"].as_str().unwrap()
            );
        }
        for case in fixture["sequences"].as_array().unwrap() {
            let mut detector = StagnationDetector::new(&case["options"]);
            let mut outcomes = Vec::new();
            for action in case["actions"].as_array().unwrap() {
                if action == "reset" {
                    detector.reset();
                    outcomes.push(Value::Null);
                } else {
                    outcomes.push(
                        detector
                            .record(action.clone())
                            .map(Value::String)
                            .unwrap_or(Value::Null),
                    );
                }
            }
            assert_eq!(
                outcomes,
                *case["expected"].as_array().unwrap(),
                "{}",
                case["name"]
            );
        }
    }
}

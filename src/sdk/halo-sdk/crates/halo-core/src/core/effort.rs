use crate::js::{is_undefined, number, truthy};
use serde_json::{json, Value};

pub struct Effort {
    pub thinking: Value,
    pub temperature: Option<f64>,
    pub reasoning: Option<&'static str>,
}
pub fn thinking_for_budget(budget: &Value, adaptive: bool) -> Value {
    if budget.is_null() || is_undefined(budget) || number(budget).is_some_and(|value| value <= 0.0)
    {
        json!({"type":"disabled"})
    } else if adaptive {
        json!({"type":"adaptive"})
    } else {
        json!({"type":"enabled","budgetTokens":budget})
    }
}
pub fn resolve(options: &Value) -> Effort {
    let thinking = options
        .get("thinking")
        .filter(|thinking| truthy(thinking))
        .cloned()
        .unwrap_or_else(|| {
            thinking_for_budget(
                &options["maxThinkingTokens"],
                options["adaptiveThinking"] == true,
            )
        });
    let effort = options["effort"]
        .as_str()
        .unwrap_or(if options["nativeResolvedConfig"] == true {
            ""
        } else {
            "high"
        });
    let temperature = (effort == "low").then_some(0.0);
    let reasoning = match effort {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" | "max" => Some("high"),
        _ => None,
    };
    let explicit = if options["nativeResolvedConfig"] == true {
        options["thinkingExplicit"] != false
    } else {
        ["thinking", "maxThinkingTokens"]
            .iter()
            .any(|key| options.get(key).is_some_and(|value| !is_undefined(value)))
    };
    if explicit || thinking["type"] == "enabled" || thinking["type"] == "adaptive" {
        let disabled = thinking["type"] == "disabled";
        return Effort {
            thinking,
            temperature: disabled.then_some(temperature).flatten(),
            reasoning: (!disabled).then_some(reasoning).flatten(),
        };
    }
    let thinking = match effort {
        "low" => json!({"type":"disabled"}),
        "medium" => json!({"type":"enabled","budgetTokens":5000}),
        "max" => json!({"type":"enabled","budgetTokens":20000}),
        "high" => json!({"type":"enabled","budgetTokens":10000}),
        _ => json!({"type":"enabled","budgetTokens":crate::js::undefined()}),
    };
    Effort {
        thinking,
        temperature,
        reasoning,
    }
}

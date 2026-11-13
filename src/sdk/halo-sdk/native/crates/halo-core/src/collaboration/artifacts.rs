use serde_json::{json, Value};

pub fn resolve_published(findings: &[Value], tasks: &[Value], reference: &str) -> Value {
    let mut authors: Vec<String> = Vec::new();
    for finding in findings {
        if finding["ref"] == reference {
            if let Some(author) = finding["authorAppId"].as_str() {
                if !authors.iter().any(|v| v == author) {
                    authors.push(author.into());
                }
            }
        }
    }
    for task in tasks {
        if task["resultRef"] == reference {
            if let Some(author) = task["assigneeAppId"].as_str().filter(|s| !s.is_empty()) {
                if !authors.iter().any(|v| v == author) {
                    authors.push(author.into());
                }
            }
        }
    }
    match authors.len() {
        0 => json!({"kind":"none"}),
        1 => json!({"kind":"unique","authorAppId":authors[0]}),
        _ => json!({"kind":"ambiguous","authorAppIds":authors}),
    }
}

pub fn conflicting_publisher(
    findings: &[Value],
    tasks: &[Value],
    reference: &str,
    claimant: Option<&str>,
) -> Option<String> {
    let claimant = claimant.filter(|v| !v.is_empty())?;
    let resolved = resolve_published(findings, tasks, reference);
    if resolved["kind"] == "unique" {
        return resolved["authorAppId"]
            .as_str()
            .filter(|v| *v != claimant)
            .map(String::from);
    }
    resolved["authorAppIds"]
        .as_array()?
        .iter()
        .filter_map(Value::as_str)
        .find(|v| *v != claimant)
        .map(String::from)
}

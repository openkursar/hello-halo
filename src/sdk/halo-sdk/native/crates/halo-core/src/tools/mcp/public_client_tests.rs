use super::*;
use async_trait::async_trait;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
};

struct Transport {
    responses: Mutex<VecDeque<Value>>,
    requests: Mutex<Vec<JsValue>>,
    references: Mutex<HashMap<String, JsValue>>,
    tools: Mutex<JsValue>,
}
impl Transport {
    fn capture(&self, value: JsValue) -> String {
        let mut references = self.references.lock().unwrap();
        let id = references.len().to_string();
        references.insert(id.clone(), value);
        id
    }
    fn restore(&self, receipt: &JsValue) -> JsValue {
        match field(receipt, "reference")
            .as_text()
            .and_then(JsText::as_utf8)
        {
            Some(id) => self.references.lock().unwrap()[id].clone(),
            None => field(receipt, "value").clone(),
        }
    }
}
#[async_trait]
impl HostBridge for Transport {
    async fn call(&self, _: &str, _: Value, _: &CancellationToken) -> Result<Value> {
        panic!("MCP data must not enter the legacy JSON callback path")
    }
    async fn call_data(
        &self,
        method: &str,
        request: JsValue,
        _: &CancellationToken,
    ) -> Result<JsValue> {
        match method {
            "mcp.client.tools" => {
                *self.tools.lock().unwrap() = self.restore(&request);
                return Ok(JsValue::Undefined);
            }
            "mcp.client.capabilities" => {
                return Ok(field(&self.restore(&request), "tools").truthy().into())
            }
            "mcp.client.warning" => return Ok(JsValue::Undefined),
            _ => assert_eq!(method, "mcp.transport"),
        }
        let mut observed = request.clone();
        observed.as_object_mut().unwrap().shift_remove("response");
        self.requests.lock().unwrap().push(observed);
        if field(&request, "method")
            .as_text()
            .and_then(JsText::as_utf8)
            != Some("send")
        {
            return Ok(JsValue::Undefined);
        }
        let response = self.responses.lock().unwrap().pop_front().unwrap();
        let projection = field(&request, "response")
            .as_text()
            .unwrap()
            .as_utf8()
            .unwrap();
        if crate::js::data::truthy(&response["error"]) {
            if projection == "tools" {
                let reference =
                    self.capture(JsValue::from_json(response["error"]["message"].clone()));
                return Ok(js_value!({ "kind": "error", "reference": reference }));
            }
            let message = response["error"]
                .get("message")
                .map(crate::js::data::to_string)
                .unwrap_or_else(|| "undefined".into());
            return Ok(js_value!({ "kind": "error", "message": message }));
        }
        let result = &response["result"];
        Ok(match projection {
            "initialize" => {
                let capabilities = self.capture(JsValue::from_json(
                    result
                        .get("capabilities")
                        .filter(|value| !value.is_null())
                        .cloned()
                        .unwrap_or_else(|| json!({})),
                ));
                let mut server = js_value!({
                    "name": result["serverInfo"]["name"].as_str().unwrap_or("configured"),
                    "version": result["serverInfo"]["version"].as_str().unwrap_or("unknown")
                });
                if let Some(description) = result["serverInfo"]["description"].as_str() {
                    server
                        .as_object_mut()
                        .unwrap()
                        .insert("description".into(), description.into());
                }
                js_value!({ "kind": "initialize", "server": server,
                    "instructions": result["instructions"].as_str().map(JsValue::from).unwrap_or(JsValue::Undefined),
                    "capabilitiesReference": capabilities })
            }
            "tools" => match result.get("tools").filter(|value| !value.is_null()) {
                Some(tools) => {
                    js_value!({ "kind": "tools", "reference": self.capture(JsValue::from_json(tools.clone())) })
                }
                None => js_value!({ "kind": "tools", "value": [] }),
            },
            "tool" => {
                if result.is_null() {
                    js_value!({ "kind": "empty" })
                } else {
                    js_value!({ "kind": "result", "reference": self.capture(JsValue::from_json(result.clone())) })
                }
            }
            _ => panic!("unknown response projection"),
        })
    }
}

#[tokio::test]
async fn client_protocol_and_feedback_match_fixtures() {
    let fixtures: Value =
        serde_json::from_str(include_str!("../fixtures/public-mcp-client.json")).unwrap();
    for fixture in fixtures.as_array().unwrap() {
        let client = PublicClient::new("configured".into(), fixture["elicitation"] == true);
        let transport = Arc::new(Transport {
            responses: Mutex::new(fixture["responses"].as_array().unwrap().clone().into()),
            requests: Default::default(),
            references: Default::default(),
            tools: Mutex::new(js_value!([])),
        });
        for (index, step) in fixture["steps"].as_array().unwrap().iter().enumerate() {
            let outcome = if step["method"] == "initialize" {
                client
                    .initialize(transport.clone(), &crate::harness::baseline())
                    .await
                    .map(|()| JsValue::Undefined)
            } else {
                client
                    .call_tool(
                        &step["name"].as_str().unwrap().into(),
                        step.get("arguments")
                            .cloned()
                            .map(JsValue::from_json)
                            .unwrap_or(JsValue::Undefined),
                        transport.clone(),
                        &CancellationToken::new(),
                        &crate::harness::baseline(),
                    )
                    .await
                    .map(|receipt| transport.restore(&receipt.receipt()))
            };
            let mut actual = match outcome {
                Ok(value) => js_value!({ "result": value }),
                Err(error) => {
                    js_value!({ "error": error.render_text_for(&crate::harness::baseline()) })
                }
            };
            actual.as_object_mut().unwrap().insert("state".into(), js_value!({
                "initialized": client.initialized(), "tools": transport.tools.lock().unwrap().clone(),
                "server": client.server_info(), "instructions": client.instructions()
            }));
            actual.as_object_mut().unwrap().insert(
                "requests".into(),
                js_value!(transport.requests.lock().unwrap().clone()),
            );
            assert_eq!(
                actual.stringify().unwrap(),
                crate::js::stringify(&fixture["expected"][index]),
                "fixture {} step {index}",
                fixture["name"]
            );
        }
        let version = client.tools_revision();
        client.close();
        assert!(!client.initialized());
        assert!(client.server_info().is_null());
        assert!(client.instructions().is_undefined());
        assert!(client.tools_revision() > version);
    }
}

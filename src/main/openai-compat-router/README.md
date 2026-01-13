# API 格式规范文档

> 本文档详细记录了三种 API 格式的完整规范，用于 openai-compat-router 的协议转换参考。
> 所有内容来源于官方文档，便于后续同步更新。

**最后更新**: 2026-01-11
**官方文档来源**:
- Anthropic Claude: https://docs.anthropic.com/en/api/messages
- OpenAI Chat Completions: https://platform.openai.com/docs/api-reference/chat
- OpenAI Responses: https://platform.openai.com/docs/api-reference/responses

---

## 目录

1. [Claude Messages API](#1-claude-messages-api-anthropic官方格式)
2. [OpenAI Chat Completions API](#2-openai-chat-completions-api-v1chat旧格式)
3. [OpenAI Responses API](#3-openai-responses-api-新格式)
4. [格式转换映射表](#4-格式转换映射表)

---

# 1. Claude Messages API (Anthropic官方格式)

## 1.1 请求格式

### 端点
```
POST https://api.anthropic.com/v1/messages
```

### 必需请求头
```typescript
{
  "x-api-key": string,                // Anthropic API key
  "anthropic-version": "2023-06-01",  // API 版本
  "content-type": "application/json"
}
```

### 可选请求头
```typescript
{
  "anthropic-beta": string[]  // Beta 功能开关，如 "structured-outputs-2025-11-13"
}
```

### 完整请求参数

```typescript
interface ClaudeMessageCreateParams {
  // ========== 必需参数 ==========
  model: string;                      // 模型标识符 (如 "claude-sonnet-4-5-20250929")
  max_tokens: number;                 // 最大生成 token 数 (必需，无默认值)
  messages: ClaudeMessage[];          // 对话消息数组

  // ========== 可选参数 ==========
  system?: string | ClaudeSystemBlock[];  // 系统提示词

  // 采样参数
  temperature?: number;               // 随机性: 0.0-1.0, 默认: 1.0
  top_p?: number;                     // 核采样: 0 < top_p < 1
  top_k?: number;                     // 采样 top K 选项 (高级用途)

  // 停止条件
  stop_sequences?: string[];          // 自定义停止序列

  // 流式传输
  stream?: boolean;                   // 启用 SSE 流式传输 (默认: false)

  // 工具使用
  tools?: ClaudeTool[];               // 工具定义数组
  tool_choice?: ClaudeToolChoice;     // 工具选择策略

  // 元数据
  metadata?: {
    user_id?: string;                 // 用户标识符
    [key: string]: any;
  };

  // Beta 功能
  thinking?: ClaudeThinkingConfig;    // 扩展思维配置
  output_format?: ClaudeOutputFormat; // 结构化 JSON 输出
}
```

## 1.2 消息格式

```typescript
interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

// 字符串内容是单个文本块的简写
// 示例:
{ role: "user", content: "Hello" }
// 等同于:
{ role: "user", content: [{ type: "text", text: "Hello" }] }
```

### 对话规则
- 消息必须在 `user` 和 `assistant` 角色之间交替
- 相同角色的连续消息会被自动合并
- 第一条消息必须来自 `user`
- 系统提示词与消息数组分开

## 1.3 内容块类型

### 文本块
```typescript
interface ClaudeTextBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}
```

### 图片块
```typescript
interface ClaudeImageBlock {
  type: "image";
  source: ClaudeImageSource;
  cache_control?: { type: "ephemeral" };
}

type ClaudeImageSource = ClaudeBase64ImageSource | ClaudeURLImageSource;

interface ClaudeBase64ImageSource {
  type: "base64";
  media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
  data: string;  // Base64 编码的图片数据 (无前缀)
}

interface ClaudeURLImageSource {
  type: "url";
  url: string;
}
```

**图片约束:**
- 每个请求最多 20 张图片
- 每张图片: 最大 3.75 MB, 8000px × 8000px
- 推荐: ≤1.15 百万像素, ≤1568px 每边
- 支持格式: JPEG, PNG, GIF, WebP

### 工具使用块 (assistant 输出)
```typescript
interface ClaudeToolUseBlock {
  type: "tool_use";
  id: string;                         // 此次工具调用的唯一标识符
  name: string;                       // 匹配定义的工具名称
  input: Record<string, any>;         // 工具输入参数
}
```

### 工具结果块 (user 输入)
```typescript
interface ClaudeToolResultBlock {
  type: "tool_result";
  tool_use_id: string;                // 引用 tool_use.id
  content: string | ClaudeContentBlock[];
  is_error?: boolean;                 // 表示工具执行失败
  cache_control?: { type: "ephemeral" };
}
```

### 思维块 (扩展思维)
```typescript
interface ClaudeThinkingBlock {
  type: "thinking";
  thinking: string;                   // 模型的推理过程
  signature?: string;                 // 签名 (用于跨轮次传递)
}
```

## 1.4 工具定义格式

```typescript
interface ClaudeTool {
  name: string;                       // 工具名称 (唯一标识符)
  description?: string;               // 工具功能描述
  input_schema: {
    type: "object";
    properties: Record<string, {
      type: string;                   // JSON Schema 类型
      description?: string;
      enum?: any[];
      items?: any;
      [key: string]: any;
    }>;
    required?: string[];              // 必需属性名称
  };
  strict?: boolean;                   // 启用严格验证 (beta)
  cache_control?: { type: "ephemeral" };
}

// 示例:
{
  name: "get_weather",
  description: "获取指定位置的当前天气",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "城市和州，如 San Francisco, CA"
      },
      unit: {
        type: "string",
        enum: ["celsius", "fahrenheit"],
        description: "温度单位"
      }
    },
    required: ["location"]
  }
}
```

### 工具选择选项
```typescript
type ClaudeToolChoice =
  | { type: "auto" }                              // 让 Claude 决定 (默认)
  | { type: "any" }                               // 必须使用一个工具
  | { type: "tool"; name: string }                // 强制使用特定工具
  | { type: "none" }                              // 不使用工具
  | {
      type: "auto" | "any" | "tool";
      name?: string;
      disable_parallel_tool_use?: boolean;        // 禁用并行工具调用
    };
```

## 1.5 响应格式

```typescript
interface ClaudeMessageResponse {
  id: string;                         // 唯一消息标识符 (如 "msg_01XFDUDYJg...")
  type: "message";                    // 始终为 "message"
  role: "assistant";                  // 始终为 "assistant"
  content: ClaudeContentBlock[];      // 内容块数组
  model: string;                      // 处理请求的模型
  stop_reason: ClaudeStopReason;      // 生成停止的原因
  stop_sequence?: string | null;      // 触发停止的序列 (如适用)
  usage: ClaudeUsage;                 // Token 使用信息
}

type ClaudeStopReason =
  | "end_turn"        // 自然对话结束
  | "max_tokens"      // 达到 max_tokens 限制
  | "stop_sequence"   // 命中自定义停止序列
  | "tool_use"        // 模型想要使用工具
  | "pause_turn"      // 长回合暂停 (可继续)
  | "refusal";        // 检测到策略违规

interface ClaudeUsage {
  input_tokens: number;               // 使用的输入 token
  output_tokens: number;              // 生成的输出 token
  cache_creation_input_tokens?: number;  // 写入缓存的 token
  cache_read_input_tokens?: number;      // 从缓存读取的 token
}
```

### 示例响应
```json
{
  "id": "msg_01XFDUDYJgAACzvnptvVoYEL",
  "type": "message",
  "role": "assistant",
  "content": [
    {
      "type": "text",
      "text": "你好！有什么我可以帮助你的吗？"
    }
  ],
  "model": "claude-sonnet-4-5-20250929",
  "stop_reason": "end_turn",
  "stop_sequence": null,
  "usage": {
    "input_tokens": 12,
    "output_tokens": 8
  }
}
```

## 1.6 流式事件格式

当 `stream: true` 时，API 返回 Server-Sent Events (SSE)。

### 事件流程
1. `message_start` - 初始消息元数据
2. `content_block_start` - 每个内容块的开始
3. `ping` - 保活事件 (可随时出现)
4. `content_block_delta` - 增量内容更新
5. `content_block_stop` - 每个内容块的结束
6. `message_delta` - 最终消息更新
7. `message_stop` - 流终止

### 事件类型

```typescript
// 1. 消息开始事件
interface ClaudeMessageStartEvent {
  type: "message_start";
  message: {
    id: string;
    type: "message";
    role: "assistant";
    content: [];
    model: string;
    stop_reason: null;
    stop_sequence: null;
    usage: {
      input_tokens: number;
      output_tokens: number;
    };
  };
}

// 2. 内容块开始事件
interface ClaudeContentBlockStartEvent {
  type: "content_block_start";
  index: number;                      // 在内容数组中的位置
  content_block: {
    type: "text" | "tool_use" | "thinking";
    text?: string;                    // 对于文本块 (初始为 "")
    id?: string;                      // 对于 tool_use 块
    name?: string;                    // 对于 tool_use 块
    input?: {};                       // 对于 tool_use 块
    thinking?: string;                // 对于 thinking 块
  };
}

// 3. Ping 事件
interface ClaudePingEvent {
  type: "ping";
}

// 4. 内容块增量事件
interface ClaudeContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: ClaudeTextDelta | ClaudeInputJsonDelta | ClaudeThinkingDelta | ClaudeSignatureDelta;
}

interface ClaudeTextDelta {
  type: "text_delta";
  text: string;                       // 增量文本
}

interface ClaudeInputJsonDelta {
  type: "input_json_delta";
  partial_json: string;               // 工具输入的部分 JSON 字符串
}

interface ClaudeThinkingDelta {
  type: "thinking_delta";
  thinking: string;                   // 增量思维内容
}

interface ClaudeSignatureDelta {
  type: "signature_delta";
  signature: string;                  // 思维块签名
}

// 5. 内容块停止事件
interface ClaudeContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

// 6. 消息增量事件
interface ClaudeMessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: ClaudeStopReason;
    stop_sequence?: string | null;
  };
  usage: {
    output_tokens: number;            // 累计计数
  };
}

// 7. 消息停止事件
interface ClaudeMessageStopEvent {
  type: "message_stop";
}

// 8. 错误事件 (可在流中途发生)
interface ClaudeErrorEvent {
  type: "error";
  error: {
    type: string;
    message: string;
  };
}
```

### SSE 格式示例
```
event: message_start
data: {"type":"message_start","message":{...}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: ping
data: {"type":"ping"}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":15}}

event: message_stop
data: {"type":"message_stop"}
```

## 1.7 错误响应格式

```typescript
interface ClaudeErrorResponse {
  type: "error";
  error: {
    type: ClaudeErrorType;
    message: string;
  };
}

type ClaudeErrorType =
  | "invalid_request_error"    // 400: 请求格式错误
  | "authentication_error"     // 401: 无效/缺失 API key
  | "permission_error"         // 403: 权限不足
  | "not_found_error"          // 404: 资源未找到
  | "request_too_large"        // 413: 超出大小限制
  | "rate_limit_error"         // 429: 请求过多
  | "api_error"                // 500: 内部服务器错误
  | "overloaded_error";        // 529: 临时过载
```

### HTTP 状态码

| 状态码 | 错误类型 | 描述 |
|--------|----------|------|
| 400 | `invalid_request_error` | 请求格式或内容错误 |
| 401 | `authentication_error` | API key 无效、过期或缺失 |
| 403 | `permission_error` | API key 缺少所需权限 |
| 404 | `not_found_error` | 资源不存在 |
| 413 | `request_too_large` | 请求超出大小限制 |
| 429 | `rate_limit_error` | 超出速率限制 |
| 500 | `api_error` | 内部服务器错误 |
| 529 | `overloaded_error` | 临时 API 过载 |

---

# 2. OpenAI Chat Completions API (v1/chat 旧格式)

## 2.1 请求格式

### 端点
```
POST https://api.openai.com/v1/chat/completions
```

### 完整请求参数

```typescript
interface OpenAIChatCompletionRequest {
  // ========== 必需参数 ==========
  model: string;                      // 模型 ID (如 "gpt-4o", "gpt-4o-mini")
  messages: OpenAIChatMessage[];      // 对话消息数组

  // ========== 可选参数 ==========
  temperature?: number;               // 0-2, 控制随机性 (默认: 1)
  top_p?: number;                     // 0-1, 核采样 (默认: 1)
  n?: number;                         // 生成的完成数量 (默认: 1)
  stream?: boolean;                   // 启用流式响应 (默认: false)
  stream_options?: {
    include_usage?: boolean;          // 在流式块中包含 usage
  };
  stop?: string | string[];           // 最多 4 个停止序列
  max_tokens?: number;                // 已废弃 - 使用 max_completion_tokens
  max_completion_tokens?: number;     // 完成中的最大 token 数
  presence_penalty?: number;          // -2.0 到 2.0 (默认: 0)
  frequency_penalty?: number;         // -2.0 到 2.0 (默认: 0)
  logit_bias?: Record<string, number>;// 修改 token 概率 (-100 到 100)
  user?: string;                      // 用于滥用监控的唯一用户标识符

  // 工具/函数调用
  tools?: OpenAIChatTool[];           // 可用工具数组
  tool_choice?: "none" | "auto" | "required" | {
    type: "function";
    function: { name: string };
  };
  parallel_tool_calls?: boolean;      // 启用并行函数调用 (默认: true)

  // 结构化输出
  response_format?: {
    type: "text" | "json_object" | "json_schema";
    json_schema?: {
      name: string;
      description?: string;
      schema: object;
      strict?: boolean;
    };
  };

  // 可重现性
  seed?: number;                      // 用于确定性采样 (beta)

  // 日志概率
  logprobs?: boolean;                 // 返回日志概率 (默认: false)
  top_logprobs?: number;              // 0-5, 返回最可能 token 的数量
}
```

## 2.2 消息格式

```typescript
interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;                      // 参与者的可选名称
  tool_calls?: OpenAIToolCall[];      // 用于带工具调用的 assistant 消息
  tool_call_id?: string;              // 用于 tool 角色消息
}

// 多模态内容 (文本 + 图片)
type OpenAIContentPart = OpenAITextContentPart | OpenAIImageContentPart;

interface OpenAITextContentPart {
  type: "text";
  text: string;
}

interface OpenAIImageContentPart {
  type: "image_url";
  image_url: {
    url: string;                      // HTTP(S) URL 或 base64 数据 URL
    detail?: "auto" | "low" | "high"; // 图片处理细节 (默认: "auto")
  };
}
```

### 角色描述:
- **system**: 定义助手行为和上下文的可选角色
- **user**: 来自终端用户的消息
- **assistant**: 助手生成的消息 (或之前的助手响应)
- **tool**: 来自工具/函数调用的结果

### 图片输入格式

```json
{
  "role": "user",
  "content": [
    {
      "type": "text",
      "text": "这张图片里有什么？"
    },
    {
      "type": "image_url",
      "image_url": {
        "url": "https://example.com/image.jpg",
        "detail": "high"
      }
    }
  ]
}
```

**Base64 图片格式:**
```json
{
  "type": "image_url",
  "image_url": {
    "url": "data:image/jpeg;base64,<base64_encoded_image>",
    "detail": "low"
  }
}
```

**Detail 参数:**
- `auto`: 模型根据图片大小决定
- `low`: 512x512 分辨率，更快，85 tokens
- `high`: 详细处理，更多 tokens

## 2.3 工具定义格式

```typescript
interface OpenAIChatTool {
  type: "function";
  function: {
    name: string;                     // 函数名称
    description?: string;             // 函数功能描述
    parameters: {
      type: "object";
      properties: Record<string, OpenAIJSONSchemaProperty>;
      required?: string[];
      additionalProperties?: boolean; // strict 模式下必须为 false
    };
    strict?: boolean;                 // 启用严格 schema 遵守
  };
}

interface OpenAIJSONSchemaProperty {
  type: "string" | "number" | "integer" | "boolean" | "object" | "array" | "null";
  description?: string;
  enum?: any[];
  items?: OpenAIJSONSchemaProperty;   // 用于数组
  properties?: Record<string, OpenAIJSONSchemaProperty>; // 用于对象
  required?: string[];
  additionalProperties?: boolean;
}
```

### 工具选择选项
```typescript
type OpenAIToolChoice =
  | "none"       // 永不调用函数，仅文本
  | "auto"       // 模型决定 (默认)
  | "required"   // 必须调用至少一个函数
  | {            // 强制特定函数
      type: "function";
      function: { name: string };
    };
```

## 2.4 响应格式 (非流式)

```typescript
interface OpenAIChatCompletionResponse {
  id: string;                         // 唯一标识符 (如 "chatcmpl-abc123")
  object: "chat.completion";
  created: number;                    // Unix 时间戳
  model: string;                      // 使用的模型
  system_fingerprint?: string;        // 后端配置指纹
  choices: OpenAIChatCompletionChoice[];
  usage: OpenAICompletionUsage;
}

interface OpenAIChatCompletionChoice {
  index: number;
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: OpenAIToolCall[];
    refusal?: string | null;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: {
    content: OpenAITokenLogprob[] | null;
  };
}

interface OpenAIToolCall {
  id: string;                         // 工具调用 ID (如 "call_abc123")
  type: "function";
  function: {
    name: string;
    arguments: string;                // JSON 字符串
  };
}

interface OpenAICompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}
```

### finish_reason 值:
- **stop**: 模型自然完成
- **length**: 达到 max_tokens 或最大上下文长度
- **tool_calls**: 模型调用了函数/工具
- **content_filter**: 内容被安全系统过滤
- **null**: 生成仍在进行中 (仅流式)

## 2.5 流式格式 (Server-Sent Events)

当 `stream: true` 时，响应以 Server-Sent Events (SSE) 发送。

```typescript
interface OpenAIChatCompletionChunk {
  id: string;                         // 所有块相同的 ID
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: OpenAIChatCompletionChunkChoice[];
  usage?: OpenAICompletionUsage;      // 仅在最终块中 (如果 stream_options.include_usage)
}

interface OpenAIChatCompletionChunkChoice {
  index: number;
  delta: {
    role?: "assistant";
    content?: string;
    tool_calls?: OpenAIToolCallDelta[];
    refusal?: string;
  };
  finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null;
  logprobs?: {
    content: OpenAITokenLogprob[] | null;
  };
}

interface OpenAIToolCallDelta {
  index: number;
  id?: string;                        // 在第一个块中存在
  type?: "function";
  function?: {
    name?: string;                    // 在第一个块中存在
    arguments?: string;               // 部分 JSON 字符串
  };
}
```

### SSE 格式
```
data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"id":"chatcmpl-abc123","object":"chat.completion.chunk","choices":[{"delta":{},"finish_reason":"stop","index":0}]}

data: [DONE]
```

### 流式序列:
1. **第一个块**: 包含 `delta.role = "assistant"`，空内容
2. **内容块**: 包含 `delta.content` 的部分文本
3. **最终块**: 包含空 `delta` 和 `finish_reason`
4. **完成信号**: `data: [DONE]`

## 2.6 错误响应格式

```typescript
interface OpenAIErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string | null;
    code?: string | null;
  };
}
```

### HTTP 状态码:
- **400 Bad Request**: 无效参数或请求格式
- **401 Unauthorized**: 无效或缺失 API key
- **429 Too Many Requests**: 超出速率限制或配额耗尽
- **500 Internal Server Error**: 服务器端错误 (通常是暂时的)
- **503 Service Unavailable**: 服务器暂时不可用

---

# 3. OpenAI Responses API (新格式)

> Responses API 是 OpenAI 的新统一 API (2025年3月发布)，结合了 Chat Completions 和 Assistants API 的最佳功能。
> 它是有状态的，支持内置工具，并为推理模型提供更好的性能。

## 3.1 请求格式

### 端点
```
POST https://api.openai.com/v1/responses
```

### 完整请求参数

```typescript
interface OpenAIResponseCreateParams {
  // ========== 必需参数 ==========
  model: string;                      // 如 "gpt-4o", "gpt-5", "o3", "o4-mini"

  // ========== 输入 (以下模式之一) ==========
  input: string | OpenAIInputMessage[] | {
    role: "user" | "assistant" | "developer",
    content: string | OpenAIContentPart[]
  }[];

  // ========== 可选参数 ==========
  instructions?: string;              // 系统级指导 (替代 system 消息)
  previous_response_id?: string;      // 用于有状态多轮对话

  // 工具配置
  tools?: OpenAIResponseTool[];
  tool_choice?: "auto" | "none" | "required" | {
    type: "allowed_tools",
    mode: "auto" | "required",
    tools: { type: string, name: string }[]
  } | {
    type: "function",
    name: string
  };
  parallel_tool_calls?: boolean;      // 默认: true

  // 生成参数
  temperature?: number;               // 0-2, 默认因模型而异
  top_p?: number;                     // 0-1, 核采样
  max_output_tokens?: number;         // 总输出 token (包括推理)
  stop?: string | string[];           // 停止序列

  // 推理配置 (用于推理模型)
  reasoning?: {
    effort?: "none" | "low" | "medium" | "high" | "xhigh";  // gpt-5.2+
    summary?: "none" | "concise" | "detailed";
    include?: ("encrypted_content")[];  // 用于跨轮次传递推理
  };

  // 输出格式
  text?: {
    format?: {
      type: "text"
    } | {
      type: "json_object"
    } | {
      type: "json_schema",
      json_schema: {
        name: string,
        schema: JSONSchema,
        strict?: boolean
      }
    }
  };

  // 流式传输
  stream?: boolean;
  stream_options?: {
    include_usage?: boolean;
  };

  // 上下文管理
  truncation?: "auto" | "disabled";   // 默认: "disabled"

  // 存储和元数据
  store?: boolean;                    // 默认: true
  metadata?: Record<string, string>;  // 最多 16 个键值对

  // 模态 (用于多模态模型)
  modalities?: ("text" | "audio")[];
  audio?: {
    voice: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer",
    format: "wav" | "mp3" | "flac" | "opus" | "pcm16"
  };

  // 用户标识
  user?: string;                      // 用于滥用监控的终端用户 ID
}
```

## 3.2 输入格式

### 文本输入
```typescript
// 简单字符串
input: "今天天气怎么样？"

// 消息数组
input: [
  {
    role: "developer",                // 系统级指令 (instructions 的替代)
    content: "你是一个有帮助的助手。"
  },
  {
    role: "user",
    content: "你好！"
  }
]
```

### 图片输入 (多模态)
```typescript
input: [
  {
    role: "user",
    content: [
      {
        type: "input_text",
        text: "这张图片里有什么？"
      },
      {
        type: "input_image",
        image_url: "https://example.com/image.jpg",
        detail?: "low" | "high" | "auto"  // 默认: "auto"
      },
      // 或 Base64 编码:
      {
        type: "input_image",
        image_url: "data:image/jpeg;base64,/9j/4AAQ..."
      },
      // 或文件 ID:
      {
        type: "input_image",
        file_id: "file-abc123"
      }
    ]
  }
]
```

### Previous Response ID (有状态)
```typescript
// 继续对话
const response2 = await client.responses.create({
  model: "gpt-4o",
  input: "告诉我更多",
  previous_response_id: response1.id  // API 管理对话状态
});
```

## 3.3 工具定义格式

### 函数工具
```typescript
{
  type: "function",
  function: {
    name: "get_weather",
    description: "获取指定位置的当前天气。",
    parameters: {
      type: "object",
      properties: {
        location: {
          type: "string",
          description: "城市和国家，如波哥大，哥伦比亚"
        },
        units: {
          type: "string",
          enum: ["celsius", "fahrenheit"],
          description: "温度返回的单位"
        }
      },
      required: ["location", "units"],  // strict: true 时必需
      additionalProperties: false
    },
    strict: true                      // 启用结构化输出
  }
}
```

### 代码解释器工具
```typescript
{
  type: "code_interpreter",
  container: {
    type: "auto",
    memory_limit?: "4g" | "8g",
    file_ids?: string[]
  }
}
```

### 文件搜索工具
```typescript
{
  type: "file_search",
  vector_store_ids: ["vs_abc123"]
}
```

### 网络搜索工具
```typescript
{
  type: "web_search"
  // 无需额外配置
}
```

### 计算机使用工具 (预览)
```typescript
{
  type: "computer_use_preview"
  // 启用代理计算机接口控制
}
```

## 3.4 响应格式

```typescript
interface OpenAIResponse {
  id: string;
  object: "response";
  created_at: number;                 // Unix 时间戳
  model: string;

  // 响应状态
  status: "in_progress" | "completed" | "incomplete" | "failed";

  // 输出项 (实际响应内容)
  output: OpenAIOutputItem[];

  // 不完整/错误详情
  incomplete_details?: {
    reason: "max_output_tokens" | "content_filter"
  } | null;
  error?: {
    code: string,
    message: string
  } | null;

  // 回显的请求参数
  instructions?: string;
  metadata?: Record<string, string>;
  parallel_tool_calls?: boolean;
  previous_response_id?: string | null;
  temperature?: number;
  text?: {
    format?: { type: string, [key: string]: any }
  };
  tool_choice?: any;
  tools?: OpenAIResponseTool[];
  top_p?: number;
  max_output_tokens?: number;
  reasoning?: {
    effort?: string,
    summary?: string,
    include?: string[]
  };
  truncation?: string;
  user?: string;

  // Token 使用
  usage: {
    input_tokens: number,
    input_tokens_details?: {
      cached_tokens: number
    },
    output_tokens: number,
    output_tokens_details: {
      reasoning_tokens: number
    },
    total_tokens: number
  };
}
```

## 3.5 输出项类型

### 消息输出
```typescript
{
  id: string,
  type: "message",
  role: "assistant",
  status: "completed" | "incomplete",
  content: [
    {
      type: "output_text",
      text: string
    }
    // 或
    {
      type: "refusal",
      refusal: string                 // 当模型因安全原因拒绝时
    }
  ]
}
```

### 函数调用输出 (来自 assistant)
```typescript
{
  id: string,
  type: "function_call",
  status: "in_progress" | "completed",
  name: string,
  call_id: string,
  arguments: string                   // JSON 字符串
}
```

### 函数调用输出 (来自 user 的响应)
```typescript
{
  type: "function_call_output",
  call_id: string,
  output: string | {
    type: "input_image",
    image_url: string
  }[]                                 // 可以返回图片/文件
}
```

### 推理输出
```typescript
{
  id: string,
  type: "reasoning",
  status: "completed",
  summary?: [
    {
      type: "output_text",
      text: string                    // 人类可读的推理摘要
    }
  ],
  encrypted_content?: string          // 用于传递到下一轮的加密推理
}
```

## 3.6 流式格式

### 流式事件
```typescript
type OpenAIResponseStreamEvent =
  | ResponseCreatedEvent
  | ResponseInProgressEvent
  | ResponseCompletedEvent
  | ResponseIncompleteEvent
  | ResponseFailedEvent
  | ResponseOutputItemAdded
  | ResponseOutputItemDone
  | ResponseContentPartAdded
  | ResponseContentPartDone
  | ResponseOutputTextDelta
  | ResponseTextDone
  | ResponseFunctionCallArgumentsDelta
  | ResponseFunctionCallArgumentsDone
  | Error;
```

### 关键生命周期事件
```typescript
// 响应开始时发出一次
{
  type: "response.created",
  response: Response
}

// 处理中发出一次
{
  type: "response.in_progress",
  response: Response
}

// 文本增量 (多次发出)
{
  type: "response.output_text.delta",
  delta: string,
  item_id: string,
  content_index: number
}

// 完成时发出一次
{
  type: "response.completed",
  response: Response                  // 带 usage 的完整响应对象
}

// 不完整时发出
{
  type: "response.incomplete",
  response: Response,
  incomplete_details: {
    reason: "max_output_tokens" | "content_filter"
  }
}

// 错误时发出
{
  type: "response.failed",
  response: Response,
  error: {
    code: string,
    message: string
  }
}
```

### 函数调用流式事件
```typescript
// 添加函数调用输出项
{
  type: "response.output_item.added",
  item: {
    type: "function_call",
    call_id: string,
    name: string
  },
  output_index: number
}

// 函数参数增量
{
  type: "response.function_call_arguments.delta",
  delta: string,                      // 部分 JSON 参数
  output_index: number
}

// 函数调用完成
{
  type: "response.output_item.done",
  item: {
    type: "function_call",
    call_id: string,
    name: string,
    arguments: string
  },
  output_index: number
}
```

## 3.7 错误响应格式

### HTTP 状态码:
- `200` - 成功
- `400` - Bad Request (请求格式错误)
- `401` - Unauthorized (无效 API key)
- `403` - Forbidden (国家/地区不支持)
- `404` - Not Found
- `429` - Rate Limit / 配额超限
- `500` - Internal Server Error
- `503` - Service Unavailable

### 错误响应体
```typescript
{
  error: {
    message: string,                  // 人类可读的错误消息
    type: string,                     // 错误类型 (如 "invalid_request_error")
    param?: string,                   // 导致错误的参数
    code: string                      // 机器可读的错误代码
  }
}
```

---

# 4. 格式转换映射表

## 4.1 请求参数映射

| Claude | OpenAI Chat Completions | OpenAI Responses |
|--------|-------------------------|------------------|
| `model` | `model` | `model` |
| `max_tokens` | `max_tokens` / `max_completion_tokens` | `max_output_tokens` |
| `temperature` | `temperature` | `temperature` |
| `top_p` | `top_p` | `top_p` |
| `top_k` | - | - |
| `stop_sequences` | `stop` | `stop` |
| `stream` | `stream` | `stream` |
| `system` | `messages[role=system]` | `instructions` |
| `messages` | `messages` | `input` |
| `tools` | `tools` | `tools` |
| `tool_choice` | `tool_choice` | `tool_choice` |
| `metadata` | `user` | `metadata` |
| `thinking` | - | `reasoning` |

## 4.2 消息角色映射

| Claude | OpenAI Chat | OpenAI Responses |
|--------|-------------|------------------|
| `user` | `user` | `user` |
| `assistant` | `assistant` | `assistant` |
| - | `system` | `developer` |
| - | `tool` | (使用 `function_call_output`) |

## 4.3 内容块类型映射

| Claude | OpenAI Chat | OpenAI Responses |
|--------|-------------|------------------|
| `{ type: "text", text }` | `{ type: "text", text }` | `{ type: "input_text" / "output_text", text }` |
| `{ type: "image", source }` | `{ type: "image_url", image_url }` | `{ type: "input_image", image_url }` |
| `{ type: "tool_use", id, name, input }` | `tool_calls[{ id, function: { name, arguments } }]` | `{ type: "function_call", call_id, name, arguments }` |
| `{ type: "tool_result", tool_use_id, content }` | `{ role: "tool", tool_call_id, content }` | `{ type: "function_call_output", call_id, output }` |
| `{ type: "thinking", thinking }` | - | `{ type: "reasoning", summary }` |

## 4.4 工具定义映射

| Claude | OpenAI Chat | OpenAI Responses |
|--------|-------------|------------------|
| `name` | `function.name` | `function.name` 或 `name` |
| `description` | `function.description` | `function.description` 或 `description` |
| `input_schema` | `function.parameters` | `function.parameters` 或 `parameters` |

## 4.5 Tool Choice 映射

| Claude | OpenAI Chat | OpenAI Responses |
|--------|-------------|------------------|
| `{ type: "auto" }` | `"auto"` | `"auto"` |
| `{ type: "any" }` | `"required"` | `"required"` |
| `{ type: "tool", name }` | `{ type: "function", function: { name } }` | `{ type: "function", name }` |
| `{ type: "none" }` | `"none"` | `"none"` |

## 4.6 Stop Reason 映射

| Claude | OpenAI Chat | OpenAI Responses |
|--------|-------------|------------------|
| `end_turn` | `stop` | `completed` / `complete` |
| `max_tokens` | `length` | `max_tokens` |
| `tool_use` | `tool_calls` | `tool_calls` / `tool_use` |
| `stop_sequence` | `content_filter` | - |

## 4.7 流式事件映射

| Claude Event | OpenAI Chat | OpenAI Responses |
|--------------|-------------|------------------|
| `message_start` | 第一个 chunk (含 `delta.role`) | `response.created` |
| `content_block_start` | - | `response.output_item.added` |
| `content_block_delta` (text) | chunk 中的 `delta.content` | `response.output_text.delta` |
| `content_block_delta` (tool) | chunk 中的 `delta.tool_calls` | `response.function_call_arguments.delta` |
| `content_block_stop` | - | `response.output_item.done` |
| `message_delta` | 最终 chunk (含 `finish_reason`) | `response.completed` |
| `message_stop` | `data: [DONE]` | `response.completed` |
| `ping` | - | - |
| `error` | - | `response.failed` |

---

# 附录: 完整类型定义汇总

## Claude Types

```typescript
// === 请求类型 ===
interface ClaudeMessageCreateParams {
  model: string;
  max_tokens: number;
  messages: ClaudeMessage[];
  system?: string | ClaudeSystemBlock[];
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: ClaudeTool[];
  tool_choice?: ClaudeToolChoice;
  metadata?: Record<string, any>;
  thinking?: { type: "enabled"; budget_tokens: number };
}

interface ClaudeMessage {
  role: "user" | "assistant";
  content: string | ClaudeContentBlock[];
}

interface ClaudeSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

type ClaudeContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | { type: "image"; source: { type: "base64" | "url"; media_type?: string; data?: string; url?: string }; cache_control?: { type: "ephemeral" } }
  | { type: "tool_use"; id: string; name: string; input: Record<string, any> }
  | { type: "tool_result"; tool_use_id: string; content: string | ClaudeContentBlock[]; is_error?: boolean; cache_control?: { type: "ephemeral" } }
  | { type: "thinking"; thinking: string; signature?: string };

interface ClaudeTool {
  name: string;
  description?: string;
  input_schema: { type: "object"; properties: Record<string, any>; required?: string[] };
  strict?: boolean;
  cache_control?: { type: "ephemeral" };
}

type ClaudeToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" }
  | { type: "auto" | "any" | "tool"; name?: string; disable_parallel_tool_use?: boolean };

// === 响应类型 ===
interface ClaudeMessageResponse {
  id: string;
  type: "message";
  role: "assistant";
  content: ClaudeContentBlock[];
  model: string;
  stop_reason: "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "pause_turn" | "refusal";
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
}

// === 流式事件类型 ===
interface ClaudeMessageStartEvent {
  type: "message_start";
  message: Omit<ClaudeMessageResponse, "content" | "stop_reason"> & { content: []; stop_reason: null };
}

interface ClaudeContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: { type: "text" | "tool_use" | "thinking"; text?: string; id?: string; name?: string; input?: {}; thinking?: string };
}

interface ClaudeContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: { type: "text_delta"; text: string } | { type: "input_json_delta"; partial_json: string } | { type: "thinking_delta"; thinking: string } | { type: "signature_delta"; signature: string };
}

interface ClaudeContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

interface ClaudeMessageDeltaEvent {
  type: "message_delta";
  delta: { stop_reason: string; stop_sequence?: string | null };
  usage: { output_tokens: number };
}

interface ClaudeMessageStopEvent {
  type: "message_stop";
}

interface ClaudeErrorEvent {
  type: "error";
  error: { type: string; message: string };
}

interface ClaudePingEvent {
  type: "ping";
}

// === 错误类型 ===
interface ClaudeErrorResponse {
  type: "error";
  error: { type: "invalid_request_error" | "authentication_error" | "permission_error" | "not_found_error" | "request_too_large" | "rate_limit_error" | "api_error" | "overloaded_error"; message: string };
}
```

## OpenAI Chat Completions Types

```typescript
// === 请求类型 ===
interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIChatMessage[];
  temperature?: number;
  top_p?: number;
  n?: number;
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  stop?: string | string[];
  max_tokens?: number;
  max_completion_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  logit_bias?: Record<string, number>;
  user?: string;
  tools?: OpenAIChatTool[];
  tool_choice?: "none" | "auto" | "required" | { type: "function"; function: { name: string } };
  parallel_tool_calls?: boolean;
  response_format?: { type: "text" | "json_object" | "json_schema"; json_schema?: { name: string; description?: string; schema: object; strict?: boolean } };
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
}

interface OpenAIChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | OpenAIContentPart[] | null;
  name?: string;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

type OpenAIContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } };

interface OpenAIChatTool {
  type: "function";
  function: { name: string; description?: string; parameters: { type: "object"; properties: Record<string, any>; required?: string[]; additionalProperties?: boolean }; strict?: boolean };
}

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// === 响应类型 ===
interface OpenAIChatCompletionResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: { index: number; message: { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[]; refusal?: string | null }; finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null; logprobs?: any }[];
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// === 流式类型 ===
interface OpenAIChatCompletionChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  system_fingerprint?: string;
  choices: { index: number; delta: { role?: "assistant"; content?: string; tool_calls?: { index: number; id?: string; type?: "function"; function?: { name?: string; arguments?: string } }[]; refusal?: string }; finish_reason: "stop" | "length" | "tool_calls" | "content_filter" | null; logprobs?: any }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

// === 错误类型 ===
interface OpenAIErrorResponse {
  error: { message: string; type: string; param?: string | null; code?: string | null };
}
```

## OpenAI Responses Types

```typescript
// === 请求类型 ===
interface OpenAIResponseCreateParams {
  model: string;
  input: string | OpenAIInputItem[];
  instructions?: string;
  previous_response_id?: string;
  tools?: OpenAIResponseTool[];
  tool_choice?: "auto" | "none" | "required" | { type: "function"; name: string };
  parallel_tool_calls?: boolean;
  temperature?: number;
  top_p?: number;
  max_output_tokens?: number;
  stop?: string | string[];
  reasoning?: { effort?: "none" | "low" | "medium" | "high" | "xhigh"; summary?: "none" | "concise" | "detailed"; include?: string[] };
  text?: { format?: { type: "text" } | { type: "json_object" } | { type: "json_schema"; json_schema: { name: string; schema: object; strict?: boolean } } };
  stream?: boolean;
  stream_options?: { include_usage?: boolean };
  truncation?: "auto" | "disabled";
  store?: boolean;
  metadata?: Record<string, string>;
  modalities?: ("text" | "audio")[];
  audio?: { voice: string; format: string };
  user?: string;
}

type OpenAIInputItem =
  | { role: "user" | "assistant" | "developer"; content: string | OpenAIInputContentPart[] }
  | { type: "function_call"; call_id: string; name: string; arguments: string }
  | { type: "function_call_output"; call_id: string; output: string };

type OpenAIInputContentPart = { type: "input_text"; text: string } | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" };

type OpenAIResponseTool =
  | { type: "function"; function?: { name: string; description?: string; parameters: object; strict?: boolean }; name?: string; description?: string; parameters?: object }
  | { type: "code_interpreter"; container?: { type: "auto"; memory_limit?: string; file_ids?: string[] } }
  | { type: "file_search"; vector_store_ids?: string[] }
  | { type: "web_search" }
  | { type: "computer_use_preview" };

// === 响应类型 ===
interface OpenAIResponse {
  id: string;
  object: "response";
  created_at: number;
  model: string;
  status: "in_progress" | "completed" | "incomplete" | "failed";
  output: OpenAIOutputItem[];
  incomplete_details?: { reason: "max_output_tokens" | "content_filter" } | null;
  error?: { code: string; message: string } | null;
  instructions?: string;
  metadata?: Record<string, string>;
  usage: { input_tokens: number; input_tokens_details?: { cached_tokens: number }; output_tokens: number; output_tokens_details: { reasoning_tokens: number }; total_tokens: number };
}

type OpenAIOutputItem =
  | { id: string; type: "message"; role: "assistant"; status: "completed" | "incomplete"; content: ({ type: "output_text"; text: string } | { type: "refusal"; refusal: string })[] }
  | { id: string; type: "function_call"; status: "in_progress" | "completed"; name: string; call_id: string; arguments: string }
  | { id: string; type: "reasoning"; status: "completed"; summary?: { type: "output_text"; text: string }[]; encrypted_content?: string };

// === 流式事件类型 ===
type OpenAIResponseStreamEvent =
  | { type: "response.created"; response: OpenAIResponse }
  | { type: "response.in_progress"; response: OpenAIResponse }
  | { type: "response.completed"; response: OpenAIResponse }
  | { type: "response.incomplete"; response: OpenAIResponse; incomplete_details: { reason: string } }
  | { type: "response.failed"; response: OpenAIResponse; error: { code: string; message: string } }
  | { type: "response.output_item.added"; item: OpenAIOutputItem; output_index: number }
  | { type: "response.output_item.done"; item: OpenAIOutputItem; output_index: number }
  | { type: "response.output_text.delta"; delta: string; item_id: string; content_index: number }
  | { type: "response.output_text.done"; text: string; item_id: string; content_index: number }
  | { type: "response.function_call_arguments.delta"; delta: string; output_index: number }
  | { type: "response.function_call_arguments.done"; arguments: string; output_index: number };

// === 错误类型 ===
interface OpenAIResponseErrorResponse {
  error: { message: string; type: string; param?: string; code: string };
}
```

---

# 参考资料

## Claude API
- [Messages API Reference](https://docs.anthropic.com/en/api/messages)
- [Messages Streaming](https://docs.anthropic.com/en/api/messages-streaming)
- [Vision](https://docs.anthropic.com/en/docs/build-with-claude/vision)
- [Tool Use](https://docs.anthropic.com/en/docs/build-with-claude/tool-use)
- [Errors](https://docs.anthropic.com/en/api/errors)
- [anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)

## OpenAI Chat Completions API
- [Chat Completions API Reference](https://platform.openai.com/docs/api-reference/chat)
- [Vision](https://platform.openai.com/docs/guides/vision)
- [Function Calling](https://platform.openai.com/docs/guides/function-calling)
- [Streaming](https://platform.openai.com/docs/api-reference/streaming)
- [Error Codes](https://platform.openai.com/docs/guides/error-codes)

## OpenAI Responses API
- [Responses API Reference](https://platform.openai.com/docs/api-reference/responses)
- [Migrate to Responses API](https://platform.openai.com/docs/guides/migrate-to-responses)
- [Streaming Responses](https://platform.openai.com/docs/guides/streaming-responses)
- [Using Tools](https://platform.openai.com/docs/guides/tools)
- [openai-node](https://github.com/openai/openai-node)

---

# 5. 当前实现审查报告

> 以下是对 `openai-compat-router` 当前实现与官方文档格式的对比审查。
> 审查日期: 2026-01-11

## 5.1 整体评估

| 模块 | 符合度 | 评价 |
|------|--------|------|
| Claude → OpenAI Chat | ✅ 良好 | 核心转换逻辑正确 |
| Claude → OpenAI Responses | ✅ 良好 | 格式转换符合规范 |
| OpenAI Chat → Claude | ✅ 良好 | 响应转换正确 |
| OpenAI Responses → Claude | ✅ 良好 | 响应转换正确 |
| 流式转换 | ✅ 良好 | 事件映射正确 |

## 5.2 types.ts 审查

### Claude (Anthropic) 类型

| 字段 | 官方规范 | 当前实现 | 状态 |
|------|----------|----------|------|
| `AnthropicRole` | `"user" \| "assistant"` | ✅ 正确 | ✅ |
| `AnthropicContentBlock.text` | `{ type: "text", text, cache_control? }` | ✅ 正确 | ✅ |
| `AnthropicContentBlock.image` | `{ type: "image", source: { type, media_type, data/url } }` | ✅ 正确 | ✅ |
| `AnthropicContentBlock.tool_use` | `{ type: "tool_use", id, name, input }` | ✅ 正确 | ✅ |
| `AnthropicContentBlock.tool_result` | `{ type: "tool_result", tool_use_id, content, is_error? }` | ✅ 正确 | ✅ |
| `AnthropicContentBlock.thinking` | `{ type: "thinking", thinking, signature? }` | ✅ 正确 | ✅ |
| `AnthropicTool.input_schema` | `{ type: "object", properties, required? }` | ⚠️ 类型过宽 `Record<string, unknown>` | 可优化 |
| `AnthropicRequest.top_p` | 官方支持 | ❌ 缺失 | 可添加 |
| `AnthropicRequest.top_k` | 官方支持 | ❌ 缺失 | 可添加 |
| `AnthropicRequest.stop_sequences` | 官方支持 | ❌ 缺失 | 可添加 |
| `AnthropicRequest.metadata` | 官方支持 | ❌ 缺失 | 可添加 |

### OpenAI Chat Completions 类型

| 字段 | 官方规范 | 当前实现 | 状态 |
|------|----------|----------|------|
| `OpenAIMessage.role` | `"system" \| "user" \| "assistant" \| "tool"` | ✅ 正确 | ✅ |
| `OpenAIMessage.content` | `string \| ContentPart[] \| null` | ✅ 正确 (使用 `any`) | ✅ |
| `OpenAIMessage.tool_calls` | `ToolCall[]` | ✅ 正确 (使用 `any[]`) | ✅ |
| `OpenAIMessage.tool_call_id` | `string` | ✅ 正确 | ✅ |
| `OpenAIRequest.top_p` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.n` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.stop` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.presence_penalty` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.frequency_penalty` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.logit_bias` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.user` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.response_format` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIRequest.seed` | 官方支持 | ❌ 缺失 | 可添加 |

### OpenAI Responses 类型

| 字段 | 官方规范 | 当前实现 | 状态 |
|------|----------|----------|------|
| `OpenAIResponsesRequest.model` | ✅ | ✅ | ✅ |
| `OpenAIResponsesRequest.input` | `string \| InputItem[]` | ✅ 正确 | ✅ |
| `OpenAIResponsesRequest.max_output_tokens` | ✅ | ✅ | ✅ |
| `OpenAIResponsesRequest.temperature` | ✅ | ✅ | ✅ |
| `OpenAIResponsesRequest.stream` | ✅ | ✅ | ✅ |
| `OpenAIResponsesRequest.tools` | ✅ | ✅ | ✅ |
| `OpenAIResponsesRequest.reasoning` | `{ effort, summary?, include? }` | ⚠️ 仅支持 `effort` 和 `enabled` | 可优化 |
| `OpenAIResponsesRequest.instructions` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.previous_response_id` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.top_p` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.stop` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.text.format` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.truncation` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.store` | 官方支持 | ❌ 缺失 | 可添加 |
| `OpenAIResponsesRequest.metadata` | 官方支持 | ❌ 缺失 | 可添加 |

## 5.3 converter.ts 审查

### Claude → OpenAI Chat Completions 转换

| 转换项 | 官方映射 | 当前实现 | 状态 |
|--------|----------|----------|------|
| `system` → `messages[role=system]` | ✅ | ✅ 正确 | ✅ |
| `messages` → `messages` | ✅ | ✅ 正确 | ✅ |
| `max_tokens` → `max_tokens` | ✅ | ✅ 正确 | ✅ |
| `temperature` → `temperature` | ✅ | ✅ 正确 | ✅ |
| `stream` → `stream` | ✅ | ✅ 正确 | ✅ |
| 图片 `base64` → `data:` URL | ✅ | ✅ 正确 | ✅ |
| 图片 `url` → `image_url.url` | ✅ | ✅ 正确 | ✅ |
| `tool_result` → `role: "tool"` | ✅ | ✅ 正确 | ✅ |
| `tool_use` → `tool_calls` | ✅ | ✅ 正确 | ✅ |
| `thinking` → `reasoning` | 近似映射 | ✅ 实现了 | ✅ |
| `tools` → `tools` | ✅ | ⚠️ 被禁用了 | 注意 |
| `tool_choice` → `tool_choice` | ✅ | ⚠️ 仅在 tools 启用时生效 | 注意 |

**注意**: `convertAnthropicToOpenAI` 中的 tools 被故意禁用 (第 200-205 行注释说明)，这是为了兼容某些拒绝格式错误工具的上游提供商。如果需要启用，需要添加验证逻辑。

### Claude → OpenAI Responses 转换

| 转换项 | 官方映射 | 当前实现 | 状态 |
|--------|----------|----------|------|
| `system` → `input[role=system]` | ✅ | ⚠️ 应使用 `role: "developer"` | 可优化 |
| `messages` → `input` | ✅ | ✅ 正确 | ✅ |
| `max_tokens` → `max_output_tokens` | ✅ | ✅ 正确 | ✅ |
| `temperature` → `temperature` | ✅ | ✅ 正确 | ✅ |
| `stream` → `stream` | ✅ | ✅ 正确 | ✅ |
| 文本块 → `input_text` / `output_text` | ✅ | ✅ 正确 | ✅ |
| 图片块 → `input_image` | ✅ | ✅ 正确 | ✅ |
| `tool_use` → `function_call` | ✅ | ✅ 正确 | ✅ |
| `tool_result` → `function_call_output` | ✅ | ✅ 正确 | ✅ |
| `tools` → `tools` | ✅ | ✅ 正确 (使用顶级格式) | ✅ |
| `tool_choice.auto` → `"auto"` | ✅ | ✅ 正确 | ✅ |
| `tool_choice.any` → `"required"` | ✅ | ✅ 正确 | ✅ |
| `tool_choice.tool` → `{ type: "function", name }` | ✅ | ⚠️ 格式为 `{ type: "function", function: { name } }` | 可能需要调整 |
| `thinking` → `reasoning` | 近似映射 | ✅ 实现了 | ✅ |

### OpenAI Chat Completions → Claude 转换

| 转换项 | 官方映射 | 当前实现 | 状态 |
|--------|----------|----------|------|
| `choices[0].message.content` → `content[type=text]` | ✅ | ✅ 正确 | ✅ |
| `choices[0].message.tool_calls` → `content[type=tool_use]` | ✅ | ✅ 正确 | ✅ |
| `finish_reason: "stop"` → `stop_reason: "end_turn"` | ✅ | ✅ 正确 | ✅ |
| `finish_reason: "length"` → `stop_reason: "max_tokens"` | ✅ | ✅ 正确 | ✅ |
| `finish_reason: "tool_calls"` → `stop_reason: "tool_use"` | ✅ | ✅ 正确 | ✅ |
| `finish_reason: "content_filter"` → `stop_reason: "stop_sequence"` | ⚠️ 不完全对应 | ⚠️ 可接受 | 可优化 |
| `usage.prompt_tokens` → `usage.input_tokens` | ✅ | ✅ 正确 | ✅ |
| `usage.completion_tokens` → `usage.output_tokens` | ✅ | ✅ 正确 | ✅ |
| `message.reasoning` → `content[type=thinking]` | 近似映射 | ✅ 实现了 | ✅ |
| `message.annotations` → `web_search_tool_result` | 扩展功能 | ✅ 实现了 | ✅ |

### OpenAI Responses → Claude 转换

| 转换项 | 官方映射 | 当前实现 | 状态 |
|--------|----------|----------|------|
| `output[type=message]` → `content[type=text]` | ✅ | ✅ 正确 | ✅ |
| `output[type=function_call]` → `content[type=tool_use]` | ✅ | ✅ 正确 | ✅ |
| `status: "completed"` → `stop_reason: "end_turn"` | ✅ | ✅ 正确 | ✅ |
| `usage.input_tokens` → `usage.input_tokens` | ✅ | ✅ 正确 | ✅ |
| `usage.output_tokens` → `usage.output_tokens` | ✅ | ✅ 正确 | ✅ |
| `output[type=reasoning]` → `content[type=thinking]` | 近似映射 | ⚠️ 使用 `resp.reasoning` | 可优化 |

## 5.4 stream.ts 审查

### OpenAI Chat Completions 流式 → Claude 流式

| 事件转换 | 官方映射 | 当前实现 | 状态 |
|----------|----------|----------|------|
| 首个 chunk → `message_start` | ✅ | ✅ 正确 | ✅ |
| `delta.content` → `content_block_delta[text_delta]` | ✅ | ✅ 正确 | ✅ |
| `delta.tool_calls` → `content_block_delta[input_json_delta]` | ✅ | ✅ 正确 | ✅ |
| `delta.reasoning` → `content_block_delta[thinking_delta]` | 扩展功能 | ✅ 实现了 | ✅ |
| `finish_reason` → `message_delta` | ✅ | ✅ 正确 | ✅ |
| `[DONE]` → `message_stop` | ✅ | ✅ 正确 | ✅ |

### OpenAI Responses 流式 → Claude 流式

| 事件转换 | 官方映射 | 当前实现 | 状态 |
|----------|----------|----------|------|
| `response.created` → `message_start` | ✅ | ✅ 正确 | ✅ |
| `response.output_text.delta` → `content_block_delta[text_delta]` | ✅ | ✅ 正确 | ✅ |
| `response.output_item.added[function_call]` → `content_block_start[tool_use]` | ✅ | ✅ 正确 | ✅ |
| `response.function_call_arguments.delta` → `content_block_delta[input_json_delta]` | ✅ | ✅ 正确 | ✅ |
| `response.output_item.done` → `content_block_stop` | ✅ | ✅ 正确 | ✅ |
| `response.completed` → `message_delta` + `message_stop` | ✅ | ✅ 正确 | ✅ |

## 5.5 改进建议

### 高优先级 (影响功能)

1. **无** - 当前实现的核心功能都符合规范

### 中优先级 (完善类型)

1. **`AnthropicRequest` 缺少字段**: 添加 `top_p`, `top_k`, `stop_sequences`, `metadata`
2. **`OpenAIRequest` 缺少字段**: 添加 `top_p`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, `response_format`, `seed`
3. **`OpenAIResponsesRequest` 缺少字段**: 添加 `instructions`, `previous_response_id`, `top_p`, `stop`, `text`, `truncation`, `store`, `metadata`
4. **Responses API system role**: 官方使用 `"developer"` 而非 `"system"`，当前使用 `"system"` 可能在某些情况下不兼容

### 低优先级 (优化)

1. **tool_choice 映射**: Responses API 的强制工具格式应为 `{ type: "function", name }` 而非 `{ type: "function", function: { name } }`
2. **content_filter 映射**: `content_filter` 映射到 `stop_sequence` 不够准确，Claude 没有完全对应的类型
3. **Responses API reasoning 字段**: 当前实现仅支持 `effort` 和 `enabled`，官方还支持 `summary` 和 `include`

## 5.6 结论

当前实现的核心转换逻辑**符合官方规范**，能够正确处理:
- ✅ 文本消息转换
- ✅ 图片 (base64/URL) 转换
- ✅ 工具调用 (tool_use/function_call) 转换
- ✅ 工具结果 (tool_result/function_call_output) 转换
- ✅ 流式事件转换
- ✅ 停止原因映射
- ✅ Token 使用统计

缺失的字段主要是一些**可选参数**，不影响基本功能。如有需要可以按照文档补充。

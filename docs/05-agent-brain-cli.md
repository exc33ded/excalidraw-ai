# 05 - Agent brain (external CLI)

Where: src/server/canvas-agent/cli-adapter.mjs, src/providers/{kimi,codex,claude}-cli.js

The agent does not call a chat API directly. It shells out to an external CLI
agent and treats it as the model backend.

## Supported brains

    CLI_PROVIDERS = kimi-cli | codex-cli | claude-cli
    (Kimi CLI, OpenAI Codex CLI, Anthropic Claude Code)

Each provider (src/providers/*.js) spawns the CLI with child_process.spawn,
finds the binary on PATH, sanitizes the environment to an allowlist, and
optionally isolates HOME/XDG dirs. Arguments set effort levels and disable
features the Harness already owns (apps, auth, browser, code_mode, etc.).

## The CLI protocol (CLI_PROTOCOL_SYSTEM)

The CLI is told it is only the model backend; Harness owns the loop:

    "You are PenEcho Canvas's model backend. Harness owns the conversation and
     tools. Never invoke CLI built-ins (ReadMediaFile, Read, Bash, MCP, Agent,
     etc.); use supplied images directly.
     Return exactly one standard JSON object, without prose or fences:
       - To answer the user: {"type":"final","text":"..."}
       - One Harness tool: {"type":"tool_call","name":"canvas_inspect",
         "arguments":{}}
     Choose at most one tool. Its name must be listed in HARNESS
     REQUEST.availableTools and arguments must match its schema."

So each turn the CLI returns exactly ONE decision: either final text or one tool
call. The Harness executes the tool and feeds the result back for the next
decision. This is the standard agent loop, but with the CLI as the decision
maker and the Harness as the executor.

## Limits (cli-adapter.mjs)

    CLI_CONTEXT_WINDOW = 160,000 chars
    CLI_MAX_TOKENS     = 8,192
    CLI_MAX_IMAGES     = 5
    image max          = 2048 x 2048 px, 5 MB
    retry policy       = maxRetries 0
    prompt cap         = 500,000 chars

## How this maps to Excalidraw

We do NOT need to shell out to Claude Code / Codex. We have a DeepSeek key, so
the equivalent is a native tool-calling loop: call deepseek-v4-pro (or
deepseek-chat) with our Excalidraw tools in the tools array, and let the model
return either a final message or one tool call per turn. The shape of the loop
(final vs tool_call) is identical; only the backend differs (API instead of
CLI). This keeps the key server-side and avoids a local CLI dependency.

# 03 - Agent protocol (WebSocket bridge)

Where: src/server/canvas-agent/http.js, src/server/canvas-agent/protocol.mjs

## Transport

- Endpoint: /api/canvas-agent/socket (WebSocketServer, noServer + upgrade).
- Envelope (version 1), sent as JSON frames:

    {
      version: 1,
      type: "...",            // handshake, turn, frame, ready, error, ...
      canvasSessionId: "...",
      clientId: "...",
      seq: 42,                // must strictly increase per direction
      payload: { ... }
    }

- The server rejects frames whose seq does not increase (anti-replay).
- Handshake uses a handshakeId echoed on ready/error.

## Limits

    MAX_AGENT_FRAME_BYTES = 48 MB
    MAX_REMOTE_AGENT_CHANNELS = 8
    REMOTE_AGENT_CHANNEL_TTL_MS = 5 min
    REMOTE_AGENT_POLL_MS = 15 s

## Remote (cloud) operations

cloud-connector.js exposes canvas.agent.* operations used by the remote channel
(http.js lines 282-312):

    canvas.agent.open    open a remote session
    canvas.agent.frame   push a frame (bounded by MAX_AGENT_FRAME_BYTES)
    canvas.agent.pull    poll for the agent output
    canvas.agent.close   close the channel

## Host routing

http.js builds two hosts and routes between them (host-router.mjs):

    harnessFactory -> CanvasHarnessHost (runtime.mjs)   // Harness-based agent
    nativeFactory  -> CodexNativeHost (codex-native-host.mjs)  // native Codex

The router picks the host per connection (local CLI vs native), so the same
socket protocol serves both brains.

## How it maps to Excalidraw

We do not need a WebSocket for v1. The Excalidraw chat can POST a JSON turn to
our bridge server and stream the response (SSE or plain fetch), because the
canvas state is small (elements + selection) and can be included in each
request. WebSocket matters only if we later need push (multi-client / remote).

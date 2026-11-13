const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// CORS Middleware
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.header('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});

// Registry of Models (Custom Models supported)
const customModels = [
  {
    id: "deepseek-chat",
    name: "DeepSeek-V3",
    vendor: "DeepSeek",
    contextWindow: 64000,
    maxTokens: 8192,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY || ""
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek-R1 (Reasoner)",
    vendor: "DeepSeek",
    contextWindow: 64000,
    maxTokens: 8192,
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY || ""
  }
];

// Serve static assets
const webDir = path.join(__dirname, 'public');

// Plugin Combo Endpoints
app.use('/plugins', (req, res, next) => {
  const url = req.url;
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  if (url.includes('dsh-client-modules') || url.includes('bundle_loader')) {
    return res.sendFile(path.join(webDir, 'plugins', 'bundle_loader.js'));
  } else if (url.includes('dsh-client-ui-settings-subagent') || url.includes('bundle_phase2')) {
    return res.sendFile(path.join(webDir, 'plugins', 'bundle_phase2.js'));
  } else {
    return res.sendFile(path.join(webDir, 'plugins', 'bundle_phase1.js'));
  }
});

// Custom Models Management API
app.get('/api/custom-models', (req, res) => {
  res.json({ ok: true, models: customModels });
});

app.post('/api/custom-models', (req, res) => {
  const { id, name, vendor, baseUrl, apiKey, contextWindow, maxTokens } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: "id and name are required" });
  }
  const existing = customModels.find(m => m.id === id);
  if (existing) {
    existing.name = name;
    existing.vendor = vendor || existing.vendor;
    existing.baseUrl = baseUrl || existing.baseUrl;
    if (apiKey !== undefined) existing.apiKey = apiKey;
    if (contextWindow) existing.contextWindow = Number(contextWindow);
    if (maxTokens) existing.maxTokens = Number(maxTokens);
  } else {
    customModels.push({
      id,
      name,
      vendor: vendor || "Custom Provider",
      contextWindow: contextWindow ? Number(contextWindow) : 64000,
      maxTokens: maxTokens ? Number(maxTokens) : 8192,
      baseUrl: baseUrl || "https://api.openai.com/v1",
      apiKey: apiKey || ""
    });
  }
  console.log(`[Custom Models] Saved model: ${name} (${id})`);
  res.json({ ok: true, message: `Model ${name} (${id}) saved successfully!`, models: customModels });
});

// RPC API Handler (for DeepSeek Harness web frontend)
app.post(['/api', '/api/*'], async (req, res) => {
  const { rpcId = "rpc-default", method = "" } = req.body || {};
  const pathPart = req.params[0] || "";
  const endpoint = method || pathPart;
  let value = {};

  if (endpoint.includes("session/list") || endpoint.includes("session.list")) {
    value = { items: [] };
  } else if (endpoint.includes("llm/listProviders") || endpoint.includes("listProviders")) {
    value = [
      { id: "deepseek", name: "DeepSeek" },
      { id: "custom", name: "Custom Models" }
    ];
  } else if (endpoint.includes("llm/listConfigurableProviders")) {
    value = [];
  } else if (endpoint.includes("models") || endpoint.includes("model")) {
    value = customModels;
  } else if (endpoint.includes("workspace")) {
    value = {
      id: "render-ws",
      name: "Render Cloud Workspace",
      path: "/app/workspace",
      state: "ready"
    };
  } else if (endpoint.includes("account")) {
    value = {
      id: "admin-user",
      name: "Cloud Administrator",
      type: "admin"
    };
  } else if (endpoint.includes("chat") || endpoint.includes("completion")) {
    // LLM Chat proxy handler
    try {
      const modelId = req.body?.payload?.model || customModels[0]?.id || "deepseek-chat";
      const modelConfig = customModels.find(m => m.id === modelId) || customModels[0];
      const targetUrl = (modelConfig.baseUrl || "https://api.deepseek.com").replace(/\/$/, '') + "/chat/completions";
      const key = modelConfig.apiKey || process.env.DEEPSEEK_API_KEY;

      if (!key) {
        value = {
          id: "chatcmpl-" + crypto.randomUUID(),
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: modelId,
          choices: [{
            index: 0,
            message: {
              role: "assistant",
              content: "Welcome to DeepSeek Harness Web! Your custom model runtime is connected and ready. You can add your API Key in Settings -> Models or in Render Environment Variables whenever you are ready."
            },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 10, completion_tokens: 35, total_tokens: 45 }
        };
      } else {
        const response = await fetch(targetUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${key}`
          },
          body: JSON.stringify(req.body.payload)
        });
        value = await response.json();
      }
    } catch (e) {
      value = { error: e.message };
    }
  }

  res.json({
    type: "server-response",
    rpcId: rpcId,
    result: { ok: true, value: value }
  });
});

app.use(express.static(webDir));

// Fallback to index.html for SPA routes
app.get('*', (req, res) => {
  res.sendFile(path.join(webDir, 'index.html'));
});

// WebSocket Server on /api/remote.mux
const wss = new WebSocket.Server({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/api/remote.mux' || url.pathname.startsWith('/api')) {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  } catch (e) {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  console.log(`[WebSocket] Client connected: ${req.url}`);

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log(`[WebSocket] Frame: type=${data.type}, endpoint=${data.endpoint || ''}, streamId=${data.streamId || ''}`);

      if (data.type === 'open') {
        const streamId = data.streamId || "stream-1";
        if (data.endpoint === '$events' || !data.endpoint) {
          // STRICT frame format matching parseRemoteEventReady in bundle_phase1.js:
          // { type: "item", streamId, value: { type: "ready", clientId: "...", host: { home: "/app" } } }
          // host MUST contain ONLY "home" and nothing else!
          const readyFrame = {
            type: "item",
            streamId: streamId,
            value: {
              type: "ready",
              clientId: "render-client-" + crypto.randomUUID().slice(0, 8),
              host: {
                home: "/app"
              }
            }
          };
          ws.send(JSON.stringify(readyFrame));
          console.log('[WebSocket] Sent Remote ready confirmation frame to client');
        } else {
          // Complete any other streams cleanly so client does not hang
          ws.send(JSON.stringify({
            type: "end",
            streamId: streamId
          }));
        }
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: "pong", streamId: data.streamId }));
      }
    } catch (e) {
      console.error("[WebSocket] Frame Error:", e.message);
    }
  });

  // Keep-alive ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on('close', () => {
    console.log('[WebSocket] Client disconnected');
    clearInterval(pingInterval);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DeepSeek Harness Web] Running on http://0.0.0.0:${PORT}`);
  console.log(`Custom Models loaded: ${customModels.map(m => m.name).join(', ')}`);
});

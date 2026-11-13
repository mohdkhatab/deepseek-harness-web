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
    baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    apiKey: process.env.DEEPSEEK_API_KEY || ""
  },
  {
    id: "deepseek-reasoner",
    name: "DeepSeek-R1 (Reasoner)",
    vendor: "DeepSeek",
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
  const { id, name, vendor, baseUrl, apiKey } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: "id and name are required" });
  }
  const existing = customModels.find(m => m.id === id);
  if (existing) {
    existing.name = name;
    existing.vendor = vendor || existing.vendor;
    existing.baseUrl = baseUrl || existing.baseUrl;
    if (apiKey) existing.apiKey = apiKey;
  } else {
    customModels.push({
      id,
      name,
      vendor: vendor || "Custom Provider",
      baseUrl: baseUrl || "https://api.deepseek.com",
      apiKey: apiKey || ""
    });
  }
  res.json({ ok: true, message: `Model ${name} (${id}) saved successfully!`, models: customModels });
});

// RPC API Handler (for DeepSeek Harness web frontend)
app.post(['/api', '/api/*'], async (req, res) => {
  const { rpcId = "rpc-default", method = "" } = req.body || {};
  let value = {};

  if (method.includes("models") || method.includes("model")) {
    value = customModels;
  } else if (method.includes("workspace")) {
    value = {
      id: "render-ws",
      name: "Render Cloud Workspace",
      path: "/app/workspace",
      state: "ready"
    };
  } else if (method.includes("account")) {
    value = {
      id: "admin-user",
      name: "Cloud Administrator",
      type: "admin"
    };
  } else if (method.includes("session")) {
    value = [];
  } else if (method.includes("chat") || method.includes("completion")) {
    // LLM Chat proxy handler
    try {
      const modelId = req.body?.payload?.model || "deepseek-chat";
      const modelConfig = customModels.find(m => m.id === modelId) || customModels[0];
      const targetUrl = (modelConfig.baseUrl || "https://api.deepseek.com").replace(/\/$/, '') + "/chat/completions";
      const key = modelConfig.apiKey || process.env.DEEPSEEK_API_KEY;

      if (!key) {
        value = { error: "API key is not configured. Please set DEEPSEEK_API_KEY in Render environment settings." };
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
    const url = new URL(request.url, `http://${request.headers.host}`);
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

wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message.toString());
      if (data.type === 'open') {
        // Send remote ready handshake frame so connection indicator changes to connected
        const readyFrame = {
          type: "item",
          streamId: data.streamId || "stream-1",
          value: {
            type: "ready",
            clientId: "render-client-" + crypto.randomUUID().slice(0, 8),
            host: {
              home: "/app",
              runtime: "render-cloud"
            }
          }
        };
        ws.send(JSON.stringify(readyFrame));
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: "pong", streamId: data.streamId }));
      }
    } catch (e) {
      console.error("WS Message Error:", e.message);
    }
  });

  // Keep-alive ping
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.ping();
    }
  }, 25000);

  ws.on('close', () => clearInterval(pingInterval));
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DeepSeek Harness Web] Running on http://0.0.0.0:${PORT}`);
  console.log(`Custom Models loaded: ${customModels.map(m => m.name).join(', ')}`);
});

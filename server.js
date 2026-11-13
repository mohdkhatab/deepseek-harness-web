const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
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

// Base directories
const rootWorkspaceDir = path.join(__dirname, 'workspaces');
if (!fs.existsSync(rootWorkspaceDir)) {
  fs.mkdirSync(rootWorkspaceDir, { recursive: true });
}
const defaultProjectDir = path.join(rootWorkspaceDir, 'default');
if (!fs.existsSync(defaultProjectDir)) {
  fs.mkdirSync(defaultProjectDir, { recursive: true });
}

// In-memory / persisted stores
let storedWorkspaces = [
  {
    workspaceId: "ws-default",
    path: defaultProjectDir,
    title: "default",
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
];

let storedSessions = [];

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

// Active WebSocket streams map: streamId -> { ws, endpoint }
const activeStreams = new Map();

function broadcastWorkspaceUpdate() {
  const frame = {
    type: "replace",
    value: {
      items: storedWorkspaces,
      archivedSessionIds: [],
      pinnedSessionIds: []
    }
  };
  for (const [streamId, sub] of activeStreams.entries()) {
    if (sub.endpoint.includes("workspace") && sub.ws.readyState === WebSocket.OPEN) {
      sub.ws.send(JSON.stringify({
        type: "item",
        streamId: streamId,
        value: frame
      }));
    }
  }
}

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

// Helpers for directory browsing
function getDirectoryListing(dirPath) {
  let target = dirPath || rootWorkspaceDir;
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }

  // Generate crumbs
  const relativeFromRoot = path.relative('/', target);
  const segments = relativeFromRoot.split(path.sep).filter(Boolean);
  const crumbs = [{ name: '/', path: '/', hidden: false }];
  let accum = '';
  for (const seg of segments) {
    accum += '/' + seg;
    crumbs.push({ name: seg, path: accum, hidden: seg.startsWith('.') });
  }

  // Read subdirectories
  let entries = [];
  try {
    const dirEntries = fs.readdirSync(target, { withFileTypes: true });
    entries = dirEntries
      .filter(d => d.isDirectory())
      .map(d => ({
        name: d.name,
        path: path.join(target, d.name),
        hidden: d.name.startsWith('.')
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    console.error("readdir error:", err.message);
  }

  return {
    path: target,
    home: rootWorkspaceDir,
    crumbs: crumbs,
    entries: entries,
    truncated: false
  };
}

// RPC API Handler (for DeepSeek Harness web frontend)
app.post(['/api', '/api/*'], async (req, res) => {
  const { rpcId = "rpc-default", method = "", payload = {} } = req.body || {};
  const pathPart = req.params[0] || "";
  const endpoint = method || pathPart;
  let value = {};

  console.log(`[RPC] Incoming: ${endpoint} (rpcId: ${rpcId})`);

  // 1. Directory Picker: list
  if (endpoint.includes("directoryPicker/list") || endpoint.includes("directoryPicker.list")) {
    const requestedPath = Array.isArray(payload?.args) ? payload.args[0] : (payload?.path || rootWorkspaceDir);
    value = getDirectoryListing(requestedPath);
  }
  // 2. Directory Picker: createDirectory
  else if (endpoint.includes("directoryPicker/createDirectory") || endpoint.includes("directoryPicker.createDirectory")) {
    const parentPath = Array.isArray(payload?.args) ? payload.args[0] : (payload?.path || rootWorkspaceDir);
    const newName = Array.isArray(payload?.args) ? payload.args[1] : (payload?.name || "new-folder");
    const fullCreatedPath = path.join(parentPath, newName);
    fs.mkdirSync(fullCreatedPath, { recursive: true });
    console.log(`[RPC] Created directory: ${fullCreatedPath}`);
    value = fullCreatedPath;
  }
  // 3. Directory Picker: pick
  else if (endpoint.includes("directoryPicker/pick") || endpoint.includes("directoryPicker.pick")) {
    value = defaultProjectDir;
  }
  // 4. Workspace: create
  else if (endpoint.includes("workspace/create") || endpoint.includes("workspace.create")) {
    const wsTarget = payload?.request?.path || payload?.path || (Array.isArray(payload?.args) ? payload.args[0]?.path : defaultProjectDir);
    fs.mkdirSync(wsTarget, { recursive: true });
    const existing = storedWorkspaces.find(w => w.path === wsTarget);
    if (existing) {
      value = { workspace: existing, created: false };
    } else {
      const newWs = {
        workspaceId: "ws-" + crypto.randomUUID().slice(0, 8),
        path: wsTarget,
        title: path.basename(wsTarget) || "workspace",
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      storedWorkspaces.push(newWs);
      broadcastWorkspaceUpdate();
      value = { workspace: newWs, created: true };
    }
  }
  // 5. Workspace: initializeDefault
  else if (endpoint.includes("workspace/initializeDefault") || endpoint.includes("workspace.initializeDefault")) {
    value = { workspace: storedWorkspaces[0], created: false };
  }
  // 6. Workspace: list / get
  else if (endpoint.includes("workspace/list") || endpoint === "workspace" || endpoint === "workspace/") {
    value = { workspaces: storedWorkspaces };
  }
  // 7. Session: create
  else if (endpoint.includes("session/create") || endpoint.includes("session.create")) {
    const wsId = payload?.request?.workspaceId || payload?.workspaceId || storedWorkspaces[0]?.workspaceId || "ws-default";
    const sessId = payload?.request?.sessionId || payload?.sessionId || "sess-" + crypto.randomUUID().slice(0, 8);
    const targetWs = storedWorkspaces.find(w => w.workspaceId === wsId) || storedWorkspaces[0];
    if (!targetWs.sessionIds.includes(sessId)) {
      targetWs.sessionIds.push(sessId);
      targetWs.updatedAt = new Date().toISOString();
      broadcastWorkspaceUpdate();
    }
    const newSession = {
      sessionId: sessId,
      workspaceId: wsId,
      title: "New Chat",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      blank: false,
      agentPreset: "default"
    };
    storedSessions.push(newSession);
    console.log(`[RPC] Created Session: ${sessId} in Workspace: ${wsId}`);
    value = {
      sessionId: sessId,
      workspaceId: wsId,
      title: "New Chat",
      createdAt: Date.now()
    };
  }
  // 8. Session: list
  else if (endpoint.includes("session/list") || endpoint.includes("session.list")) {
    value = { items: storedSessions };
  }
  // 9. Session: events
  else if (endpoint.includes("session/events") || endpoint.includes("session.events")) {
    value = { records: [], hasMore: false };
  }
  // 10. LLM Providers
  else if (endpoint.includes("llm/listProviders") || endpoint.includes("listProviders")) {
    value = [
      { id: "deepseek", name: "DeepSeek" },
      { id: "custom", name: "Custom Models" }
    ];
  } else if (endpoint.includes("llm/listConfigurableProviders")) {
    value = [];
  } else if (endpoint.includes("models") || endpoint.includes("model")) {
    value = customModels;
  }
  // 11. Account
  else if (endpoint.includes("account")) {
    value = {
      id: "admin-user",
      name: "Cloud Administrator",
      type: "admin"
    };
  }
  // 12. Chat Completion
  else if (endpoint.includes("chat") || endpoint.includes("completion")) {
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
              content: "👋 Welcome to DeepSeek Harness Web! Your workspace, folder manager, and custom model runtime are 100% active. You can add your API Key in Settings -> Models or in Render Environment Variables whenever you are ready."
            },
            finish_reason: "stop"
          }],
          usage: { prompt_tokens: 10, completion_tokens: 45, total_tokens: 55 }
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
      const streamId = data.streamId || "stream-1";
      const endpoint = data.endpoint || "";

      console.log(`[WebSocket] Frame: type=${data.type}, endpoint=${endpoint}, streamId=${streamId}`);

      if (data.type === 'open') {
        activeStreams.set(streamId, { ws, endpoint });

        // 1. Remote Event Stream ($events)
        if (endpoint === '$events' || !endpoint) {
          const readyFrame = {
            type: "item",
            streamId: streamId,
            value: {
              type: "ready",
              clientId: "render-client-" + crypto.randomUUID().slice(0, 8),
              host: {
                home: rootWorkspaceDir
              }
            }
          };
          ws.send(JSON.stringify(readyFrame));
          console.log('[WebSocket] Sent Remote ready confirmation frame to client');
        }
        // 2. Workspace Follow Stream (workspace/follow)
        else if (endpoint.includes("workspace") && endpoint.includes("follow")) {
          const baselineFrame = {
            type: "item",
            streamId: streamId,
            value: {
              type: "baseline",
              value: {
                items: storedWorkspaces,
                archivedSessionIds: [],
                pinnedSessionIds: []
              }
            }
          };
          ws.send(JSON.stringify(baselineFrame));
          console.log('[WebSocket] Sent Workspace baseline frame');
        }
        // 3. Session Follow Stream (session/follow)
        else if (endpoint.includes("session") && endpoint.includes("follow")) {
          const targetSessionId = data.payload?.address?.sessionId || storedSessions[0]?.sessionId || "sess-default";
          const snapshotFrame = {
            type: "item",
            streamId: streamId,
            value: {
              type: "snapshot",
              header: {
                version: 1,
                id: targetSessionId,
                createdAt: Date.now(),
                cwd: defaultProjectDir,
                isSeeded: false
              },
              cursor: 0,
              records: [],
              hasMore: false,
              projections: {
                asOfSeq: 0,
                values: {
                  inbox: { unreadCount: 0 }
                }
              }
            }
          };
          ws.send(JSON.stringify(snapshotFrame));
          console.log(`[WebSocket] Sent Session snapshot frame for ${targetSessionId}`);
        }
        // 4. Any other streams
        else {
          ws.send(JSON.stringify({
            type: "end",
            streamId: streamId
          }));
        }
      } else if (data.type === 'cancel' || data.type === 'end') {
        activeStreams.delete(streamId);
      } else if (data.type === 'ping') {
        ws.send(JSON.stringify({ type: "pong", streamId: streamId }));
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
    for (const [sId, sub] of activeStreams.entries()) {
      if (sub.ws === ws) activeStreams.delete(sId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[DeepSeek Harness Web] Running on http://0.0.0.0:${PORT}`);
  console.log(`Custom Models loaded: ${customModels.map(m => m.name).join(', ')}`);
});

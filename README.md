# DeepSeek Harness Web (Custom Models Edition)

Official DeepSeek Harness Web UI with built-in Custom Models support, ready for 1-click deployment on **Render.com**.

## Features

- **Official DeepSeek Harness Web UI**: Swimming whale logo, modern dark/light theme, sessions, and workspaces.
- **Custom Models Support**: Run DeepSeek-V3, DeepSeek-R1, OpenAI (GPT-4o), Anthropic (Claude 3.5), OpenRouter, or any custom OpenAI-compatible endpoint.
- **WebSocket & RPC Bridge**: Built-in `/api/remote.mux` WebSocket handshake and RPC server — no "Reconnecting" errors.
- **1-Click Render Deployment**: Works natively on Render Node.js runtime without Docker or complex setup.

---

## 🚀 How to Deploy on Render.com

### Method 1: Automatic Blueprint (Easiest)
1. Go to [Render Dashboard](https://dashboard.render.com/).
2. Click **New +** → **Blueprint**.
3. Connect your GitHub repository: `https://github.com/mohdkhatab/deepseek-harness-web`.
4. Render will read `render.yaml` automatically.
5. In **Environment Variables**, set your `DEEPSEEK_API_KEY`.
6. Click **Apply**. Done!

### Method 2: Manual Web Service
1. Click **New +** → **Web Service**.
2. Select your repository `deepseek-harness-web`.
3. Set the following options:
   - **Environment / Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
4. Add Environment Variables:
   - `DEEPSEEK_API_KEY`: Your DeepSeek API Key (from platform.deepseek.com)
   - `DEEPSEEK_BASE_URL`: `https://api.deepseek.com` (optional, defaults to DeepSeek)
5. Click **Create Web Service**.

---

## ⚙️ Adding Custom Models

You can add custom models dynamically at runtime via the REST API or by passing environment variables:

```bash
curl -X POST https://your-harness-app.onrender.com/api/custom-models \
  -H "Content-Type: application/json" \
  -d '{
    "id": "gpt-4o",
    "name": "OpenAI GPT-4o",
    "vendor": "OpenAI",
    "baseUrl": "https://api.openai.com/v1",
    "apiKey": "your-openai-api-key"
  }'
```

---

## 🛠 Local Development

```bash
git clone https://github.com/mohdkhatab/deepseek-harness-web.git
cd deepseek-harness-web
npm install
npm start
```
Then open `http://localhost:3000` in your browser.

# ⚗️ EasyPaper

🌐 **[English]** | **[한국어](README.ko.md)**

EasyPaper is an interactive web application for reading, translating, and chatting with academic PDF papers — all in one place. Upload a paper, get an AI-powered translation side-by-side with the original, and ask questions directly about the content. Supports local models via Ollama as well as cloud APIs (Gemini, Claude, OpenAI).

---

## ⚡ Quick Start

Get up and running with just three commands:

```bash
# 1. Clone the repository
git clone https://github.com/orion-gz/EasyPaper.git
cd EasyPaper

# 2. Run the setup script
# (Creates a Python virtualenv, installs all dependencies, copies .env, and builds the frontend)
./setup.sh

# 3. Start the server
./start.sh
```

Then open your browser and go to: `http://localhost:8000`

---

## 🚀 Features

1. **My Library** — Drag and drop PDFs directly onto the library screen to upload them. Background translation kicks off automatically.
2. **AI Category Tagging** — After upload, the LLM reads the abstract and body text to automatically assign category tags (e.g. `LLM`, `VLM`, `Optimizer`).
3. **Dual-Pane Viewer** — Read the original PDF and its AI translation side by side with a freely resizable split divider.
4. **AI Chat Assistant** — Ask questions about the paper, extract key results, or pull out mathematical formulas in natural language.
5. **Unified Model Picker** — Switch between providers and models (Ollama, Gemini, Claude, OpenAI) on the fly directly from the UI.

---

## 🛠️ Requirements

- **Python 3.8+**
- **Node.js 16+** & **npm**
- **Ollama** *(optional — only needed if you want to run models locally)*

---

## ⚙️ Manual Setup

If you prefer to configure everything by hand instead of using the helper scripts:

### Backend
```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python main.py
```
- API server: `http://localhost:8000`
- Swagger docs: `http://localhost:8000/docs`

### Frontend
```bash
cd frontend
npm install
npm run build  # Production build — served by the backend
# or
npm run dev    # Dev server at http://localhost:5173
```

---

## 🔐 Default Credentials

| Field    | Value   |
|----------|---------|
| Username | `admin` |
| Password | `admin` |

You can change your credentials at any time via the ⚙️ Settings panel (top-right corner of the library or viewer screen). Passwords are hashed and stored in `backend/.env`.

---

## ☁️ Running as a Background Service (Linux / systemd)

EasyPaper ships with a ready-made `easypaper.service` systemd unit file so you can run the server as a persistent background daemon in production.

**1. Edit the service file** — open `easypaper.service` and update the paths (e.g. `/home/ubuntu/...`) and the `User=` field to match your server environment.

**2. Register and start the service:**
```bash
sudo cp easypaper.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable easypaper
sudo systemctl start easypaper
```

**3. Monitor logs:**
```bash
sudo journalctl -u easypaper -f
```

---

## ⚡ Antigravity CLI (`agy`) Integration Guide

EasyPaper's backend includes a dedicated `antigravity` LLM provider that invokes the Google Antigravity CLI (`agy`) as a subprocess to handle translations, paper tagging, and chat queries.

To use the `antigravity` provider, complete the following steps:

### 1. Install the `agy` CLI

Make sure the `agy` binary is installed on your server.

- EasyPaper first looks for `agy` at `/home/ubuntu/.local/bin/agy`.
- If not found there, it falls back to whatever is on your system `PATH`.

> If you installed `agy` to a different path, make sure that path is included in your `PATH` environment variable.

### 2. Authenticate

The `agy` CLI must be authenticated under the same OS user account that will run the EasyPaper server (e.g. `ubuntu`).

```bash
# Run agy once to trigger the OAuth login flow
agy
```

On first launch, `agy` will print a Google OAuth URL. Open it in your browser, complete sign-in, then paste the authorization code back into the terminal. Once done, verify the setup:

```bash
/home/ubuntu/.local/bin/agy --help
```

### 3. Permissions

EasyPaper calls `agy` with the `--dangerously-skip-permissions` flag so that background translation jobs can run unattended without interactive confirmation prompts.

Ensure the server user has execute permissions for the `agy` binary and that the workspace directories referenced in `~/.gemini/antigravity-cli/settings.json` are accessible.

> **Not using Antigravity?** Set `TRANS_PROVIDER` and `CHAT_PROVIDER` to `ollama` in your `.env`, or supply API keys for Gemini, OpenAI, or Claude instead.




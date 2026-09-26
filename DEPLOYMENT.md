# Deploying ASTRAQ: get a link judges can click

**The short version:** put the code on GitHub, then import it into **Vercel**, with `web` as the root folder. In about 10 minutes you get a link like `https://astraq.vercel.app` that opens the full simulation in any browser. It is free and needs no credit card.

Why this works: the whole simulation engine runs **inside the browser** (a Web Worker), so the website is just static files. The Python server is **optional**. You only need it to show the FastAPI engine or the MP4 benchmark online.

| What you want | Where | Cost | Time |
|---|---|---|---|
| **The prototype link (recommended)** | Vercel, *or* Netlify, *or* GitHub Pages | Free | ~10 min |
| Optional Python engine + MP4 benchmark | Render | Free (sleeps when idle) | ~15 min |

---

## Step 0: Put the project on GitHub (needed for every option)

1. Create a free account at **https://github.com** if you don't have one.
2. Click **+** (top right) ▸ **New repository**.
   - Name: `ASTRAQ`
   - Visibility: **Public**, so judges can see the code.
   - Leave "Add a README" **unticked**, because the project already has one.
   - Click **Create repository**.
3. Unzip `ASTRAQ.zip` on your computer. Open a terminal **inside the `ASTRAQ` folder** (the one with `README.md`, `web` and `server`).
4. Run these commands, replacing `YOUR-USERNAME` with your GitHub username:

```bash
git init
git add .
git commit -m "ASTRAQ: SIH26169 prototype"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/ASTRAQ.git
git push -u origin main
```

> **Tips**
> * If `git` is not found, install it from https://git-scm.com and reopen the terminal.
> * If GitHub asks for a password, use a **Personal Access Token** (GitHub ▸ Settings ▸ Developer settings ▸ Personal access tokens ▸ Tokens (classic) ▸ Generate, with the `repo` scope). Or use **GitHub Desktop** (https://desktop.github.com): *File ▸ Add local repository ▸ Publish*.
> * Don't upload `node_modules`, `dist` or `.venv`. The included `.gitignore` already skips them.

Refresh the GitHub page. You should see your files and the README with screenshots.

---

## Option A: Vercel (recommended, easiest)

1. Go to **https://vercel.com** ▸ **Sign Up** ▸ **Continue with GitHub**.
2. On the dashboard click **Add New… ▸ Project**.
3. Find **ASTRAQ** in the list and click **Import**. If it's not listed, click *Adjust GitHub App Permissions* and allow the repository.
4. On the configure screen:
   - **Root Directory:** click **Edit** and choose **`web`**. This is the important step.
   - **Framework Preset:** Vite (detected automatically).
   - Build Command `npm run build` and Output Directory `dist` are already correct. The project includes `web/vercel.json` with these values.
5. Click **Deploy** and wait about 1–2 minutes.
6. You get a link like **`https://astraq-xxxx.vercel.app`**. Open it: the Earth appears, and within a few seconds the badge shows **LOCKED**.
7. *(Optional)* For a nicer name, go to **Settings ▸ Domains** and edit it to something like `astraq-sih.vercel.app`.

From now on, every `git push` to `main` redeploys automatically.

---

## Option B: Netlify (equally easy)

1. Go to **https://netlify.com** ▸ **Sign up** ▸ **GitHub**.
2. **Add new site ▸ Import an existing project ▸ GitHub** ▸ choose **ASTRAQ**.
3. Netlify reads the included `netlify.toml` (base `web`, command `npm run build`, publish `dist`, Node 20), so you don't need to type anything.
4. Click **Deploy**. Your link looks like `https://astraq-xxxx.netlify.app`. Rename it under **Site configuration ▸ Change site name**.

---

## Option C: GitHub Pages (no extra account)

The project includes a ready workflow at `.github/workflows/deploy-pages.yml`.

1. In your GitHub repository go to **Settings ▸ Pages**.
2. Under **Build and deployment ▸ Source**, choose **GitHub Actions**.
3. Go to the **Actions** tab ▸ **Deploy to GitHub Pages** ▸ **Run workflow**. It also runs on every push to `main`.
4. After about 2 minutes, the link appears on the workflow run and in Settings ▸ Pages: **`https://YOUR-USERNAME.github.io/ASTRAQ/`**.

The workflow builds with `ASTRAQ_BASE=/<repo-name>/`, so all files load correctly from the sub-folder. This was tested.

---

## Option D (optional): Put the Python engine online with Render

Do this only if you want judges to use **Experiment ▸ Engine ▸ FastAPI server**, the REST API docs, or the MP4 benchmark from the web. The main demo does not need it.

1. Go to **https://render.com** ▸ **Get Started** ▸ sign in with **GitHub**.
2. Click **New + ▸ Blueprint**, select the **ASTRAQ** repository, and click **Apply**. Render reads the included `render.yaml`:
   - root `server`
   - build `pip install -r requirements.txt`
   - start `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
   - Python 3.11
   - health check `/api/health`

   *Manual alternative:* **New + ▸ Web Service** ▸ choose the repo ▸ Root Directory `server` ▸ Runtime **Python 3** ▸ enter the build and start commands above ▸ Instance type **Free** ▸ add the environment variable `PYTHON_VERSION = 3.11.9`.
3. Wait for **Live** (the first build takes about 3–5 minutes). Your API is at `https://astraq-engine.onrender.com`.
4. Check it by opening `https://astraq-engine.onrender.com/api/health`, which should show `{"ok":true,...}`. The interactive API docs are at `/docs`.
5. **Connect the website to it** (pick one):
   - **Quick, per visitor:** in the app open **Experiment ▸ Engine ▸ FastAPI server**, paste `https://astraq-engine.onrender.com` and click **Connect**. The top chip changes to *FastAPI engine*.
   - **Make it the default:** in Vercel go to **Project ▸ Settings ▸ Environment Variables**, add `VITE_ASTRAQ_SERVER = https://astraq-engine.onrender.com`, then **Deployments ▸ ⋯ ▸ Redeploy**. On Netlify: *Site configuration ▸ Environment variables*, then *Trigger deploy*.

   The app turns `https://` into a secure `wss://` WebSocket automatically.
6. *(Optional, for security)* On Render, set `ASTRAQ_CORS` to your website address, for example `https://astraq-xxxx.vercel.app`, so only your site can call the API.

> **Free-tier note:** Render's free server sleeps after about 15 minutes idle. The first request after that takes about 30–60 s to wake it up. **Open the `/api/health` link a minute before your presentation.** If the server is asleep or unreachable, ASTRAQ tells you and keeps running on the built-in browser engine, so the demo never breaks.

## Option E: Windows desktop app (.exe) via GitHub Releases

Useful when the venue has poor internet, or judges want something to download.

1. **Build it** (any OS with Node 20+; building for Windows from Linux/macOS works too):
   ```bash
   cd web && npm install && npm run build
   cd ../desktop && npm install && npm run package:win
   ```
   The app is in `desktop/release/ASTRAQ-win32-x64/`. Zip that folder as **`ASTRAQ-Windows-x64.zip`**. (A ready-made zip is delivered alongside the project.)
2. On GitHub open your repository ▸ **Releases ▸ Draft a new release** ▸ tag `v1.1` ▸ drag in `ASTRAQ-Windows-x64.zip` ▸ **Publish release**.
3. The README's *Download the Windows app* link (`../../releases/latest`) now points at it.

Users extract the zip and double-click `ASTRAQ.exe`. The app is not code-signed, so Windows SmartScreen shows *"Windows protected your PC"*: click **More info ▸ Run anyway**. It needs no internet and no Python; the engine runs inside the app. For macOS/Linux use `npm run package:mac` / `npm run package:linux`.

---

## New API endpoints in v1.1 (performance reports)

| Endpoint | Returns |
|---|---|
| `GET /api/report?format=html\|md\|json` | report for the current live run |
| `GET /api/experiments/{id}/report?format=…` | report for a recorded experiment |
| `GET /api/video/{id}/report?format=…` | report for an analysed video |

`POST /api/video/analyze` also accepts `spotSizePx` (0 = estimate automatically) and `verifier` (true/false).

---

## Before you share the link: checklist

- [ ] The link opens on a phone or another computer (not only yours).
- [ ] The Earth and truck appear, and the badge reaches **LOCKED** within about 5 s.
- [ ] Pressing **D** starts the demo; **1–5** switch views; **V** opens the video benchmark and the built-in 2000×2000 stream runs.
- [ ] You pasted the link into the top of `README.md` in place of `https://YOUR-DEPLOYED-LINK.vercel.app` (it appears twice), then ran `git commit -am "Add live link" && git push`.
- [ ] *(If using Render)* `/api/health` answers, and Experiment ▸ Engine ▸ Connect works.
- [ ] You tried it in **Chrome or Edge** with hardware acceleration on.

## Troubleshooting

| Problem | Fix |
|---|---|
| Vercel/Netlify build says *"Could not find package.json"* | The root directory must be **`web`** (Vercel: Settings ▸ General ▸ Root Directory). |
| Build fails with a Node version error | Use Node 20+. Vercel: Settings ▸ General ▸ Node.js Version ▸ 20.x. Netlify already sets it in `netlify.toml`. |
| GitHub Pages shows a blank page | Make sure it was deployed by the included workflow (Source = **GitHub Actions**), not "Deploy from a branch". |
| Black 3D area | The visitor's browser has WebGL off. Enable hardware acceleration (Chrome ▸ Settings ▸ System), or use View ▸ Quality ▸ Low. Remote-desktop sessions often lack WebGL. |
| Slow on an old laptop | View ▸ Render quality ▸ **Low**. The simulation itself still runs at 30 Hz. |
| "Could not connect" to the FastAPI server | The Render server is waking up (wait 60 s and retry), the URL has a typo (no trailing path), or `ASTRAQ_CORS` doesn't include your site address. |
| Render build fails on `opencv-python-headless` | Only the MP4 benchmark needs it. Remove that line from `server/requirements.txt` and push again. |
| Changes don't appear | Push to `main`; Vercel, Netlify and Pages redeploy automatically. Hard-refresh the browser (Ctrl + Shift + R). |

## What judges get

- **Main link (Vercel/Netlify/Pages):** the full 3D simulation, the live tracker, demo mode, every drawer, graphs, recording, CSV/JSON export, replay and batch runs. Nothing to install.
- **Desktop app (GitHub Releases):** `ASTRAQ.exe`, the same app offline.
- **GitHub link:** the source code, README, test report and documentation.
- **API link (optional, Render):** `/docs` for the interactive REST API, the FastAPI engine inside the app, and the MP4 benchmark endpoint.

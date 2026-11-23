# ClipForge — Manual Video Clipping & YouTube Shorts Studio

ClipForge is a local-first video clipping and vertical Shorts publishing studio. Enter any YouTube, Twitch, Kick, or direct media URL, specify the exact timestamp ranges you want, download **only those segments**, manually position your facecam region with a live FFmpeg 9:16 preview, render vertical Shorts, keep all projects and clips saved locally across restarts, and upload directly to YouTube with optional Anthropic or OpenAI metadata assistance.

---

## Workflow

1. **Enter Video URL & Fetch Info (`1. Create Clips`)**: Paste a YouTube, Twitch, Kick, or direct `.mp4`/`.webm`/`.mov`/`.m3u8` URL and click **Fetch Video**. ClipForge inspects title, duration, resolution, frame rate, and thumbnail without downloading the full video.
2. **Enter Timestamps & Download Segments**: Paste multiline ranges (for example `00:05:20 - 00:06:05 Insane clutch` or `05:20 - 06:05`), validate against video duration and overlaps, and click **Download Selected Segment(s)**. Only those time ranges are saved into `workspace/sources/<projectId>/`.
3. **Manual Facecam Region & Layout Workspace**:
   - **Segment Library**: Switch active segments, multi-select segments, retry interrupted/failed downloads, preview raw downloaded segments, or bulk-apply facecam coordinates and layouts.
   - **1. Source Facecam Region**: Draw a box directly on the extracted segment frame, drag to move, resize using 8 corner/edge handles, scrub frame positions (`15%`, `50%`, `85%`), or adjust Width/Height sliders. You have full manual control—ClipForge never guesses or overrides facecam placement.
   - **2. Live 9:16 Preview**: Generates true FFmpeg 9:16 frame composites matching the final render math, plus an optional **Play 9:16 Video Preview** button.
   - **3. Vertical Layout & Render**: Pick from 11 vertical layouts (`Top Split`, `Bottom Split`, `50/50 Split`, 4 PiP corners, 2 Blurred-Background cards, `Center Crop`, `Cam Only`), optional header overlays (`Clean Raw`, `X Post Card`, `Hook Banner`, `Breaking News`), branding, resolution (`1080x1920` / `720x1280`), and FPS.
4. **Permanent Local Storage (`2. My Clips`)**: Completed MP4s and project state are saved under `workspace/` (`projects.json`, `clips.json`, `sources/`, `renders/`) and automatically restored on server restart until you explicitly delete a clip or project.
5. **YouTube Upload (`3. YouTube Upload`)**: Sign in with Google OAuth (tokens kept in browser memory only), optionally generate titles, 3 alternative titles, hook taglines, descriptions, hashtags, and searchable tags via backend Anthropic or OpenAI keys, edit freely, and upload or schedule Shorts via YouTube Data API v3.

> **First-time YouTube sign-in**: The Firebase project backing Google OAuth must authorize the host you open the app from. For local dev this means `localhost` must be listed under **Firebase Console → Authentication → Settings → Authorized domains** (project `project-457b651b-8bca-442e-b2f`). If you see *"This domain (localhost) is not authorized in Firebase Authentication"*, add `localhost` there and retry — no app restart needed. For production, authorize your real domain instead and leave `localhost` out of public deployments.

---

## Prerequisites

- **Node.js** `20+` and `npm`
- **FFmpeg** and **ffprobe** installed and available on `PATH`
- **Python 3** (used if `yt-dlp` auto-bootstraps its standalone binary on Linux/macOS)

### Installing FFmpeg

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt update && sudo apt install -y ffmpeg python3
  ```
- **macOS (Homebrew)**:
  ```bash
  brew install ffmpeg yt-dlp
  ```
- **Windows**:
  - Winget: `winget install Gyan.FFmpeg`
  - Or Chocolatey: `choco install ffmpeg -y`
  - Or download from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) and add `bin/` to your system `PATH`.

> **`yt-dlp` Note**: Installing `yt-dlp` globally is optional. If not found on `PATH`, ClipForge automatically downloads the official standalone `yt-dlp` binary into `workspace/bin/` on first URL inspection.

---

## Setup Instructions

### 1. Clone the repository

```bash
git clone https://github.com/Roshindroid/ClipForge-V2.git
cd ClipForge-V2
```

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment variables

Create your local `.env` file from `.env.example`:

```bash
cp .env.example .env
```

Edit `.env` with any optional settings you want to enable (never commit `.env` to git):

```env
# Server port (defaults to 3000)
PORT=3000

# Optional AI Metadata Assistant for YouTube Upload (backend-only)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=

# Optional custom storage directories (defaults to workspace/sources and workspace/renders)
CLIPFORGE_SOURCES_DIR=
CLIPFORGE_RENDERS_DIR=

# Optional yt-dlp settings (for age-restricted or bot-checked YouTube links)
YTDLP_JS_RUNTIME=node
YTDLP_COOKIES_FILE=
YTDLP_COOKIES_FROM_BROWSER=
```

- **AI Keys (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`)**: Optional. Used exclusively on the backend in the **YouTube Upload** tab to draft titles, descriptions, hashtags, and searchable tags. At least one of the two must be set for the AI metadata assistant to respond; the entire clipping and publishing workflow works without either. Note: the `.env.example` also lists `GROQ_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, and `OLLAMA_*` entries, but the backend currently only reads `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` — the others are reserved for future use.
- **YouTube Cookies (Automatic + Manual)**: ClipForge automatically detects installed desktop browser profiles (`chrome`, `edge`, `brave`, `firefox`, etc.) and local Netscape `cookies.txt` files in the project root, `workspace/`, `~/Downloads`, `~/Desktop`, or `~/` with automatic fallback. You can also set `YTDLP_COOKIES_FILE` / `YTDLP_COOKIES_FROM_BROWSER` in `.env`, or click **YouTube Cookies** in the UI to upload, paste, or re-scan.

### 4. Start the application

**Development mode** (Express backend + Vite frontend on port `3000`):

```bash
npm run dev
```

Open `http://localhost:3000` in your browser.

**Production build & start**:

```bash
npm run build
npm run start
```

---

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Express + Vite dev server on `http://0.0.0.0:3000` |
| `npm run build` | Build production frontend bundle into `dist/` |
| `npm run start` | Start production Express server (`node server.ts`) |
| `npm run preview` | Preview production Vite build |
| `npm run lint` | Run TypeScript type checking (`tsc --noEmit`) |
| `npm run clean` | Remove `dist/` and `server.js` |
| `npx tsx scripts/test_v2_flow.ts` | Run end-to-end timestamp, FFmpeg layout, batch render, and persistence tests |

---

## Project Structure

```text
ClipForge-V2/
├── server.ts                    # Express API routes, boot workspace recovery & Vite/static serving
├── vite.config.ts               # Vite + React + Tailwind configuration
├── package.json                 # Dependencies & npm scripts
├── .env.example                 # Environment variable template
├── .gitignore                   # Excludes .env*, cookies, workspace/, node_modules/, dist/
├── firebase-applet-config.json  # Public Firebase Web SDK config for Google OAuth
├── server/
│   ├── capabilities.ts          # Runtime NVIDIA NVENC hardware encoder probe
│   ├── ingest.ts                # URL inspection, frame extraction & timestamp-slice downloads
│   ├── llmRouter.ts             # Optional backend-only Anthropic/OpenAI YouTube metadata generator
│   ├── projectRunner.ts         # Separated segment download & manual-facecam render queues
│   ├── rendererV2.ts            # FFmpeg filter graphs for 11 layouts, previews & output verification
│   ├── storage.ts               # Atomic JSON persistence, restart recovery & path-traversal guards
│   └── ytdlp.ts                 # yt-dlp metadata, section downloads & local cookie management
├── src/
│   ├── App.tsx                  # 3-tab app shell: Create Clips, My Clips, YouTube Upload
│   ├── types.ts                 # Shared TypeScript interfaces & 11 LAYOUT_OPTIONS metadata
│   ├── lib/
│   │   ├── timestampParser.ts   # Multiline HH:MM:SS / MM:SS parser & validation
│   │   └── youtubeAuth.ts       # Firebase Google sign-in + YouTube Data API v3 resumable upload
│   └── components/
│       ├── CreateClipsView.tsx      # Project switcher, URL inspect, timestamps & download progress
│       ├── FacecamLayoutStudio.tsx  # Segment library, manual facecam box, live 9:16 preview & render
│       ├── LayoutThumbnail.tsx      # 9:16 SVG layout thumbnails
│       ├── RenderQueueView.tsx      # My Clips persistent library (play, download, delete, publish)
│       └── YouTubePublishView.tsx   # Metadata editor, optional AI Assist & YouTube upload/scheduling
├── scripts/
│   └── test_v2_flow.ts          # Automated backend & FFmpeg verification suite
└── workspace/                   # Gitignored runtime data (projects.json, clips.json, sources/, renders/)
```

---

## Notes

- **Manual-First Design**: Automatic facecam detection and automatic clip discovery are disabled. Facecam-based layouts require you to draw and save a facecam region, or choose **Center Crop** for full-frame footage.
- **Persistent Workspace**: Projects, downloaded segments, and finished MP4 clips live in `workspace/` and remain available after restarting the server or computer until explicitly deleted.
- **Credential Safety**: `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are read only on the backend and never sent to the browser. YouTube OAuth access tokens stay in browser memory only.

---

## Troubleshooting

### "EPERM: operation not permitted, rename ... projects.json" (Windows)

Symptom: the server crashes mid-render with a `rename` EPERM on `workspace/projects.json`.

Cause: the project lives in a OneDrive-synced folder (or is scanned by antivirus). OneDrive/AV briefly lock files, which makes Node's atomic `rename()` fail during the per-progress `saveProject` write.

Fix applied in `server/storage.ts`: `writeJsonAtomic` now retries the rename with backoff on transient lock errors (EPERM/EACCES/EBUSY, up to 8 attempts) and falls back to an in-place overwrite if the lock persists. If crashes still occur, move the project out of OneDrive (e.g. `C:\dev\ClipForge-V2`) or pause OneDrive sync while rendering.

### "This domain (localhost) is not authorized in Firebase Authentication"

Cause: the Firebase project's Authorized Domains list doesn't include the host you're browsing from.

Fix: Firebase Console → Authentication → Settings → Authorized domains → Add `localhost` (or your production domain). No restart required. See step 5 above for the project ID.

### AI metadata assistant returns "No AI provider keys configured"

Cause: neither `OPENAI_API_KEY` nor `ANTHROPIC_API_KEY` is set in `.env`.

Fix: set at least one of them in `.env` and restart the server. The clipping and manual metadata workflows still work without any key.

### Port 3000 already in use (`EADDRINUSE`)

Another process (a previous dev server, or the Vite HMR websocket on 24678) is still bound. Stop it (close the old terminal, or `Stop-Process` the orphaned `node` / `tsx` process) and rerun `npm run dev`.
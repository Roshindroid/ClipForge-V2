# ClipForge — Smart 1080p Stream & Video Clip Engine

ClipForge finds viral moments from short clips or 50-hour+ streams **before downloading full VODs**, lets you verify and select only the moments you want, downloads **only those selected segments in 1080p MP4**, renders clean 9:16 vertical YouTube Shorts across 11 layouts, and publishes directly to YouTube.

## How the Smart 1080p Segments Workflow Works

1. **Inspect Link (Zero Full-VOD Download)**: Paste a YouTube, Twitch, Kick, or direct `.mp4`/`.m3u8` URL. ClipForge fetches metadata, remote subtitles/auto-captions, YouTube heatmaps/chapters, and stratified remote audio spikes to rank viral moments—without downloading multi-gigabyte VODs.
2. **Verify & Select Moments**: Check or uncheck detected moments, preview audio/video slices, or click **Verify in Tab** to jump directly to that exact timestamp on the original video in a new browser tab.
3. **Download Only Selected Segments in 1080p**: Download selected timestamps (`[startSec..endSec]`) into `workspace/sources/<folder>/` at up to 1080p MP4 (`yt-dlp --download-sections` or FFmpeg slice), or jump straight to render and ClipForge fetches missing segments on demand.
4. **Layout, Render & Auto-Prune**: Frame your facecam across 11 vertical layouts, optionally add a clean header template (X Post, TikTok Hook, Breaking News—no burned captions), batch render 720×1280 H.264 Shorts, and optionally enable **Auto-Prune Segments After Render** to remove temporary 1080p source segments once all queued renders succeed.
5. **Publish to YouTube**: Sign in with Google OAuth (tokens kept in browser memory only) and upload or schedule Shorts directly via YouTube Data API v3.

## Smart Clip Generation

ClipForge automatically detects the optimal number of viral moments based on video duration:

| Video Duration | Clips Generated | Min Separation |
|----------------|-----------------|----------------|
| **> 3 hours** (10,800s+) | **30–40 clips** | ~duration/clips × 0.8 |
| **1–3 hours** (3,600–10,800s) | **15–25 clips** | ~duration/clips × 0.8 |
| **< 1 hour** | **10–15 clips** (min 10) | ~duration/clips × 0.8 |

This ensures comprehensive coverage for long streams while keeping shorter videos focused.

## Tech Stack

- **Frontend**: React 19, TypeScript, Tailwind CSS 4, Vite 8, Motion, Lucide React
- **Backend**: Express.js + TypeScript (`tsx`)
- **Video & Stream Extraction**: FFmpeg / ffprobe + `yt-dlp` (system binary or auto-bootstrapped standalone zipapp)
- **Storage**: Local JSON files & media workspace under `workspace/` (projects, clips, settings, sources, frames, renders)
- **Auth**: Firebase + YouTube Data API v3

## Project Structure

```text
ClipForge/
├── server.ts                    # Express server — API routes, job polling, segment previews
├── vite.config.ts               # Vite + Tailwind + React plugin
├── package.json                 # Node dependencies & scripts
├── .env.example                 # Environment variable template
├── firebase-applet-config.json  # Firebase config (Google OAuth for YouTube)
├── server/                      # Backend modules
│   ├── analyzer.ts              # Remote probing, transcript hooks, facecam & viral scoring
│   ├── capabilities.ts          # NVENC hardware encoder & Ollama availability checks
│   ├── ingest.ts                # Zero-VOD URL inspection, 1080p segment downloader, uploads
│   ├── jobs.ts                  # In-memory background job queue & progress tracker
│   ├── llmRouter.ts             # Optional Gemini / Groq / OpenRouter / Ollama viral scorer
│   ├── renderer.ts              # FFmpeg filter graphs for 11 vertical 9:16 layouts
│   ├── storage.ts               # JSON CRUD, workspace cleanup & path traversal guards
│   └── ytdlp.ts                 # Auto-bootstrapped yt-dlp, cookies, subtitles & section cuts
├── src/                         # React frontend
│   ├── main.tsx, App.tsx        # App shell with 4 steps: Discover, Layout & Render, Shorts, Publish
│   ├── types.ts                 # Shared TS types, JobStatus & 11 LAYOUT_OPTIONS metadata
│   ├── index.css                # Tailwind + theme
│   ├── lib/
│   │   ├── jobs.ts              # Async job poller & HH:MM:SS timecode helpers
│   │   └── youtubeAuth.ts       # Firebase Google sign-in + YouTube resumable upload
│   └── components/
│       ├── IngestAnalyzeView.tsx     # Link inspection, moment checklist, 1080p segment downloads
│       ├── FacecamLayoutStudio.tsx   # Interactive facecam box, 11 layouts, templates, render
│       ├── RenderQueueView.tsx       # Rendered Shorts gallery, storage cleanup, publish handoff
│       ├── YouTubePublishView.tsx    # Metadata composer, Google sign-in, resumable upload
│       └── LayoutThumbnail.tsx       # SVG wireframe previews per layout
└── workspace/                   # Runtime data (gitignored: sources, frames, renders, cookies, JSON)
```

## Quick Start

### 1. Install system dependencies

ClipForge requires **FFmpeg** and **ffprobe** on `PATH`.

- **Windows**: 
  - FFmpeg: Download from [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases) (extract `bin/ffmpeg.exe`, `bin/ffprobe.exe` to a folder in PATH)
  - Or use Chocolatey: `choco install ffmpeg -y`
  - Or winget: `winget install Gyan.FFmpeg`
- **macOS**: `brew install ffmpeg yt-dlp`
- **Linux**: `sudo apt install ffmpeg python3`

`yt-dlp` is optional to install globally — if missing from `PATH`, ClipForge automatically downloads the official standalone `yt-dlp` zipapp to `workspace/bin/yt-dlp` (or `yt-dlp.exe` on Windows) on first URL inspection.

### 2. Install Node dependencies

```bash
npm install
```

### 3. Configure environment

Copy `.env.example` to `.env` and fill in any optional AI or `yt-dlp` settings:

```env
# Optional AI Moment Scoring (falls back cleanly to audio/heatmap/transcript scoring if omitted)
GEMINI_API_KEY=
GROQ_API_KEY=
OPENROUTER_API_KEY=

# Optional Local Ollama
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.2:3b

# yt-dlp JavaScript runtime for YouTube extraction (defaults to node)
YTDLP_JS_RUNTIME=node

# YouTube cookies (use ONE if YouTube requests bot verification):
# Option A (Recommended): Upload cookies.txt in the Discover Moments view ("YouTube Cookies")
# Option B (Server file path):
YTDLP_COOKIES_FILE=
# Option C (Local desktop browser profile):
YTDLP_COOKIES_FROM_BROWSER=

# Optional custom storage folders (defaults to workspace/sources and workspace/renders)
CLIPFORGE_SOURCES_DIR=
CLIPFORGE_RENDERS_DIR=
```

### 4. Run the dev server

```bash
npm run dev
```

Server listens on `http://0.0.0.0:3000`.

## Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start Express + Vite dev server on port 3000 (`0.0.0.0`) |
| `npm run build` | Build production frontend into `dist/` |
| `npm run start` | Production server start (`node server.ts`) |
| `npm run preview` | Preview production Vite build |
| `npm run lint` | TypeScript typecheck (`tsc --noEmit`) |
| `npm run clean` | Remove `dist/` and `server.js` |

## Notes

- YouTube OAuth tokens stay in browser memory only (never persisted to `localStorage`).
- Uploaded YouTube `cookies.txt` files are stored server-side at `workspace/ytdlp_cookies.txt` (`0600`), gitignored with `workspace/`, and never returned over API responses.
- Rendered Shorts contain no burned-in subtitles—YouTube auto-captions handle subtitles cleanly.
- `firebase-applet-config.json` contains public Firebase Web SDK configuration for Google Sign-In.
- On Windows, FFmpeg and yt-dlp binaries are auto-located in `workspace/bin/` if not on system PATH.
- The `workspace/` directory is gitignored and contains all runtime data (sources, renders, frames, cookies, JSON).
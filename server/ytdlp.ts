import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { WORKSPACE_ROOT, ensureWorkspace } from './storage.ts';

export interface VideoChapter {
  startSec: number;
  endSec: number;
  title: string;
}

export interface HeatmapPoint {
  startSec: number;
  endSec: number;
  value: number;
}

const execFileAsync = promisify(execFile);

const BIN_DIR = path.join(WORKSPACE_ROOT, 'bin');
const LOCAL_YTDLP_PATH = path.join(BIN_DIR, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
export const WORKSPACE_COOKIES_PATH = path.join(WORKSPACE_ROOT, 'ytdlp_cookies.txt');
const YTDLP_ZIPAPP_URL = process.platform === 'win32'
  ? 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
  : 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp';

let installPromise: Promise<string> | null = null;

export interface ResolvedStreamUrls {
  videoUrl: string;
  audioUrl: string;
  isSeparate: boolean;
  resolvedAt: number;
}

export interface YtDlpMetadata {
  title: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  isLive: boolean;
  chapters: VideoChapter[];
  heatmap: HeatmapPoint[];
  thumbnailUrl?: string;
  streamUrls?: ResolvedStreamUrls;
}

const streamUrlCache = new Map<string, ResolvedStreamUrls>();
const STREAM_CACHE_TTL_MS = 3 * 60 * 60 * 1000;

export async function findExistingYtDlpBinary(): Promise<string | null> {
  try {
    await execFileAsync('yt-dlp', ['--version'], { timeout: 2500 });
    return 'yt-dlp';
  } catch {
    // not on PATH
  }
  if (fs.existsSync(LOCAL_YTDLP_PATH)) {
    try {
      await execFileAsync(LOCAL_YTDLP_PATH, ['--version'], { timeout: 3000 });
      return LOCAL_YTDLP_PATH;
    } catch {
      // broken local binary; re-download on demand
    }
  }
  return null;
}

export async function ensureYtDlp(): Promise<string> {
  const existing = await findExistingYtDlpBinary();
  if (existing) return existing;
  if (installPromise) return installPromise;

  installPromise = (async () => {
    ensureWorkspace();
    if (!fs.existsSync(BIN_DIR)) {
      fs.mkdirSync(BIN_DIR, { recursive: true });
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(YTDLP_ZIPAPP_URL, {
        signal: controller.signal,
        redirect: 'follow',
      });
      if (!res.ok || !res.body) {
        throw new Error(`Failed to download yt-dlp standalone binary (HTTP ${res.status})`);
      }
      const tmpPath = `${LOCAL_YTDLP_PATH}.tmp`;
      const bodyStream = Readable.fromWeb(res.body as unknown as import('node:stream/web').ReadableStream);
      await pipeline(bodyStream, fs.createWriteStream(tmpPath));
      if (process.platform !== 'win32') {
        fs.chmodSync(tmpPath, 0o755);
      }
      // On Windows, use copy + unlink to avoid EPERM from OneDrive/locks
      if (process.platform === 'win32') {
        if (fs.existsSync(LOCAL_YTDLP_PATH)) {
          try { fs.unlinkSync(LOCAL_YTDLP_PATH); } catch {}
        }
        // Copy instead of rename to avoid EPERM on synced folders
        fs.copyFileSync(tmpPath, LOCAL_YTDLP_PATH);
        try { fs.unlinkSync(tmpPath); } catch {}
      } else {
        fs.renameSync(tmpPath, LOCAL_YTDLP_PATH);
      }
      await execFileAsync(LOCAL_YTDLP_PATH, ['--version'], { timeout: 4000 });
      return LOCAL_YTDLP_PATH;
    } finally {
      clearTimeout(timer);
      installPromise = null;
    }
  })();

  return installPromise;
}

function hasLocalBrowserProfile(browserSpec: string): boolean {
  const home = process.env.HOME || '/root';
  const browser = browserSpec.split(':')[0].trim().toLowerCase();
  const candidates: Record<string, string[]> = {
    chrome: [`${home}/.config/google-chrome`, `${home}/Library/Application Support/Google/Chrome`],
    chromium: [`${home}/.config/chromium`],
    brave: [`${home}/.config/BraveSoftware/Brave-Browser`],
    edge: [`${home}/.config/microsoft-edge`],
    firefox: [`${home}/.mozilla/firefox`, `${home}/Library/Application Support/Firefox`],
  };
  const paths = candidates[browser] || [];
  return paths.some((p) => fs.existsSync(p));
}

export function getCookiesStatus(): {
  configured: boolean;
  source: 'env' | 'workspace' | 'browser' | 'none';
  cookieCount: number;
  updatedAt?: string;
} {
  const envFile = process.env.YTDLP_COOKIES_FILE?.trim();
  if (envFile && fs.existsSync(envFile)) {
    const lines = fs
      .readFileSync(envFile, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#'));
    return { configured: lines.length > 0, source: 'env', cookieCount: lines.length };
  }

  if (fs.existsSync(WORKSPACE_COOKIES_PATH)) {
    const stat = fs.statSync(WORKSPACE_COOKIES_PATH);
    const lines = fs
      .readFileSync(WORKSPACE_COOKIES_PATH, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.startsWith('#'));
    if (lines.length > 0) {
      return {
        configured: true,
        source: 'workspace',
        cookieCount: lines.length,
        updatedAt: stat.mtime.toISOString(),
      };
    }
  }

  const browserSpec = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  if (browserSpec && hasLocalBrowserProfile(browserSpec)) {
    return { configured: true, source: 'browser', cookieCount: 1 };
  }

  return { configured: false, source: 'none', cookieCount: 0 };
}

export function saveCookiesContent(rawInput: string): {
  configured: boolean;
  source: 'workspace';
  cookieCount: number;
  updatedAt: string;
} {
  ensureWorkspace();
  const trimmed = rawInput.trim();
  if (!trimmed) throw new Error('Cookie content cannot be empty.');

  const lines = trimmed.split(/\r?\n/);
  const netscapeLines = lines.filter((l) => {
    const t = l.trim();
    return t && !t.startsWith('#') && t.split('\t').length >= 7;
  });

  let finalContent = '';
  let count = 0;

  if (netscapeLines.length > 0) {
    finalContent = '# Netscape HTTP Cookie File\n' + netscapeLines.join('\n') + '\n';
    count = netscapeLines.length;
  } else {
    const cleaned = trimmed.replace(/^cookie:\s*/i, '');
    const pairs = cleaned
      .split(';')
      .map((p) => p.trim())
      .filter((p) => p.includes('='));
    if (pairs.length === 0) {
      throw new Error(
        'Invalid cookies format. Export a Netscape cookies.txt file from your browser or paste a Cookie header string.'
      );
    }
    const expiry = Math.floor(Date.now() / 1000) + 365 * 24 * 3600;
    const rows = pairs.map((pair) => {
      const eqIdx = pair.indexOf('=');
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      return `.youtube.com\tTRUE\t/\tTRUE\t${expiry}\t${name}\t${val}`;
    });
    finalContent = '# Netscape HTTP Cookie File\n' + rows.join('\n') + '\n';
    count = rows.length;
  }

  fs.writeFileSync(WORKSPACE_COOKIES_PATH, finalContent, { encoding: 'utf8', mode: 0o600 });
  return {
    configured: true,
    source: 'workspace',
    cookieCount: count,
    updatedAt: new Date().toISOString(),
  };
}

export function clearCookiesFile(): void {
  if (fs.existsSync(WORKSPACE_COOKIES_PATH)) {
    fs.unlinkSync(WORKSPACE_COOKIES_PATH);
  }
}

export function getYtDlpBaseArgs(): string[] {
  const args: string[] = ['--no-playlist', '--no-warnings'];
  const cookiesFile = process.env.YTDLP_COOKIES_FILE?.trim();
  const cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER?.trim();
  const jsRuntime = process.env.YTDLP_JS_RUNTIME?.trim() || `node:${process.execPath}`;

  if (cookiesFile && fs.existsSync(cookiesFile)) {
    args.push('--cookies', cookiesFile);
  } else if (fs.existsSync(WORKSPACE_COOKIES_PATH)) {
    args.push('--cookies', WORKSPACE_COOKIES_PATH);
  } else if (cookiesFromBrowser && hasLocalBrowserProfile(cookiesFromBrowser)) {
    args.push('--cookies-from-browser', cookiesFromBrowser);
  }
  if (jsRuntime) {
    args.push('--js-runtimes', jsRuntime);
  }
  return args;
}

export function runProcessWithTimeout(
  cmd: string,
  args: string[],
  timeoutMs = 120000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { shell: false });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
        reject(new Error(`${path.basename(cmd)} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 4 * 1024 * 1024) stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 512 * 1024) stderr += String(chunk);
    });
    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(stderr.trim() || `${path.basename(cmd)} exited with code ${code}`));
      }
    });
  });
}

function formatYtDlpError(rawErr: string, platform: string): Error {
  const lower = rawErr.toLowerCase();
  if (lower.includes('sign in to confirm') || lower.includes('cookies')) {
    return new Error(
      `${platform.toUpperCase()} requested bot verification from this server IP. Upload or paste your YouTube cookies.txt below (via "YouTube Cookies") and try again.`
    );
  }
  if (lower.includes('private video') || lower.includes('unavailable')) {
    return new Error(`This ${platform.toUpperCase()} video is private or unavailable.`);
  }
  return new Error(rawErr.slice(0, 280));
}

export async function fetchMetadataWithYtDlp(
  url: string,
  platform: string
): Promise<YtDlpMetadata> {
  const bin = await ensureYtDlp();
  const baseArgs = getYtDlpBaseArgs();

  let stdout = '';
  try {
    const res = await runProcessWithTimeout(
      bin,
      [
        ...baseArgs,
        '--dump-single-json',
        '--skip-download',
        '-f',
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b',
        url,
      ],
      60000
    );
    stdout = res.stdout;
  } catch (err) {
    try {
      const res = await runProcessWithTimeout(
        bin,
        [...baseArgs, '--dump-single-json', '--skip-download', url],
        60000
      );
      stdout = res.stdout;
    } catch (fallbackErr) {
      const msg = fallbackErr instanceof Error ? fallbackErr.message : String(err);
      throw formatYtDlpError(msg, platform);
    }
  }

  const info = JSON.parse(stdout) as {
    title?: string;
    duration?: number;
    width?: number;
    height?: number;
    fps?: number;
    is_live?: boolean;
    url?: string;
    thumbnail?: string;
    thumbnails?: Array<{ url?: string; preference?: number }>;
    requested_formats?: Array<{
      url?: string;
      vcodec?: string;
      acodec?: string;
      width?: number;
      height?: number;
      fps?: number;
    }>;
    chapters?: Array<{ start_time?: number; end_time?: number; title?: string }>;
    heatmap?: Array<{ start_time?: number; end_time?: number; value?: number }>;
  };

  let streamUrls: ResolvedStreamUrls | undefined;
  const reqFormats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
  if (reqFormats.length >= 2) {
    const vidFmt = reqFormats.find((f) => f.vcodec && f.vcodec !== 'none') || reqFormats[0];
    const audFmt = reqFormats.find((f) => f.acodec && f.acodec !== 'none') || reqFormats[1];
    if (vidFmt?.url && audFmt?.url) {
      streamUrls = {
        videoUrl: vidFmt.url,
        audioUrl: audFmt.url,
        isSeparate: vidFmt.url !== audFmt.url,
        resolvedAt: Date.now(),
      };
    }
  } else if (info.url) {
    streamUrls = {
      videoUrl: info.url,
      audioUrl: info.url,
      isSeparate: false,
      resolvedAt: Date.now(),
    };
  }

  if (streamUrls) {
    streamUrlCache.set(url, streamUrls);
  }

  const chapters: VideoChapter[] = Array.isArray(info.chapters)
    ? info.chapters
        .filter((c) => typeof c.start_time === 'number' && typeof c.end_time === 'number')
        .map((c) => ({
          startSec: Math.max(0, Number(c.start_time)),
          endSec: Math.max(0, Number(c.end_time)),
          title: String(c.title || 'Chapter').slice(0, 90),
        }))
    : [];

  const heatmap: HeatmapPoint[] = Array.isArray(info.heatmap)
    ? info.heatmap
        .filter((h) => typeof h.start_time === 'number' && typeof h.value === 'number')
        .map((h) => ({
          startSec: Math.max(0, Number(h.start_time)),
          endSec: Math.max(Number(h.start_time), Number(h.end_time ?? h.start_time)),
          value: Number(h.value || 0),
        }))
    : [];

  const vidFmt = reqFormats.find((f) => f.width && f.height);
  const thumbList = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const bestThumb =
    info.thumbnail ||
    (thumbList.length > 0 ? thumbList[thumbList.length - 1]?.url : undefined);

  return {
    title: String(info.title || `${platform.toUpperCase()} Stream`).slice(0, 120),
    durationSec: Math.max(1, Number(info.duration || 0)),
    width: Number(info.width || vidFmt?.width || 1280),
    height: Number(info.height || vidFmt?.height || 720),
    fps: Number(info.fps || vidFmt?.fps || 30),
    hasAudio: true,
    isLive: Boolean(info.is_live),
    chapters,
    heatmap,
    thumbnailUrl: typeof bestThumb === 'string' && bestThumb.startsWith('http') ? bestThumb : undefined,
    streamUrls,
  };
}

/**
 * Fetches subtitles / auto-captions remotely via yt-dlp (--skip-download) so the AI
 * can read dialogue across long streams without downloading any video bytes.
 */
export async function fetchSubtitlesWithYtDlp(url: string): Promise<string | undefined> {
  const bin = await ensureYtDlp();
  const baseArgs = getYtDlpBaseArgs();
  const tmpDir = path.join(WORKSPACE_ROOT, `subs_${crypto.randomBytes(4).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    await runProcessWithTimeout(
      bin,
      [
        ...baseArgs,
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-langs',
        'en.*,en',
        '--convert-subs',
        'srt',
        '-o',
        path.join(tmpDir, 'caption.%(ext)s'),
        url,
      ],
      35000
    ).catch(() => {});

    const files = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.srt') || f.endsWith('.vtt'));
    if (files.length === 0) return undefined;

    // Prefer manual subs over auto-generated if multiple exist
    files.sort((a, b) => a.length - b.length);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8').trim();
    return content.length > 0 ? content : undefined;
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup errors
    }
  }
}

export async function resolveStreamUrlsWithYtDlp(
  url: string,
  forceRefresh = false
): Promise<ResolvedStreamUrls> {
  const cached = streamUrlCache.get(url);
  if (!forceRefresh && cached && Date.now() - cached.resolvedAt < STREAM_CACHE_TTL_MS) {
    return cached;
  }

  const bin = await ensureYtDlp();
  const baseArgs = getYtDlpBaseArgs();

  let lines: string[] = [];
  try {
    const res = await runProcessWithTimeout(
      bin,
      [
        ...baseArgs,
        '-f',
        'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/bv*[height<=1080]+ba/b',
        '-g',
        url,
      ],
      45000
    );
    lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('http'));
  } catch {
    const res = await runProcessWithTimeout(bin, [...baseArgs, '-g', url], 45000);
    lines = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith('http'));
  }

  if (lines.length === 0) {
    throw new Error('Could not resolve playable stream URLs from link.');
  }

  const resolved: ResolvedStreamUrls =
    lines.length >= 2
      ? {
          videoUrl: lines[0],
          audioUrl: lines[1],
          isSeparate: lines[0] !== lines[1],
          resolvedAt: Date.now(),
        }
      : {
          videoUrl: lines[0],
          audioUrl: lines[0],
          isSeparate: false,
          resolvedAt: Date.now(),
        };

  streamUrlCache.set(url, resolved);
  return resolved;
}

/**
 * Downloads ONLY the selected time slice [startSec..endSec] in up to 1080p MP4 using yt-dlp
 * (--download-sections) with live progress and a stall-only timeout.
 */
export async function downloadSegmentWithYtDlp(
  url: string,
  startSec: number,
  endSec: number,
  targetPath: string,
  platform = 'video',
  onProgress?: (pct: number, detail: string) => void
): Promise<void> {
  const bin = await ensureYtDlp();
  const baseArgs = getYtDlpBaseArgs();
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const s = Math.max(0, Math.floor(startSec));
  const e = Math.max(s + 2, Math.ceil(endSec));

  const args = [
    ...baseArgs,
    '--newline',
    '--progress',
    '--download-sections',
    `*${s}-${e}`,
    '--force-keyframes-at-cuts',
    '-S',
    'res:1080,ext:mp4:m4a',
    '-f',
    'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b',
    '--merge-output-format',
    'mp4',
    '-o',
    targetPath,
    url,
  ];

  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, { shell: false });
    let stderr = '';
    let lineBuf = '';
    let settled = false;
    const STALL_TIMEOUT_MS = 120_000;

    let stallTimer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
        reject(new Error('1080p segment download stalled for 120s.'));
      }
    }, STALL_TIMEOUT_MS);

    const resetStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 2000);
          reject(new Error('1080p segment download stalled for 120s.'));
        }
      }, STALL_TIMEOUT_MS);
    };

    const handleChunk = (text: string) => {
      resetStall();
      lineBuf += text;
      const lines = lineBuf.split(/[\r\n]+/);
      lineBuf = lines.pop() || '';
      for (const line of lines) {
        const m = line.match(/\[download\]\s+(\d+(?:\.\d+)?)%\s+of\s+([^\s]+)(?:\s+at\s+([^\s]+))?/i);
        if (m && onProgress) {
          const pct = Math.min(100, Math.max(0, Number(m[1])));
          onProgress(pct, `${pct.toFixed(0)}% of ${m[2]}`);
        }
      }
    };

    child.stdout.on('data', (chunk) => handleChunk(String(chunk)));
    child.stderr.on('data', (chunk) => {
      const sChunk = String(chunk);
      if (stderr.length < 512 * 1024) stderr += sChunk;
      handleChunk(sChunk);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(stallTimer);
        reject(err);
      }
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(stallTimer);
      if (code === 0 && fs.existsSync(targetPath)) {
        resolve();
      } else {
        if (fs.existsSync(targetPath)) {
          try {
            fs.unlinkSync(targetPath);
          } catch {
            // ignore
          }
        }
        reject(
          formatYtDlpError(
            stderr.trim() || `${path.basename(bin)} exited with code ${code}`,
            platform
          )
        );
      }
    });
  });
}

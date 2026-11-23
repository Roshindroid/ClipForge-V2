import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';
import type { PlatformType } from '../src/types.ts';
import {
  FRAMES_DIR,
  SOURCES_DIR,
  ensureWorkspace,
  resolveSafeChildPath,
  resolveSafeSourcePath,
} from './storage.ts';
import {
  downloadSegmentWithYtDlp,
  ensureYtDlp,
  fetchMetadataWithYtDlp,
  resolveStreamUrlsWithYtDlp,
  type ResolvedStreamUrls,
} from './ytdlp.ts';

const execFileAsync = promisify(execFile);

const ALLOWED_STREAM_HOSTS = [
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'youtu.be',
  'twitch.tv',
  'www.twitch.tv',
  'clips.twitch.tv',
  'kick.com',
  'www.kick.com',
];

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '127.0.0.1' ||
    lower === '::1' ||
    lower === '0.0.0.0' ||
    lower.endsWith('.local') ||
    lower.endsWith('.internal')
  ) {
    return true;
  }

  if (net.isIPv4(lower)) {
    const parts = lower.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
  }

  if (net.isIPv6(lower)) {
    if (lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80')) {
      return true;
    }
  }

  return false;
}

export function detectPlatformFromUrl(rawUrl: string): {
  parsedUrl: URL;
  platform: PlatformType;
  isDirectMediaExt: boolean;
} {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl.trim());
  } catch {
    throw new Error('Invalid URL format. Provide a full https:// link.');
  }

  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  if (isPrivateOrLoopbackHost(parsedUrl.hostname)) {
    throw new Error('Localhost and private network URLs are blocked for security.');
  }

  const host = parsedUrl.hostname.toLowerCase();
  if (host.includes('youtube.com') || host === 'youtu.be') {
    return { parsedUrl, platform: 'youtube', isDirectMediaExt: false };
  }
  if (host.includes('twitch.tv')) {
    return { parsedUrl, platform: 'twitch', isDirectMediaExt: false };
  }
  if (host.includes('kick.com')) {
    return { parsedUrl, platform: 'kick', isDirectMediaExt: false };
  }

  const isDirectMediaExt = /\.(mp4|mov|webm|mkv|m3u8|mpd)(\?.*)?$/i.test(parsedUrl.pathname);
  if (isDirectMediaExt) {
    return { parsedUrl, platform: 'direct', isDirectMediaExt: true };
  }

  const isKnown = ALLOWED_STREAM_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  if (isKnown) {
    return { parsedUrl, platform: 'direct', isDirectMediaExt: false };
  }

  return { parsedUrl, platform: 'direct', isDirectMediaExt: false };
}

function runCommand(cmd: string, args: string[], timeoutMs = 180000): Promise<{ stdout: string; stderr: string }> {
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
        reject(new Error(`${cmd} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
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
        reject(new Error(stderr.trim() || `${cmd} exited with code ${code}`));
      }
    });
  });
}

export async function probeMediaFile(filePathOrUrl: string): Promise<{
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePathOrUrl],
    { timeout: 25000 }
  );
  const info = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
    }>;
  };
  const videoStream = info.streams?.find((s) => s.codec_type === 'video');
  const audioStream = info.streams?.find((s) => s.codec_type === 'audio');
  if (!videoStream) {
    throw new Error('URL or file does not contain a readable video stream.');
  }
  let fps = 30;
  if (videoStream.r_frame_rate && videoStream.r_frame_rate.includes('/')) {
    const [num, den] = videoStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) fps = Math.round((num / den) * 100) / 100;
  }
  return {
    durationSec: Math.max(1, Number(info.format?.duration || 15)),
    width: videoStream.width || 1280,
    height: videoStream.height || 720,
    fps,
    hasAudio: Boolean(audioStream),
  };
}

async function extractDirectThumbnail(mediaUrl: string, durationSec: number): Promise<string | undefined> {
  try {
    ensureWorkspace();
    const frameFile = `inspect_${crypto.randomBytes(5).toString('hex')}.jpg`;
    const outPath = resolveSafeChildPath(FRAMES_DIR, frameFile);
    const targetSec = Math.max(0.5, Math.min(durationSec - 0.5, durationSec * 0.25));
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '4',
        '-ss',
        targetSec.toFixed(2),
        '-i',
        mediaUrl,
        '-vframes',
        '1',
        '-q:v',
        '3',
        '-vf',
        'scale=960:-2',
        outPath,
      ],
      { timeout: 15000 }
    );
    if (fs.existsSync(outPath) && fs.statSync(outPath).size > 512) {
      return `/api/frames/${frameFile}`;
    }
  } catch {
    // Non-fatal if direct stream thumbnail cannot be extracted
  }
  return undefined;
}

export interface InspectUrlResult {
  title: string;
  platform: PlatformType;
  thumbnailUrl?: string;
  streamUrls?: ResolvedStreamUrls;
  preProbed: {
    durationSec: number;
    width: number;
    height: number;
    fps: number;
    hasAudio: boolean;
  };
}

/**
 * Inspects a video/stream link WITHOUT downloading the full video file.
 * Extracts title, duration, resolution, frame rate, and preview thumbnail.
 */
export async function inspectFromUrl(
  rawUrl: string,
  titleOverride?: string
): Promise<InspectUrlResult> {
  ensureWorkspace();
  const { parsedUrl, platform, isDirectMediaExt } = detectPlatformFromUrl(rawUrl);
  const id = crypto.randomBytes(4).toString('hex');

  if (platform === 'direct') {
    let contentType = '';
    try {
      const headCtrl = new AbortController();
      const headTimer = setTimeout(() => headCtrl.abort(), 8000);
      const headRes = await fetch(parsedUrl.toString(), {
        method: 'HEAD',
        signal: headCtrl.signal,
        redirect: 'follow',
      });
      clearTimeout(headTimer);
      contentType = (headRes.headers.get('content-type') || '').toLowerCase();
    } catch {
      // fall through to ffprobe
    }

    if (
      !isDirectMediaExt &&
      contentType &&
      !contentType.startsWith('video/') &&
      !contentType.includes('octet-stream') &&
      !contentType.includes('mpegurl') &&
      !contentType.includes('mp4')
    ) {
      try {
        const meta = await fetchMetadataWithYtDlp(parsedUrl.toString(), 'direct');
        const resolvedTitle = titleOverride?.trim() || meta.title;
        const streamUrls = meta.streamUrls || (await resolveStreamUrlsWithYtDlp(parsedUrl.toString()));
        return {
          title: resolvedTitle.slice(0, 120),
          platform: 'direct',
          thumbnailUrl: meta.thumbnailUrl,
          streamUrls,
          preProbed: {
            durationSec: meta.durationSec,
            width: meta.width,
            height: meta.height,
            fps: meta.fps,
            hasAudio: meta.hasAudio,
          },
        };
      } catch (err) {
        if (err instanceof Error && (err.message.includes('bot verification') || err.message.includes('cookies'))) {
          throw err;
        }
        throw new Error(
          'Unsupported URL host or non-video link. Use YouTube, Twitch, Kick, or a direct .mp4/.webm/.mov/.m3u8 media URL.'
        );
      }
    }

    const probed = await probeMediaFile(parsedUrl.toString()).catch((err) => {
      throw new Error(
        err instanceof Error
          ? `Could not read remote media stream: ${err.message}`
          : 'Could not read remote media stream.'
      );
    });

    const derivedTitle =
      titleOverride?.trim() ||
      path.basename(parsedUrl.pathname, path.extname(parsedUrl.pathname)) ||
      `Direct Stream ${id}`;

    const thumbnailUrl = await extractDirectThumbnail(parsedUrl.toString(), probed.durationSec);

    return {
      title: derivedTitle.slice(0, 120),
      platform: 'direct',
      thumbnailUrl,
      streamUrls: {
        videoUrl: parsedUrl.toString(),
        audioUrl: parsedUrl.toString(),
        isSeparate: false,
        resolvedAt: Date.now(),
      },
      preProbed: probed,
    };
  }

  // Platform link (YouTube / Twitch / Kick)
  await ensureYtDlp();
  const meta = await fetchMetadataWithYtDlp(parsedUrl.toString(), platform);
  const resolvedTitle = titleOverride?.trim() || meta.title;
  const streamUrls = meta.streamUrls || (await resolveStreamUrlsWithYtDlp(parsedUrl.toString()));

  return {
    title: resolvedTitle.slice(0, 120),
    platform,
    thumbnailUrl: meta.thumbnailUrl,
    streamUrls,
    preProbed: {
      durationSec: meta.durationSec,
      width: meta.width,
      height: meta.height,
      fps: meta.fps,
      hasAudio: meta.hasAudio,
    },
  };
}

/**
 * Extracts a single frame from a downloaded segment file at a normalized fraction (0..1)
 * and caches it in workspace/frames/ so Panel 1 can display the real source frame.
 */
export async function extractSegmentFrameAtFraction(params: {
  projectId: string;
  segmentId: string;
  segmentFilePath: string;
  durationSec: number;
  fraction?: number;
}): Promise<string> {
  ensureWorkspace();
  const frac = Math.max(0.05, Math.min(0.95, params.fraction ?? 0.5));
  const fracTag = String(Math.round(frac * 100)).padStart(3, '0');
  const frameFile = `${params.projectId}_${params.segmentId}_${fracTag}.jpg`;
  const outPath = resolveSafeChildPath(FRAMES_DIR, frameFile);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
    return `/api/frames/${frameFile}`;
  }

  const targetSec = Math.max(0.1, Math.min(Math.max(0.2, params.durationSec - 0.2), params.durationSec * frac));

  await execFileAsync(
    'ffmpeg',
    [
      '-y',
      '-ss',
      targetSec.toFixed(2),
      '-i',
      params.segmentFilePath,
      '-vframes',
      '1',
      '-q:v',
      '2',
      outPath,
    ],
    { timeout: 15000 }
  );

  if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) {
    // Fallback to very first frame if seeking near EOF failed
    await execFileAsync(
      'ffmpeg',
      ['-y', '-i', params.segmentFilePath, '-vframes', '1', '-q:v', '2', outPath],
      { timeout: 15000 }
    );
  }

  return `/api/frames/${frameFile}`;
}

/**
 * Downloads ONLY a single timestamp range [startSeconds..endSeconds] into the project's
 * dedicated workspace/sources/<projectId>/ directory, probes its dimensions, and extracts
 * a preview frame for Panel 1. Does NOT perform facecam detection or rendering.
 */
export async function downloadProjectSegmentFile(params: {
  projectId: string;
  segmentId: string;
  order: number;
  sourceUrl: string;
  sourceType: PlatformType;
  startSeconds: number;
  endSeconds: number;
  onProgress?: (pct: number, detail: string) => void;
}): Promise<{
  sourceFileName: string;
  sourceSizeBytes: number;
  frameUrl: string;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}> {
  ensureWorkspace();
  const segNum = String(params.order).padStart(3, '0');
  const relativeFileName = `${params.projectId}/segment_${segNum}_${params.segmentId}.mp4`;
  const targetPath = resolveSafeSourcePath(relativeFileName);
  const parentDir = path.dirname(targetPath);
  if (!fs.existsSync(parentDir)) {
    fs.mkdirSync(parentDir, { recursive: true });
  }

  const duration = Math.max(2, params.endSeconds - params.startSeconds);

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size <= 4096) {
    if (params.sourceType === 'direct') {
      params.onProgress?.(20, 'Extracting direct video segment via FFmpeg...');
      await runCommand(
        'ffmpeg',
        [
          '-y',
          '-reconnect',
          '1',
          '-reconnect_streamed',
          '1',
          '-reconnect_delay_max',
          '4',
          '-ss',
          params.startSeconds.toFixed(2),
          '-t',
          duration.toFixed(2),
          '-i',
          params.sourceUrl,
          '-vf',
          "scale='min(1920,iw)':'min(1080,ih)':force_original_aspect_ratio=decrease",
          '-c:v',
          'libx264',
          '-preset',
          'veryfast',
          '-crf',
          '20',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-b:a',
          '160k',
          '-movflags',
          '+faststart',
          targetPath,
        ],
        240000
      );
    } else {
      await downloadSegmentWithYtDlp(
        params.sourceUrl,
        params.startSeconds,
        params.endSeconds,
        targetPath,
        params.sourceType,
        params.onProgress
      );
    }
  }

  if (!fs.existsSync(targetPath) || fs.statSync(targetPath).size === 0) {
    throw new Error('Segment download did not produce a valid MP4 file.');
  }

  const stat = fs.statSync(targetPath);
  const probed = await probeMediaFile(targetPath).catch(() => ({
    durationSec: duration,
    width: 1920,
    height: 1080,
    fps: 30,
    hasAudio: true,
  }));

  const frameUrl = await extractSegmentFrameAtFraction({
    projectId: params.projectId,
    segmentId: params.segmentId,
    segmentFilePath: targetPath,
    durationSec: probed.durationSec,
    fraction: 0.5,
  });

  return {
    sourceFileName: relativeFileName,
    sourceSizeBytes: stat.size,
    frameUrl,
    width: probed.width,
    height: probed.height,
    fps: probed.fps,
    hasAudio: probed.hasAudio,
  };
}

/**
 * Generates a real 18-second 1280x720 MP4 using FFmpeg with animated gameplay motion
 * and a corner facecam overlay box for local verification and testing.
 */
export async function generateSampleStreamVideo(): Promise<{
  fileName: string;
  title: string;
  platform: PlatformType;
}> {
  ensureWorkspace();
  const id = crypto.randomBytes(4).toString('hex');
  const fileName = `sample_stream_${id}.mp4`;
  const targetPath = resolveSafeChildPath(SOURCES_DIR, fileName);

  const filterComplex = [
    'testsrc2=size=1280x720:rate=30:duration=18[bg]',
    'mandelbrot=size=320x210:rate=30:maxiter=40,trim=duration=18,setpts=PTS-STARTPTS,drawbox=x=0:y=0:w=320:h=210:color=0xE11D48@0.9:t=4[cam]',
    '[bg][cam]overlay=x=W-w-28:y=H-h-28:shortest=1[vout]',
    "sine=frequency=220:sample_rate=44100:duration=18,volume='if(between(t,2.5,5.5),0.85,if(between(t,8.5,11.8),0.95,if(between(t,13.8,16.8),0.88,0.14)))':eval=frame[a1]",
    "anoisesrc=color=pink:amplitude=0.18:sample_rate=44100:duration=18,volume='if(between(t,8.5,11.8),0.9,0.22)':eval=frame[a2]",
    '[a1][a2]amix=inputs=2:duration=first[aout]',
  ].join(';');

  await runCommand('ffmpeg', [
    '-y',
    '-filter_complex',
    filterComplex,
    '-map',
    '[vout]',
    '-map',
    '[aout]',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-movflags',
    '+faststart',
    targetPath,
  ]);

  return {
    fileName,
    title: 'Sample Stream Highlight (16:9 + Facecam)',
    platform: 'local',
  };
}

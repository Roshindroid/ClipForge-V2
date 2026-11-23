import { spawn, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { promisify } from 'node:util';
import type {
  BrandingConfig,
  FacecamBox,
  LayoutId,
  TemplateId,
} from '../src/types.ts';
import { detectNvencSupport } from './capabilities.ts';
import {
  FRAMES_DIR,
  RENDERS_DIR,
  ensureWorkspace,
  resolveSafeChildPath,
} from './storage.ts';

const execFileAsync = promisify(execFile);

function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

export function layoutUsesFacecam(layoutId: LayoutId): boolean {
  return layoutId !== 'center-crop-focus';
}

export function clampFacecamBox(box: FacecamBox): FacecamBox {
  const width = clamp(Number(box.width) || 0.25, 0.05, 1);
  const height = clamp(Number(box.height) || 0.25, 0.05, 1);
  const x = clamp(Number(box.x) || 0, 0, Math.max(0, 1 - width));
  const y = clamp(Number(box.y) || 0, 0, Math.max(0, 1 - height));
  return {
    x: Math.round(x * 10000) / 10000,
    y: Math.round(y * 10000) / 10000,
    width: Math.round(width * 10000) / 10000,
    height: Math.round(height * 10000) / 10000,
    label: box.label ? String(box.label).slice(0, 48) : undefined,
  };
}

function findDrawtextFont(): string {
  const candidates = [
    '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return '';
}

function sanitizeDrawtext(input: string, maxLen = 48): string {
  return input
    .replace(/[\r\n]+/g, ' ')
    .replace(/[^a-zA-Z0-9 _.,!?@#&()+-]/g, '')
    .trim()
    .slice(0, maxLen)
    .replace(/:/g, '\\:');
}

function normalizeHexColor(hex: string): string {
  const cleaned = hex.replace(/[^0-9a-fA-F]/g, '').slice(0, 6);
  return cleaned.length === 6 ? `0x${cleaned}` : '0x0B0D11';
}

export interface RenderV2Options {
  inputFilePath: string;
  outputFileName: string;
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox | null;
  branding: BrandingConfig;
  hookTagline?: string;
  resolution: '1080x1920' | '720x1280';
  frameRate: 'original' | '60' | '30';
  onProgress?: (pct: number, stage: string, detail?: string) => void;
}

/**
 * Builds the FFmpeg filter graph for any of the 11 layouts at the requested resolution.
 * Never falls back to an assumed facecam box when a facecam-dependent layout is selected.
 */
export function buildLayoutFilterGraph(
  layoutId: LayoutId,
  srcWidth: number,
  srcHeight: number,
  cam: FacecamBox | null,
  outWidth: number,
  outHeight: number,
  bgHex: string
): { filterSteps: string[]; finalVideoLabel: string } {
  const bgColor = normalizeHexColor(bgHex);
  const steps: string[] = [];

  // Layout 10: Center Crop (No facecam required)
  if (layoutId === 'center-crop-focus') {
    steps.push(
      `[0:v]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight},setsar=1[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  if (!cam) {
    throw new Error(
      `Layout "${layoutId}" requires a manually positioned facecam region. Draw and save the facecam box first, or select Center Crop.`
    );
  }

  const safeCam = clampFacecamBox(cam);
  const camX = Math.min(even(srcWidth - 16), even(safeCam.x * srcWidth));
  const camY = Math.min(even(srcHeight - 16), even(safeCam.y * srcHeight));
  const camW = Math.min(even(srcWidth - camX), Math.max(16, even(safeCam.width * srcWidth)));
  const camH = Math.min(even(srcHeight - camY), Math.max(16, even(safeCam.height * srcHeight)));

  // Layout 11: Facecam Full Zoom
  if (layoutId === 'facecam-only-zoom') {
    steps.push(
      `[0:v]crop=${camW}:${camH}:${camX}:${camY},scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight},setsar=1[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  // Layout 1, 2, 3: Vertical Splits (Top Split 35/65, Bottom Split 65/35, 50/50 Split)
  if (
    layoutId === 'split-top-cam' ||
    layoutId === 'split-bottom-cam' ||
    layoutId === 'split-50-50'
  ) {
    const camBandH =
      layoutId === 'split-50-50' ? even(outHeight * 0.5) : even(outHeight * 0.35);
    const mainBandH = outHeight - camBandH;

    steps.push(
      `[0:v]split=2[src_main][src_cam]`,
      `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${outWidth}:${camBandH}:force_original_aspect_ratio=increase,crop=${outWidth}:${camBandH},setsar=1[cam_pane]`,
      `[src_main]scale=${outWidth}:${mainBandH}:force_original_aspect_ratio=increase,crop=${outWidth}:${mainBandH},setsar=1[main_pane]`
    );

    if (layoutId === 'split-bottom-cam') {
      steps.push(`[main_pane][cam_pane]vstack=inputs=2[vbase]`);
    } else {
      steps.push(`[cam_pane][main_pane]vstack=inputs=2[vbase]`);
    }
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  // Layout 4, 5, 6, 7: Picture-in-Picture (Top-Left, Top-Right, Bottom-Left, Bottom-Right)
  if (
    layoutId === 'pip-top-left' ||
    layoutId === 'pip-top-right' ||
    layoutId === 'pip-bottom-left' ||
    layoutId === 'pip-bottom-right'
  ) {
    const scaleFactor = outWidth / 720;
    const pipW = even(224 * scaleFactor);
    const pipH = even(224 * scaleFactor);
    const margin = even(28 * scaleFactor);
    const topMargin = even(140 * scaleFactor);
    const botMargin = even(180 * scaleFactor);

    let overlayExpr = `${margin}:${topMargin}`;
    if (layoutId === 'pip-top-right') overlayExpr = `W-w-${margin}:${topMargin}`;
    if (layoutId === 'pip-bottom-left') overlayExpr = `${margin}:H-h-${botMargin}`;
    if (layoutId === 'pip-bottom-right') overlayExpr = `W-w-${margin}:H-h-${botMargin}`;

    steps.push(
      `[0:v]split=2[src_main][src_cam]`,
      `[src_main]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight},setsar=1[main_full]`,
      `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${pipW}:${pipH}:force_original_aspect_ratio=increase,crop=${pipW}:${pipH},drawbox=x=0:y=0:w=${pipW}:h=${pipH}:color=white@0.85:t=3,setsar=1[pip_pane]`,
      `[main_full][pip_pane]overlay=${overlayExpr}[vbase]`
    );
    return { filterSteps: steps, finalVideoLabel: 'vbase' };
  }

  // Layout 8 & 9: Blurred Background + Floating Cam Card Top or Bottom
  const scaleFactor = outWidth / 720;
  const rawFitH = even((outWidth * srcHeight) / Math.max(1, srcWidth));
  const mainFitH = Math.min(outHeight - even(40 * scaleFactor), rawFitH);
  const mainFitW =
    rawFitH > mainFitH ? even((mainFitH * srcWidth) / Math.max(1, srcHeight)) : outWidth;
  const mainX = even((outWidth - mainFitW) / 2);
  const mainY = even((outHeight - mainFitH) / 2);

  const camWOut = even(280 * scaleFactor);
  const camHOut = even(230 * scaleFactor);
  const camYOut =
    layoutId === 'blurred-bg-cam-top'
      ? even(110 * scaleFactor)
      : outHeight - camHOut - even(130 * scaleFactor);
  const camXOut = even((outWidth - camWOut) / 2);

  steps.push(
    `[0:v]split=3[src_bg][src_main][src_cam]`,
    `[src_bg]scale=${outWidth}:${outHeight}:force_original_aspect_ratio=increase,crop=${outWidth}:${outHeight},boxblur=24:4,drawbox=x=0:y=0:w=${outWidth}:h=${outHeight}:color=${bgColor}@0.35:t=fill,setsar=1[bg_blur]`,
    `[src_main]scale=${mainFitW}:${mainFitH},setsar=1[main_fit]`,
    `[src_cam]crop=${camW}:${camH}:${camX}:${camY},scale=${camWOut}:${camHOut}:force_original_aspect_ratio=increase,crop=${camWOut}:${camHOut},drawbox=x=0:y=0:w=${camWOut}:h=${camHOut}:color=white@0.75:t=3,setsar=1[cam_card]`,
    `[bg_blur][main_fit]overlay=${mainX}:${mainY}[tmp_bg_main]`,
    `[tmp_bg_main][cam_card]overlay=${camXOut}:${camYOut}[vbase]`
  );
  return { filterSteps: steps, finalVideoLabel: 'vbase' };
}

export function buildTemplateAndBrandingFilters(
  inLabel: string,
  templateId: TemplateId,
  hookTagline: string,
  branding: BrandingConfig,
  outWidth: number,
  outHeight: number
): { filterSteps: string[]; finalVideoLabel: string } {
  const fontFile = findDrawtextFont();
  const fontOpt = fontFile ? `fontfile=${fontFile}:` : '';
  const steps: string[] = [];
  let current = inLabel;
  const sf = outWidth / 720;

  if (templateId === 'x-post' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'Clip highlight', 44);
    const handle = sanitizeDrawtext(branding.creditText || '@creator', 26);
    const boxW = outWidth - even(72 * sf);
    const boxH = even(112 * sf);
    steps.push(
      `[${current}]drawbox=x=${even(36 * sf)}:y=${even(36 * sf)}:w=${boxW}:h=${boxH}:color=0x0F1117@0.92:t=fill,drawbox=x=${even(36 * sf)}:y=${even(36 * sf)}:w=${boxW}:h=${boxH}:color=0x2A303E@1:t=2,drawtext=${fontOpt}text='${handle}':fontcolor=0x9CA3AF:fontsize=${Math.round(20 * sf)}:x=${even(60 * sf)}:y=${even(56 * sf)},drawtext=${fontOpt}text='${headline}':fontcolor=white:fontsize=${Math.round(24 * sf)}:x=${even(60 * sf)}:y=${even(92 * sf)}[vtmpl]`
    );
    current = 'vtmpl';
  } else if (templateId === 'tiktok-hook' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'Watch till the end', 40);
    const boxW = outWidth - even(96 * sf);
    const boxH = even(74 * sf);
    steps.push(
      `[${current}]drawbox=x=${even(48 * sf)}:y=${even(54 * sf)}:w=${boxW}:h=${boxH}:color=white@0.96:t=fill,drawtext=${fontOpt}text='${headline}':fontcolor=0x0B0D11:fontsize=${Math.round(26 * sf)}:x=(w-text_w)/2:y=${even(78 * sf)}[vtmpl]`
    );
    current = 'vtmpl';
  } else if (templateId === 'breaking-news' && fontFile) {
    const headline = sanitizeDrawtext(hookTagline || 'BREAKING CLIP', 40);
    const yTop = outHeight - even(165 * sf);
    const yBot = outHeight - even(121 * sf);
    steps.push(
      `[${current}]drawbox=x=0:y=${yTop}:w=${outWidth}:h=${even(44 * sf)}:color=0xE11D48@0.96:t=fill,drawbox=x=0:y=${yBot}:w=${outWidth}:h=${even(72 * sf)}:color=0x0B0D11@0.94:t=fill,drawtext=${fontOpt}text='LIVE CLIP':fontcolor=white:fontsize=${Math.round(22 * sf)}:x=${even(28 * sf)}:y=${outHeight - even(154 * sf)},drawtext=${fontOpt}text='${headline}':fontcolor=white:fontsize=${Math.round(26 * sf)}:x=${even(28 * sf)}:y=${outHeight - even(98 * sf)}[vtmpl]`
    );
    current = 'vtmpl';
  }

  const credit = sanitizeDrawtext(branding.watermarkText || branding.creditText || '', 32);
  if (credit && fontFile) {
    steps.push(
      `[${current}]drawtext=${fontOpt}text='${credit}':fontcolor=white@0.72:fontsize=${Math.round(20 * sf)}:x=w-text_w-${even(26 * sf)}:y=h-${even(46 * sf)}[vbrand]`
    );
    current = 'vbrand';
  }

  return { filterSteps: steps, finalVideoLabel: current };
}

export async function probeMedia(filePath: string): Promise<{
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  hasAudio: boolean;
}> {
  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filePath],
    { timeout: 12000 }
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      r_frame_rate?: string;
      duration?: string;
    }>;
  };
  const vStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const aStream = parsed.streams?.find((s) => s.codec_type === 'audio');
  if (!vStream) {
    throw new Error('Media file has no readable video stream.');
  }
  const width = Number(vStream.width || 1920);
  const height = Number(vStream.height || 1080);
  let fps = 30;
  if (typeof vStream.r_frame_rate === 'string' && vStream.r_frame_rate.includes('/')) {
    const [num, den] = vStream.r_frame_rate.split('/').map(Number);
    if (den > 0 && num > 0) fps = Math.round((num / den) * 10) / 10;
  }
  const durationSec = Number(vStream.duration || parsed.format?.duration || 10);
  return { width, height, fps, durationSec, hasAudio: Boolean(aStream) };
}

export async function verifyRenderedOutput(
  outPath: string,
  expectedWidth: number,
  expectedHeight: number,
  expectAudio: boolean
): Promise<{ durationSec: number; width: number; height: number; fileSizeBytes: number }> {
  if (!fs.existsSync(outPath)) {
    throw new Error('Rendered output file does not exist.');
  }
  const fileSizeBytes = fs.statSync(outPath).size;
  if (fileSizeBytes < 4096) {
    throw new Error(`Rendered output file is too small (${fileSizeBytes} bytes).`);
  }

  const { stdout } = await execFileAsync(
    'ffprobe',
    ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outPath],
    { timeout: 10000 }
  );
  const parsed = JSON.parse(stdout) as {
    format?: { duration?: string };
    streams?: Array<{
      codec_type?: string;
      codec_name?: string;
      width?: number;
      height?: number;
      duration?: string;
    }>;
  };

  const vStream = parsed.streams?.find((s) => s.codec_type === 'video');
  const aStream = parsed.streams?.find((s) => s.codec_type === 'audio');

  if (!vStream || vStream.codec_name !== 'h264') {
    throw new Error(`Output video stream invalid or not H.264 (got ${vStream?.codec_name || 'none'}).`);
  }
  if (vStream.width !== expectedWidth || vStream.height !== expectedHeight) {
    throw new Error(
      `Output dimensions mismatch: expected ${expectedWidth}x${expectedHeight}, got ${vStream.width}x${vStream.height}.`
    );
  }
  const durationSec = Number(vStream.duration || parsed.format?.duration || 0);
  if (!Number.isFinite(durationSec) || durationSec < 0.5) {
    throw new Error(`Output duration invalid (${durationSec}s).`);
  }
  if (expectAudio && !aStream) {
    throw new Error('Expected audio stream in rendered MP4, but none was found.');
  }

  return {
    durationSec: Math.round(durationSec * 10) / 10,
    width: vStream.width,
    height: vStream.height,
    fileSizeBytes,
  };
}

function runFfmpegRender(
  args: string[],
  durationSec: number,
  onProgress?: (pct: number, stage: string, detail?: string) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false });
    let stderr = '';
    let settled = false;
    const timeoutMs = Math.max(120_000, (durationSec + 30) * 6000);

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGTERM');
        setTimeout(() => child.kill('SIGKILL'), 2000);
        reject(new Error(`Rendering timed out after ${Math.round(timeoutMs / 1000)}s`));
      }
    }, timeoutMs);

    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 512 * 1024) stderr = stderr.slice(-256 * 1024);
      const timeMatch = stderr.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch && durationSec > 0) {
        const h = Number(timeMatch[1]);
        const m = Number(timeMatch[2]);
        const s = Number(timeMatch[3]);
        const currentSec = h * 3600 + m * 60 + s;
        const pct = Math.min(
          96,
          Math.max(25, 25 + Math.round((currentSec / durationSec) * 70))
        );
        onProgress?.(
          pct,
          'Rendering 9:16 vertical video...',
          `${currentSec.toFixed(1)}s / ${durationSec.toFixed(1)}s`
        );
      }
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
        resolve();
      } else {
        reject(new Error(`FFmpeg rendering failed (code ${code}): ${stderr.slice(-300)}`));
      }
    });
  });
}

/**
 * Renders a complete 9:16 vertical Short for a downloaded segment using exact FFmpeg math.
 */
export async function renderSegmentClipV2(options: RenderV2Options): Promise<{
  outputPath: string;
  outputFileName: string;
  downloadUrl: string;
  fileSizeBytes: number;
  durationSec: number;
  resolution: string;
  encoderUsed: 'h264_nvenc' | 'libx264';
}> {
  ensureWorkspace();

  if (layoutUsesFacecam(options.layoutId) && !options.facecamBox) {
    throw new Error(
      `Layout "${options.layoutId}" requires a manually positioned facecam region. Draw and save the facecam box first.`
    );
  }

  const outWidth = options.resolution === '1080x1920' ? 1080 : 720;
  const outHeight = options.resolution === '1080x1920' ? 1920 : 1280;

  const probe = await probeMedia(options.inputFilePath);
  const outPath = resolveSafeChildPath(RENDERS_DIR, options.outputFileName);

  options.onProgress?.(10, 'Building 9:16 layout filter graph...', options.layoutId);

  const layoutGraph = buildLayoutFilterGraph(
    options.layoutId,
    probe.width,
    probe.height,
    options.facecamBox,
    outWidth,
    outHeight,
    options.branding.backgroundHex
  );

  const overlayGraph = buildTemplateAndBrandingFilters(
    layoutGraph.finalVideoLabel,
    options.templateId,
    options.hookTagline || '',
    options.branding,
    outWidth,
    outHeight
  );

  const allFilters = [...layoutGraph.filterSteps, ...overlayGraph.filterSteps];
  const finalVideoLabel = overlayGraph.finalVideoLabel;

  const buildArgs = (encoder: 'h264_nvenc' | 'libx264'): string[] => {
    const args: string[] = ['-y', '-i', options.inputFilePath];
    if (options.frameRate === '60') {
      args.push('-r', '60');
    } else if (options.frameRate === '30') {
      args.push('-r', '30');
    }
    args.push('-filter_complex', allFilters.join(';'));
    args.push('-map', `[${finalVideoLabel}]`);
    if (probe.hasAudio) {
      args.push('-map', '0:a:0?');
    }
    args.push('-c:v', encoder);
    if (encoder === 'libx264') {
      args.push('-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p');
    } else {
      args.push('-preset', 'p4', '-cq', '22', '-pix_fmt', 'yuv420p');
    }
    if (probe.hasAudio) {
      args.push('-af', 'aresample=async=1:first_pts=0', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000');
    }
    args.push('-movflags', '+faststart');
    args.push(outPath);
    return args;
  };

  const tryNvenc = await detectNvencSupport();
  let encoderUsed: 'h264_nvenc' | 'libx264' = tryNvenc ? 'h264_nvenc' : 'libx264';

  options.onProgress?.(25, `Rendering 9:16 vertical video (${encoderUsed})...`);

  try {
    await runFfmpegRender(buildArgs(encoderUsed), probe.durationSec, options.onProgress);
  } catch (err) {
    if (encoderUsed === 'h264_nvenc') {
      encoderUsed = 'libx264';
      options.onProgress?.(25, 'Falling back to libx264 encoder...');
      await runFfmpegRender(buildArgs('libx264'), probe.durationSec, options.onProgress);
    } else {
      throw err;
    }
  }

  options.onProgress?.(98, 'Verifying rendered MP4 output...');
  const verified = await verifyRenderedOutput(outPath, outWidth, outHeight, probe.hasAudio);
  options.onProgress?.(100, 'Render complete!');

  return {
    outputPath: outPath,
    outputFileName: options.outputFileName,
    downloadUrl: `/api/renders/${options.outputFileName}`,
    fileSizeBytes: verified.fileSizeBytes,
    durationSec: verified.durationSec,
    resolution: `${verified.width}x${verified.height}`,
    encoderUsed,
  };
}

/**
 * Renders an exact 9:16 single-frame JPEG composite using the exact same FFmpeg filter graph
 * as the full MP4 renderer so Panel 2 shows true crop/scale/framing geometry without distortion.
 */
export async function renderLayoutPreviewFrame(params: {
  inputImagePath: string;
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox | null;
  branding: BrandingConfig;
  hookTagline?: string;
  outWidth?: number;
  outHeight?: number;
}): Promise<Buffer> {
  ensureWorkspace();
  const outWidth = params.outWidth || 540;
  const outHeight = params.outHeight || 960;

  const probe = await probeMedia(params.inputImagePath);

  const layoutGraph = buildLayoutFilterGraph(
    params.layoutId,
    probe.width,
    probe.height,
    params.facecamBox,
    outWidth,
    outHeight,
    params.branding.backgroundHex
  );

  const overlayGraph = buildTemplateAndBrandingFilters(
    layoutGraph.finalVideoLabel,
    params.templateId,
    params.hookTagline || '',
    params.branding,
    outWidth,
    outHeight
  );

  const allFilters = [...layoutGraph.filterSteps, ...overlayGraph.filterSteps];
  const tempOut = resolveSafeChildPath(
    FRAMES_DIR,
    `tmp_preview_${crypto.randomBytes(5).toString('hex')}.jpg`
  );

  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-y',
        '-i',
        params.inputImagePath,
        '-filter_complex',
        allFilters.join(';'),
        '-map',
        `[${overlayGraph.finalVideoLabel}]`,
        '-vframes',
        '1',
        '-q:v',
        '3',
        tempOut,
      ],
      { timeout: 10000 }
    );
    return fs.readFileSync(tempOut);
  } finally {
    if (fs.existsSync(tempOut)) {
      try {
        fs.unlinkSync(tempOut);
      } catch {
        // ignore cleanup
      }
    }
  }
}

/**
 * Generates a lightweight 540x960 preview MP4 cached in workspace/frames/ for instant Panel 2 video playback.
 */
export async function renderPreviewVideo(params: {
  projectId: string;
  segmentId: string;
  inputFilePath: string;
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox | null;
  branding: BrandingConfig;
  hookTagline?: string;
}): Promise<string> {
  ensureWorkspace();
  const outWidth = 540;
  const outHeight = 960;
  const probe = await probeMedia(params.inputFilePath);

  const hash = crypto
    .createHash('sha1')
    .update(
      JSON.stringify({
        s: params.segmentId,
        l: params.layoutId,
        t: params.templateId,
        f: params.facecamBox,
        b: params.branding,
        h: params.hookTagline || '',
      })
    )
    .digest('hex')
    .slice(0, 12);

  const fileName = `preview_${params.projectId}_${params.segmentId}_${hash}.mp4`;
  const outPath = resolveSafeChildPath(FRAMES_DIR, fileName);

  if (fs.existsSync(outPath) && fs.statSync(outPath).size > 4096) {
    return `/api/frames/${fileName}`;
  }

  const layoutGraph = buildLayoutFilterGraph(
    params.layoutId,
    probe.width,
    probe.height,
    params.facecamBox,
    outWidth,
    outHeight,
    params.branding.backgroundHex
  );

  const overlayGraph = buildTemplateAndBrandingFilters(
    layoutGraph.finalVideoLabel,
    params.templateId,
    params.hookTagline || '',
    params.branding,
    outWidth,
    outHeight
  );

  const allFilters = [...layoutGraph.filterSteps, ...overlayGraph.filterSteps];
  const args: string[] = [
    '-y',
    '-i',
    params.inputFilePath,
    '-t',
    '15',
    '-filter_complex',
    allFilters.join(';'),
    '-map',
    `[${overlayGraph.finalVideoLabel}]`,
  ];
  if (probe.hasAudio) {
    args.push('-map', '0:a:0?', '-c:a', 'aac', '-b:a', '128k');
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '26',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    outPath
  );

  await runFfmpegRender(args, Math.min(15, probe.durationSec));
  return `/api/frames/${fileName}`;
}

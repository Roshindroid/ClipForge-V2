import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { GoogleGenAI } from '@google/genai';
import type { FacecamBox, LayoutId } from '../src/types.ts';
import { FRAMES_DIR, ensureWorkspace } from './storage.ts';

const execFileAsync = promisify(execFile);

export interface FacecamDetectionResult {
  hasFacecam: boolean;
  status: 'detected' | 'not_found' | 'uncertain';
  confidence: number;
  positionLabel: string;
  boundingBox: FacecamBox | null;
  effectiveLayout: LayoutId;
  method: 'gemini-vision' | 'python-opencv' | 'ffmpeg-cv-heuristics';
}

const CANDIDATE_PRESETS: Array<{
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
}> = [
  { label: 'Bottom-Right', x: 0.71, y: 0.63, width: 0.26, height: 0.33 },
  { label: 'Bottom-Left', x: 0.03, y: 0.63, width: 0.26, height: 0.33 },
  { label: 'Top-Right', x: 0.71, y: 0.05, width: 0.26, height: 0.33 },
  { label: 'Top-Left', x: 0.03, y: 0.05, width: 0.26, height: 0.33 },
  { label: 'Middle-Left', x: 0.02, y: 0.28, width: 0.25, height: 0.36 },
  { label: 'Middle-Right', x: 0.73, y: 0.28, width: 0.25, height: 0.36 },
];

/**
 * Extracts multiple sampled frames from a segment for visual inspection.
 */
async function extractSampledJpegs(
  videoPath: string,
  durationSec: number,
  count = 3
): Promise<string[]> {
  ensureWorkspace();
  const sampleFractions = count === 2 ? [0.3, 0.7] : [0.2, 0.5, 0.8];
  const framePaths: string[] = [];

  for (let i = 0; i < sampleFractions.length; i++) {
    const frac = sampleFractions[i];
    const targetSec = Math.max(0.5, Math.min(durationSec - 0.5, durationSec * frac));
    const outName = `probe_${crypto.randomBytes(4).toString('hex')}_${i}.jpg`;
    const outPath = path.join(FRAMES_DIR, outName);

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          targetSec.toFixed(2),
          '-i',
          videoPath,
          '-vframes',
          '1',
          '-q:v',
          '3',
          '-vf',
          'scale=960:-1',
          outPath,
        ],
        { timeout: 15000 }
      );
      if (fs.existsSync(outPath) && fs.statSync(outPath).size > 1024) {
        framePaths.push(outPath);
      }
    } catch {
      // Continue to next sample if one fails
    }
  }

  return framePaths;
}

/**
 * Resolves the effective layout based on preferred layout and facecam presence.
 * CRITICAL RULE: If no facecam is detected, automatically fallback to 'center-crop-focus' (Gameplay Only).
 */
export function resolveEffectiveLayout(
  preferredLayout: LayoutId,
  facecamDetected: boolean
): LayoutId {
  // If the preferred layout doesn't use facecam, keep it
  if (preferredLayout === 'center-crop-focus') {
    return 'center-crop-focus';
  }

  // If facecam is detected, use the preferred layout
  if (facecamDetected) {
    return preferredLayout;
  }

  // MANDATORY FALLBACK: Gameplay Only!
  return 'center-crop-focus';
}

/**
 * Analyzes video with local Python OpenCV script if installed.
 */
async function tryPythonOpenCv(
  videoPath: string,
  durationSec: number
): Promise<{
  hasFacecam: boolean;
  status: 'detected' | 'not_found' | 'uncertain';
  confidence: number;
  positionLabel: string;
  boundingBox: FacecamBox | null;
} | null> {
  const scriptPath = path.resolve(process.cwd(), 'server/cv/detect_facecam.py');
  if (!fs.existsSync(scriptPath)) return null;

  try {
    const { stdout } = await execFileAsync(
      'python3',
      [scriptPath, videoPath, String(durationSec)],
      { timeout: 14000 }
    );
    const parsed = JSON.parse(stdout.trim());
    if (parsed.error && parsed.error.includes('No module named')) {
      return null; // OpenCV not installed in Python environment
    }
    if (typeof parsed.hasFacecam === 'boolean') {
      const box: FacecamBox | null = parsed.boundingBox
        ? {
            x: Number(parsed.boundingBox.x || 0.72),
            y: Number(parsed.boundingBox.y || 0.65),
            width: Number(parsed.boundingBox.width || 0.25),
            height: Number(parsed.boundingBox.height || 0.3),
            confidence: Number(parsed.confidence || 0.8),
            presetLabel: String(parsed.positionLabel || 'Webcam Overlay'),
          }
        : null;

      return {
        hasFacecam: Boolean(parsed.hasFacecam),
        status: parsed.status || (parsed.hasFacecam ? 'detected' : 'not_found'),
        confidence: Number(parsed.confidence || 0),
        positionLabel: String(parsed.positionLabel || 'None'),
        boundingBox: box,
      };
    }
  } catch {
    // Ignore and proceed to next detector
  }

  return null;
}

/**
 * High-accuracy Multimodal Vision detector using Gemini Flash.
 * Distinguishes true streamer facecam overlays from in-game characters / HUD elements.
 */
async function tryGeminiVisionDetection(
  framePaths: string[]
): Promise<{
  hasFacecam: boolean;
  status: 'detected' | 'not_found' | 'uncertain';
  confidence: number;
  positionLabel: string;
  boundingBox: FacecamBox | null;
} | null> {
  const geminiKey = process.env.GEMINI_API_KEY?.trim();
  if (!geminiKey || framePaths.length === 0) return null;

  try {
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    const imageParts = framePaths.map((fp) => {
      const buf = fs.readFileSync(fp);
      return {
        inlineData: {
          mimeType: 'image/jpeg',
          data: buf.toString('base64'),
        },
      };
    });

    const promptText = `You are an expert video editor AI detecting streamer facecam overlays for vertical video formatting.
Inspect the attached frame(s) from a gameplay/stream video clip.

CRITICAL INSTRUCTION:
Determine if there is a DEDICATED STREAMER WEBCAM OVERLAY / FACECAM WINDOW on screen.
A streamer webcam overlay is a separate inset window or picture-in-picture box showing the real human creator/streamer (usually sitting in a chair, talking into a microphone, with a room background or greenscreen background), typically located in one of the screen corners or sides (bottom-right, bottom-left, top-right, top-left, middle-left, middle-right).

DO NOT CLASSIFY AS FACECAM:
- In-game video game characters, avatars, or NPCs in the gameplay
- RPG character dialogue portraits or cutscenes
- Game HUDs, inventory boxes, health bars, or mini-maps
- Fullscreen video of people without gameplay
- If there is NO dedicated streamer webcam box, return "hasFacecam": false and "status": "not_found"

Output strictly valid JSON matching this schema:
{
  "hasFacecam": boolean,
  "status": "detected" | "not_found" | "uncertain",
  "confidence": number between 0.0 and 1.0,
  "positionLabel": "Bottom-Right" | "Bottom-Left" | "Top-Right" | "Top-Left" | "Middle-Left" | "Middle-Right" | "None",
  "boundingBox": {
    "x": number (normalized 0.0 to 1.0 from left),
    "y": number (normalized 0.0 to 1.0 from top),
    "width": number (normalized width between 0.12 and 0.40),
    "height": number (normalized height between 0.15 and 0.45)
  } | null
}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [...imageParts, promptText],
      config: { responseMimeType: 'application/json' },
    });

    const text = response.text || '';
    const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    const data = JSON.parse(cleaned);

    const hasFacecam = Boolean(data.hasFacecam && data.confidence >= 0.65 && data.boundingBox);
    const confidence = Number(data.confidence || 0);
    const status: 'detected' | 'not_found' | 'uncertain' = hasFacecam
      ? 'detected'
      : confidence >= 0.50
        ? 'uncertain'
        : 'not_found';

    let boundingBox: FacecamBox | null = null;
    if (hasFacecam && data.boundingBox) {
      const b = data.boundingBox;
      const x = Math.max(0, Math.min(0.85, Number(b.x || 0.72)));
      const y = Math.max(0, Math.min(0.85, Number(b.y || 0.65)));
      const width = Math.max(0.12, Math.min(0.40, Number(b.width || 0.25)));
      const height = Math.max(0.12, Math.min(0.45, Number(b.height || 0.30)));
      boundingBox = {
        x,
        y,
        width,
        height,
        confidence: Math.round(confidence * 100) / 100,
        presetLabel: String(data.positionLabel || 'Streamer Facecam'),
      };
    }

    return {
      hasFacecam,
      status,
      confidence: Math.round(confidence * 100) / 100,
      positionLabel: String(data.positionLabel || (hasFacecam ? 'Detected Overlay' : 'None')),
      boundingBox,
    };
  } catch (err) {
    console.warn('[FacecamDetector] Gemini vision detection error, falling back:', err);
    return null;
  }
}

/**
 * FFmpeg Computer Vision Heuristics:
 * Probes candidate overlay zones for inter-frame motion, saturation, and stability.
 */
async function runFfmpegCvHeuristics(
  videoPath: string,
  durationSec: number
): Promise<{
  hasFacecam: boolean;
  status: 'detected' | 'not_found' | 'uncertain';
  confidence: number;
  positionLabel: string;
  boundingBox: FacecamBox | null;
}> {
  let probeWidth = 1920;
  let probeHeight = 1080;

  try {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'json',
        videoPath,
      ],
      { timeout: 8000 }
    );
    const p = JSON.parse(stdout);
    if (p.streams?.[0]?.width) probeWidth = Number(p.streams[0].width);
    if (p.streams?.[0]?.height) probeHeight = Number(p.streams[0].height);
  } catch {
    // Keep 1920x1080 baseline
  }

  const probeTimes = [
    Math.max(0.5, durationSec * 0.25),
    Math.max(1.0, durationSec * 0.65),
  ];

  let bestZone: (typeof CANDIDATE_PRESETS)[0] | null = null;
  let bestScore = 0.0;

  for (const preset of CANDIDATE_PRESETS) {
    const cx = Math.max(0, Math.floor(preset.x * probeWidth));
    const cy = Math.max(0, Math.floor(preset.y * probeHeight));
    const cw = Math.max(32, Math.floor(preset.width * probeWidth));
    const ch = Math.max(32, Math.floor(preset.height * probeHeight));

    let satSum = 0;
    let ydifSum = 0;
    let sampleSuccess = 0;

    for (const t of probeTimes) {
      try {
        const { stderr } = await execFileAsync(
          'ffmpeg',
          [
            '-y',
            '-ss',
            t.toFixed(2),
            '-i',
            videoPath,
            '-vframes',
            '4',
            '-vf',
            `crop=${cw}:${ch}:${cx}:${cy},signalstats,metadata=print`,
            '-f',
            'null',
            '-',
          ],
          { timeout: 12000 }
        );

        const satMatches = [...stderr.matchAll(/SATAVG=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
        const ydifMatches = [...stderr.matchAll(/YDIF=(\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));

        if (satMatches.length > 0) {
          satSum += satMatches.reduce((a, b) => a + b, 0) / satMatches.length;
        }
        if (ydifMatches.length > 0) {
          ydifSum += ydifMatches.reduce((a, b) => a + b, 0) / ydifMatches.length;
        }
        sampleSuccess++;
      } catch {
        // Skip failed sample
      }
    }

    if (sampleSuccess > 0) {
      const avgSat = satSum / sampleSuccess;
      const avgYdif = ydifSum / sampleSuccess;

      // Streamer facecam characteristics:
      // - Moderate to high human skin tone saturation (avgSat between 16 and 75)
      // - Moderate human motion (talking, head gestures, avgYdif between 1.8 and 28)
      // - Static UI has avgYdif < 1.0 (rejected)
      // - Full gameplay chaos has avgYdif > 45 and wildly shifting saturation (penalized)
      let score = 0.0;
      if (avgSat >= 14 && avgSat <= 80 && avgYdif >= 1.5 && avgYdif <= 32) {
        const satScore = Math.min(1, avgSat / 50);
        const motionScore = Math.min(1, avgYdif / 15);
        score = 0.45 + satScore * 0.25 + motionScore * 0.25;
      } else if (avgSat >= 10 && avgYdif >= 1.0) {
        score = 0.40;
      }

      if (score > bestScore) {
        bestScore = score;
        bestZone = preset;
      }
    }
  }

  // Thresholds: >= 0.70 = detected, 0.50..0.69 = uncertain, < 0.50 = not_found
  if (bestZone && bestScore >= 0.70) {
    return {
      hasFacecam: true,
      status: 'detected',
      confidence: Math.round(bestScore * 100) / 100,
      positionLabel: bestZone.label,
      boundingBox: {
        x: bestZone.x,
        y: bestZone.y,
        width: bestZone.width,
        height: bestZone.height,
        confidence: Math.round(bestScore * 100) / 100,
        presetLabel: `${bestZone.label} Cam`,
      },
    };
  }

  if (bestZone && bestScore >= 0.50) {
    return {
      hasFacecam: false,
      status: 'uncertain',
      confidence: Math.round(bestScore * 100) / 100,
      positionLabel: bestZone.label,
      boundingBox: null,
    };
  }

  return {
    hasFacecam: false,
    status: 'not_found',
    confidence: Math.round(bestScore * 100) / 100,
    positionLabel: 'None',
    boundingBox: null,
  };
}

/**
 * Main entrance: Analyzes a downloaded video segment and determines whether a facecam is present,
 * its bounding box coordinates, and resolves the effective layout.
 */
export async function detectSegmentFacecam(
  videoPath: string,
  durationSec: number,
  preferredLayout: LayoutId
): Promise<FacecamDetectionResult> {
  // If the user's preferred layout does NOT use facecam (e.g. center-crop-focus / Gameplay Only),
  // we do not need to force facecam detection or alter their choice.
  if (preferredLayout === 'center-crop-focus') {
    return {
      hasFacecam: false,
      status: 'not_found',
      confidence: 1.0,
      positionLabel: 'Gameplay Only',
      boundingBox: null,
      effectiveLayout: 'center-crop-focus',
      method: 'ffmpeg-cv-heuristics',
    };
  }

  // 1. Try local Python OpenCV script if installed in local machine
  const pyResult = await tryPythonOpenCv(videoPath, durationSec);
  if (pyResult) {
    const effectiveLayout = resolveEffectiveLayout(preferredLayout, pyResult.hasFacecam);
    return {
      hasFacecam: pyResult.hasFacecam,
      status: pyResult.status,
      confidence: pyResult.confidence,
      positionLabel: pyResult.positionLabel,
      boundingBox: pyResult.boundingBox,
      effectiveLayout,
      method: 'python-opencv',
    };
  }

  // 2. Extract sampled frames
  const sampleFrames = await extractSampledJpegs(videoPath, durationSec, 3);

  // 3. Try high-accuracy Gemini Vision check if GEMINI_API_KEY is available
  try {
    const geminiResult = await tryGeminiVisionDetection(sampleFrames);
    if (geminiResult) {
      // Clean up sampled probe frames
      for (const fp of sampleFrames) {
        try { fs.unlinkSync(fp); } catch {}
      }
      const effectiveLayout = resolveEffectiveLayout(preferredLayout, geminiResult.hasFacecam);
      return {
        hasFacecam: geminiResult.hasFacecam,
        status: geminiResult.status,
        confidence: geminiResult.confidence,
        positionLabel: geminiResult.positionLabel,
        boundingBox: geminiResult.boundingBox,
        effectiveLayout,
        method: 'gemini-vision',
      };
    }
  } catch (err) {
    console.warn('[FacecamDetector] Gemini check skipped:', err);
  }

  // Clean up sampled probe frames if not already done
  for (const fp of sampleFrames) {
    try { fs.unlinkSync(fp); } catch {}
  }

  // 4. Fallback to FFmpeg CV Signalstats heuristics
  const ffmpegResult = await runFfmpegCvHeuristics(videoPath, durationSec);
  const effectiveLayout = resolveEffectiveLayout(preferredLayout, ffmpegResult.hasFacecam);

  return {
    hasFacecam: ffmpegResult.hasFacecam,
    status: ffmpegResult.status,
    confidence: ffmpegResult.confidence,
    positionLabel: ffmpegResult.positionLabel,
    boundingBox: ffmpegResult.boundingBox,
    effectiveLayout,
    method: 'ffmpeg-cv-heuristics',
  };
}

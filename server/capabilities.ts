import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedNvencSupport: boolean | null = null;

/**
 * Probes whether an actual NVIDIA NVENC hardware encoder works at runtime
 * (not just whether h264_nvenc is compiled into FFmpeg).
 */
export async function detectNvencSupport(): Promise<boolean> {
  if (cachedNvencSupport !== null) return cachedNvencSupport;
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=black:s=256x256:d=0.1',
        '-vframes',
        '1',
        '-c:v',
        'h264_nvenc',
        '-f',
        'null',
        '-',
      ],
      { timeout: 4000 }
    );
    cachedNvencSupport = true;
  } catch {
    cachedNvencSupport = false;
  }
  return cachedNvencSupport;
}

export function getOllamaHost(): string {
  const raw = process.env.OLLAMA_HOST?.trim() || 'http://127.0.0.1:11434';
  return raw.replace(/\/+$/, '');
}

export async function checkOllama(): Promise<{
  available: boolean;
  host: string;
  models: string[];
}> {
  const host = getOllamaHost();
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    const res = await fetch(`${host}/api/tags`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return { available: false, host, models: [] };
    }
    const data = (await res.json()) as { models?: Array<{ name: string }> };
    const models = Array.isArray(data.models) ? data.models.map((m) => m.name) : [];
    return { available: true, host, models };
  } catch {
    return { available: false, host, models: [] };
  }
}

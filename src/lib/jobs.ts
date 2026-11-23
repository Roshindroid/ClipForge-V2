import type { JobStatus } from '../types';

export function formatTimecode(sec: number): string {
  const total = Math.max(0, Math.floor(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function parseTimecodeInput(raw: string): number | null {
  const cleaned = raw.trim();
  if (!cleaned) return null;
  if (/^\d+(\.\d+)?$/.test(cleaned)) {
    return Math.max(0, Number(cleaned));
  }
  const parts = cleaned.split(':').map((p) => Number(p));
  if (parts.some((n) => Number.isNaN(n) || n < 0)) return null;
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return null;
}

export async function pollJobUntilDone(
  jobId: string,
  onUpdate?: (job: JobStatus) => void,
  intervalMs = 750
): Promise<JobStatus> {
  while (true) {
    const res = await fetch(`/api/jobs/${jobId}`);
    const data = (await res.json()) as { job?: JobStatus; error?: string };
    if (!res.ok || !data.job) {
      throw new Error(data.error || 'Background job status lookup failed');
    }
    onUpdate?.(data.job);
    if (data.job.status === 'completed') {
      return data.job;
    }
    if (data.job.status === 'failed') {
      throw new Error(data.job.error || 'Background job failed');
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

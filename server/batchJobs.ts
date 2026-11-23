import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as archiverModule from 'archiver';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const archiver: any = (archiverModule as any).default || archiverModule;
import type {
  BatchProcessJob,
  BrandingConfig,
  LayoutId,
  TemplateId,
  VideoSegment,
} from '../src/types.ts';
import { detectSegmentFacecam } from './facecamDetector.ts';
import { renderSegmentClipV2 } from './rendererV2.ts';
import {
  RENDERS_DIR,
  SOURCES_DIR,
  WORKSPACE_ROOT,
  ensureWorkspace,
  resolveSafeChildPath,
  resolveSafeSourcePath,
  sanitizeFileSlug,
} from './storage.ts';
import { downloadSegmentWithYtDlp } from './ytdlp.ts';

const BATCH_JOBS_FILE = path.join(WORKSPACE_ROOT, 'batch_jobs.json');
const batchJobs = new Map<string, BatchProcessJob>();

function loadPersistedBatchJobs(): void {
  ensureWorkspace();
  try {
    if (fs.existsSync(BATCH_JOBS_FILE)) {
      const raw = fs.readFileSync(BATCH_JOBS_FILE, 'utf8');
      const list = JSON.parse(raw) as BatchProcessJob[];
      if (Array.isArray(list)) {
        for (const job of list) {
          batchJobs.set(job.id, job);
        }
      }
    }
  } catch {
    // Ignore corrupt storage fallback
  }
}

function persistBatchJobs(): void {
  ensureWorkspace();
  try {
    const list = Array.from(batchJobs.values());
    fs.writeFileSync(BATCH_JOBS_FILE, JSON.stringify(list, null, 2), 'utf8');
  } catch {
    // Ignore persist errors
  }
}

loadPersistedBatchJobs();

export function getBatchJob(id: string): BatchProcessJob | undefined {
  return batchJobs.get(id);
}

export function listBatchJobs(): BatchProcessJob[] {
  return Array.from(batchJobs.values()).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

export interface CreateBatchJobParams {
  videoUrl: string;
  videoTitle: string;
  videoDurationSec: number;
  segments: Array<{
    order: number;
    startSeconds: number;
    endSeconds: number;
    durationSeconds: number;
    label?: string;
  }>;
  preferredLayout: LayoutId;
  templateId?: TemplateId;
  resolution?: '1080x1920' | '720x1280';
  frameRate?: 'original' | '60' | '30';
  branding?: Partial<BrandingConfig>;
}

/**
 * Creates and starts a new V2 batch processing job.
 */
export function createBatchProcessJob(params: CreateBatchJobParams): BatchProcessJob {
  ensureWorkspace();
  const now = new Date().toISOString();
  const jobId = `batch_${crypto.randomBytes(6).toString('hex')}`;

  const segments: VideoSegment[] = params.segments.map((s, idx) => ({
    id: `seg_${crypto.randomBytes(4).toString('hex')}`,
    order: s.order || idx + 1,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    durationSeconds: s.durationSeconds,
    label: s.label,
    status: 'queued',
    progress: 0,
    facecam: {
      status: 'pending',
      confidence: null,
      boundingBox: null,
      positionLabel: undefined,
    },
    preferredLayout: params.preferredLayout,
    effectiveLayout: null,
    outputFileName: null,
    outputPath: null,
    downloadUrl: null,
    previewUrl: null,
    error: null,
  }));

  const job: BatchProcessJob = {
    id: jobId,
    videoUrl: params.videoUrl,
    videoTitle: params.videoTitle || 'Source Video',
    videoDurationSec: params.videoDurationSec,
    preferredLayout: params.preferredLayout,
    templateId: params.templateId || 'none',
    resolution: params.resolution || '1080x1920',
    frameRate: params.frameRate || 'original',
    branding: {
      creditText: params.branding?.creditText || '@clipforge',
      backgroundHex: params.branding?.backgroundHex || '#0B0D11',
      watermarkText: params.branding?.watermarkText || '',
    },
    status: 'queued',
    progress: 0,
    stage: 'Initializing batch queue...',
    segments,
    createdAt: now,
    updatedAt: now,
  };

  batchJobs.set(job.id, job);
  persistBatchJobs();

  // Run batch asynchronously in the background
  executeBatchJobAsync(job.id).catch((err) => {
    console.error(`[BatchJob ${job.id}] Unhandled error:`, err);
  });

  return job;
}

/**
 * Executes a batch job with controlled sequential processing of segments to preserve
 * CPU & memory resources while ensuring each segment is independently downloaded,
 * analyzed for facecam, layout-resolved, and rendered.
 */
async function executeBatchJobAsync(jobId: string): Promise<void> {
  const job = batchJobs.get(jobId);
  if (!job) return;

  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  persistBatchJobs();

  const totalSegments = job.segments.length;
  let successCount = 0;
  let failureCount = 0;

  // Dedicated directory for this batch's source segments
  const batchSourceDir = path.join(SOURCES_DIR, jobId);
  if (!fs.existsSync(batchSourceDir)) {
    fs.mkdirSync(batchSourceDir, { recursive: true });
  }

  for (let i = 0; i < totalSegments; i++) {
    const segment = job.segments[i];
    const segmentNum = String(segment.order).padStart(3, '0');

    // Update progress
    const baseProgress = Math.round((i / totalSegments) * 100);
    job.progress = Math.max(5, baseProgress);
    job.stage = `Processing clip ${i + 1} of ${totalSegments} (clip_${segmentNum})...`;
    job.detail = `${segment.startSeconds}s – ${segment.endSeconds}s (${segment.durationSeconds}s)`;
    job.updatedAt = new Date().toISOString();
    persistBatchJobs();

    // Step 1: Download segment
    segment.status = 'downloading';
    segment.progress = 10;
    persistBatchJobs();

    const segmentSourceFile = path.join(batchSourceDir, `segment_${segmentNum}.mp4`);

    try {
      await downloadSegmentWithYtDlp(
        job.videoUrl,
        segment.startSeconds,
        segment.endSeconds,
        segmentSourceFile,
        'video',
        (dlPct, detail) => {
          segment.progress = Math.min(45, 10 + Math.round(dlPct * 0.35));
          job.detail = `Downloading segment: ${detail}`;
          persistBatchJobs();
        }
      );

      if (!fs.existsSync(segmentSourceFile) || fs.statSync(segmentSourceFile).size === 0) {
        throw new Error('Downloaded segment MP4 file is missing or empty.');
      }

      // Step 2: Independent Facecam Detection
      segment.status = 'detecting';
      segment.progress = 50;
      job.stage = `Detecting facecam for clip ${i + 1}/${totalSegments}...`;
      job.detail = 'Running computer vision analysis...';
      persistBatchJobs();

      const facecamResult = await detectSegmentFacecam(
        segmentSourceFile,
        segment.durationSeconds,
        job.preferredLayout
      );

      segment.facecam = {
        status: facecamResult.status,
        confidence: facecamResult.confidence,
        boundingBox: facecamResult.boundingBox,
        positionLabel: facecamResult.positionLabel,
      };

      // Set effective layout (Facecam layout if detected, Gameplay Only fallback if not found)
      segment.effectiveLayout = facecamResult.effectiveLayout;

      // Step 3: Render vertical Short with effective layout
      segment.status = 'rendering';
      segment.progress = 60;
      job.stage = `Rendering clip ${i + 1}/${totalSegments} with ${segment.effectiveLayout}...`;
      job.detail = `Facecam: ${segment.facecam.status === 'detected' ? segment.facecam.positionLabel : 'None (Gameplay Only)'}`;
      persistBatchJobs();

      const outputFileName = `clip_${segmentNum}.mp4`;
      const renderRes = await renderSegmentClipV2({
        inputFilePath: segmentSourceFile,
        outputFileName,
        layoutId: segment.effectiveLayout,
        templateId: job.templateId,
        facecamBox: segment.facecam.boundingBox
          ? {
              ...segment.facecam.boundingBox,
              confidence: segment.facecam.confidence ?? 0.85,
              presetLabel: segment.facecam.positionLabel || 'Detected Cam',
            }
          : null,
        branding: job.branding,
        hookTagline: segment.label,
        resolution: job.resolution,
        frameRate: job.frameRate,
        onProgress: (pct, _stage, detail) => {
          segment.progress = Math.min(98, 60 + Math.round(pct * 0.38));
          job.detail = detail || 'Encoding video...';
          persistBatchJobs();
        },
      });

      // Mark segment completed
      segment.status = 'completed';
      segment.progress = 100;
      segment.outputFileName = renderRes.outputFileName;
      segment.outputPath = renderRes.outputPath;
      segment.downloadUrl = renderRes.downloadUrl;
      segment.previewUrl = renderRes.downloadUrl;
      segment.fileSizeBytes = renderRes.fileSizeBytes;
      segment.error = null;
      successCount++;
    } catch (segErr) {
      console.error(`[BatchJob ${job.id}] Segment ${i + 1} failed:`, segErr);
      segment.status = 'failed';
      segment.error = segErr instanceof Error ? segErr.message : 'Segment processing failed';
      segment.progress = 100;
      failureCount++;
      // Do not abort whole batch! Continue processing remaining segments.
    }

    job.updatedAt = new Date().toISOString();
    persistBatchJobs();
  }

  // Finalize batch status
  job.progress = 100;
  job.completedAt = new Date().toISOString();
  job.updatedAt = new Date().toISOString();

  if (failureCount === 0) {
    job.status = 'completed';
    job.stage = `Batch complete! All ${successCount} clip(s) rendered successfully.`;
  } else if (successCount > 0) {
    job.status = 'partial_failure';
    job.stage = `Batch finished with ${successCount} successful clip(s) and ${failureCount} failed.`;
  } else {
    job.status = 'failed';
    job.stage = 'Batch processing failed: all segments encountered errors.';
  }

  job.zipDownloadUrl = `/api/v2/jobs/${job.id}/download-all`;
  persistBatchJobs();
}

/**
 * Streams a ZIP archive of all successfully completed clips in this batch.
 */
export function streamBatchZipArchive(
  job: BatchProcessJob,
  res: import('express').Response
): void {
  const completedSegments = job.segments.filter(
    (s) => s.status === 'completed' && s.outputPath && fs.existsSync(s.outputPath)
  );

  if (completedSegments.length === 0) {
    res.status(404).json({ error: 'No completed video clips available for download.' });
    return;
  }

  const archiveName = `clipforge_${sanitizeFileSlug(job.videoTitle, 24)}_${job.id.slice(-6)}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);

  const archive = archiver('zip', {
    zlib: { level: 5 }, // Balanced compression speed
  });

  archive.on('error', (err: Error) => {
    console.error(`[Archive Error ${job.id}]:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to create ZIP archive.' });
    }
  });

  archive.pipe(res);

  // Add each completed clip to the archive in order
  for (const seg of completedSegments) {
    if (seg.outputPath && fs.existsSync(seg.outputPath)) {
      const entryName = seg.outputFileName || `clip_${String(seg.order).padStart(3, '0')}.mp4`;
      archive.file(seg.outputPath, { name: entryName });
    }
  }

  // Add a manifest file describing the clips
  const manifest = {
    clipForgeVersion: '2.0',
    jobId: job.id,
    videoUrl: job.videoUrl,
    videoTitle: job.videoTitle,
    preferredLayout: job.preferredLayout,
    resolution: job.resolution,
    frameRate: job.frameRate,
    completedAt: job.completedAt || new Date().toISOString(),
    clips: completedSegments.map((s) => ({
      order: s.order,
      fileName: s.outputFileName,
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      durationSeconds: s.durationSeconds,
      label: s.label || null,
      facecamStatus: s.facecam.status,
      facecamPosition: s.facecam.positionLabel || null,
      confidence: s.facecam.confidence,
      effectiveLayout: s.effectiveLayout,
    })),
  };

  archive.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  archive.finalize();
}

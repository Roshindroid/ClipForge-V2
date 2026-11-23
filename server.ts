import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import multer from 'multer';
import { createServer as createViteServer } from 'vite';
import type {
  BrandingConfig,
  FacecamBox,
  LayoutId,
  TemplateId,
  VideoProject,
  ViralMoment,
} from './src/types.ts';
import {
  analyzeVideoProject,
  computeFinalRankScore,
  findViralMoments,
} from './server/analyzer.ts';
import {
  downloadMomentSegment1080p,
  generateSampleStreamVideo,
  inspectFromUrl,
} from './server/ingest.ts';
import {
  canAutoPruneProject,
  completeJob,
  createJob,
  enqueueRenderTask,
  failJob,
  getJob,
  updateJob,
} from './server/jobs.ts';
import { ensureRemotePreviewSegment, renderVerticalClip } from './server/renderer.ts';
import {
  createBatchProcessJob,
  getBatchJob,
  listBatchJobs,
  streamBatchZipArchive,
} from './server/batchJobs.ts';
import { parseMultilineTimestamps } from './src/lib/timestampParser.ts';
import {
  FRAMES_DIR,
  RENDERS_DIR,
  SOURCES_DIR,
  cleanupProjectSource,
  deleteClip,
  deleteProject,
  ensureWorkspace,
  getClip,
  getProject,
  getStorageStatus,
  listClips,
  listProjects,
  loadAppSettings,
  pruneAllDownloadedSources,
  resolveSafeChildPath,
  resolveSafeSourcePath,
  saveAppSettings,
  saveClip,
  saveProject,
} from './server/storage.ts';
import {
  clearCookiesFile,
  ensureYtDlp,
  getCookiesStatus,
  saveCookiesContent,
} from './server/ytdlp.ts';

dotenv.config();
ensureWorkspace();

// Ensure ffmpeg is in PATH (Windows: add BtbN FFmpeg build path)
if (process.platform === 'win32') {
  const ffmpegPath = 'C:\\Users\\roshi\\AppData\\Local\\Temp\\ffmpeg\\ffmpeg-master-latest-win64-gpl-shared\\bin';
  const currentPath = process.env.PATH || '';
  if (!currentPath.includes(ffmpegPath)) {
    process.env.PATH = ffmpegPath + ';' + currentPath;
  }
}

ensureYtDlp().catch(() => {
  // Auto-bootstraps on demand when a URL is inspected
});

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const ALLOWED_VIDEO_EXTS = new Set(['.mp4', '.mov', '.webm', '.mkv']);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      ensureWorkspace();
      cb(null, SOURCES_DIR);
    },
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      const safeExt = ALLOWED_VIDEO_EXTS.has(ext) ? ext : '.mp4';
      cb(null, `upload_${crypto.randomBytes(6).toString('hex')}${safeExt}`);
    },
  }),
  limits: {
    fileSize: 100 * 1024 * 1024 * 1024,
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_VIDEO_EXTS.has(ext) || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only MP4, MOV, WebM, and MKV video files are supported.'));
    }
  },
});

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  app.get('/api/ytdlp/cookies/status', (_req, res) => {
    res.json(getCookiesStatus());
  });

  app.post('/api/ytdlp/cookies', (req, res) => {
    try {
      const raw = typeof req.body?.cookiesText === 'string' ? req.body.cookiesText : '';
      const status = saveCookiesContent(raw);
      res.json(status);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid cookie format' });
    }
  });

  app.delete('/api/ytdlp/cookies', (_req, res) => {
    clearCookiesFile();
    res.json(getCookiesStatus());
  });

  app.get('/api/jobs/:id', (req, res) => {
    const job = getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found or expired' });
    res.json({ job });
  });

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjects() });
  });

  // --- ClipForge V2 API Routes ---

  app.post('/api/v2/inspect-url', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      return res.status(400).json({ error: 'Video URL is required.' });
    }

    try {
      const inspected = await inspectFromUrl(
        rawUrl,
        typeof req.body?.title === 'string' ? req.body.title : undefined,
        undefined,
        { skipAutoTranscript: true }
      );

      res.json({
        title: inspected.title,
        platform: inspected.platform,
        durationSec: inspected.preProbed?.durationSec || 0,
        width: inspected.preProbed?.width || 1920,
        height: inspected.preProbed?.height || 1080,
        fps: inspected.preProbed?.fps || 30,
        chapters: inspected.chapters || [],
      });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not inspect video URL.',
      });
    }
  });

  app.post('/api/v2/parse-timestamps', (req, res) => {
    const timestampsText = typeof req.body?.timestamps === 'string' ? req.body.timestamps : '';
    const durationSec = typeof req.body?.durationSec === 'number' ? req.body.durationSec : undefined;
    const result = parseMultilineTimestamps(timestampsText, durationSec);
    res.json(result);
  });

  app.post('/api/v2/jobs', (req, res) => {
    const {
      videoUrl,
      videoTitle,
      videoDurationSec,
      segments,
      preferredLayout,
      templateId,
      resolution,
      frameRate,
      branding,
    } = req.body || {};

    if (!videoUrl || typeof videoUrl !== 'string') {
      return res.status(400).json({ error: 'Valid video URL is required.' });
    }

    if (!Array.isArray(segments) || segments.length === 0) {
      return res.status(400).json({ error: 'At least one valid segment is required.' });
    }

    try {
      const job = createBatchProcessJob({
        videoUrl: videoUrl.trim(),
        videoTitle:
          typeof videoTitle === 'string' && videoTitle.trim() ? videoTitle.trim() : 'Video Project',
        videoDurationSec: Number(videoDurationSec) || 0,
        segments: segments.map((s: { order?: number; startSeconds?: number; endSeconds?: number; durationSeconds?: number; label?: string }, idx: number) => ({
          order: typeof s.order === 'number' ? s.order : idx + 1,
          startSeconds: Number(s.startSeconds || 0),
          endSeconds: Number(s.endSeconds || 0),
          durationSeconds: Number(
            s.durationSeconds || Math.max(2, (s.endSeconds || 0) - (s.startSeconds || 0))
          ),
          label: typeof s.label === 'string' ? s.label : undefined,
        })),
        preferredLayout: preferredLayout || 'split-top-cam',
        templateId: templateId || 'none',
        resolution: resolution === '720x1280' ? '720x1280' : '1080x1920',
        frameRate: frameRate === '60' ? '60' : frameRate === '30' ? '30' : 'original',
        branding,
      });

      res.status(202).json({ jobId: job.id, job });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not create batch job.',
      });
    }
  });

  app.get('/api/v2/jobs', (_req, res) => {
    res.json({ jobs: listBatchJobs() });
  });

  app.get('/api/v2/jobs/:id', (req, res) => {
    const job = getBatchJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Batch job not found or expired.' });
    res.json({ job });
  });

  app.get('/api/v2/jobs/:id/segments', (req, res) => {
    const job = getBatchJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Batch job not found.' });
    res.json({ segments: job.segments });
  });

  app.get('/api/v2/jobs/:id/download/:segmentId', (req, res) => {
    const job = getBatchJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Batch job not found.' });

    const segment = job.segments.find(
      (s) => s.id === req.params.segmentId || String(s.order) === req.params.segmentId
    );
    if (!segment || !segment.outputPath || !fs.existsSync(segment.outputPath)) {
      return res.status(404).json({ error: 'Segment video file not found or not rendered yet.' });
    }

    const downloadFileName =
      segment.outputFileName || `clip_${String(segment.order).padStart(3, '0')}.mp4`;
    res.download(segment.outputPath, downloadFileName);
  });

  app.get('/api/v2/jobs/:id/download-all', (req, res) => {
    const job = getBatchJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Batch job not found.' });
    streamBatchZipArchive(job, res);
  });

  app.post('/api/ingest/upload', upload.single('video'), (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose a video file to upload.' });
    }

    const uploadedFile = req.file;
    const rawTitle = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    const transcriptText =
      typeof req.body?.transcriptText === 'string' ? req.body.transcriptText : undefined;
    const title =
      rawTitle ||
      path.basename(uploadedFile.originalname, path.extname(uploadedFile.originalname)) ||
      'Uploaded Video';

    const job = createJob('ingest-upload', 'Analyzing uploaded video...', title.slice(0, 80));

    (async () => {
      try {
        const project = await analyzeVideoProject({
          fileName: uploadedFile.filename,
          title: title.slice(0, 120),
          sourceType: 'local',
          sourceMode: 'local',
          transcriptText,
          onProgress: (pct, stage, detail) => updateJob(job.id, { progress: pct, stage, detail }),
        });
        saveProject(project);
        completeJob(job.id, { project });
      } catch (err) {
        if (uploadedFile.path && fs.existsSync(uploadedFile.path)) {
          try {
            fs.unlinkSync(uploadedFile.path);
          } catch {
            // ignore
          }
        }
        failJob(job.id, err instanceof Error ? err.message : 'Upload analysis failed');
      }
    })();

    res.status(202).json({ jobId: job.id, job });
  });

  /**
   * Step 1: Inspect URL remotely (0 video download). Pulls metadata, heatmaps,
   * chapters, and auto-captions, then detects the top viral moments.
   */
  app.post('/api/ingest/url', (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    const titleOverride = typeof req.body?.title === 'string' ? req.body.title.trim() : undefined;
    const manualTranscript =
      typeof req.body?.transcriptText === 'string' && req.body.transcriptText.trim()
        ? req.body.transcriptText.trim()
        : undefined;
    const downloadFolder =
      typeof req.body?.downloadFolder === 'string' ? req.body.downloadFolder.trim() : 'segments';

    if (!rawUrl) {
      return res.status(400).json({ error: 'Video URL is required.' });
    }

    const job = createJob(
      'ingest-url',
      'Inspecting link for best moments (no full download)...',
      rawUrl.slice(0, 80)
    );

    (async () => {
      try {
        const inspected = await inspectFromUrl(
          rawUrl,
          titleOverride,
          (pct, stage, detail) => updateJob(job.id, { progress: pct, stage, detail }),
          {
            downloadFolder,
            skipAutoTranscript: Boolean(manualTranscript),
          }
        );

        const resolvedTranscript = manualTranscript || inspected.autoTranscriptText;
        const project = await analyzeVideoProject({
          title: inspected.title,
          sourceType: inspected.platform,
          sourceMode: 'segments',
          downloadFolder: inspected.downloadFolder,
          sourceUrl: rawUrl,
          streamUrls: inspected.streamUrls,
          preProbed: inspected.preProbed,
          chapters: inspected.chapters,
          heatmap: inspected.heatmap,
          transcriptText: resolvedTranscript,
          autoTranscriptFetched: Boolean(!manualTranscript && inspected.autoTranscriptText),
          onProgress: (pct, stage, detail) => updateJob(job.id, { progress: pct, stage, detail }),
        });

        saveProject(project);
        completeJob(job.id, { project });
      } catch (err) {
        failJob(job.id, err instanceof Error ? err.message : 'Link inspection failed');
      }
    })();

    res.status(202).json({ jobId: job.id, job });
  });

  app.post('/api/ingest/sample', async (_req, res) => {
    try {
      const sample = await generateSampleStreamVideo();
      const sampleTranscript = [
        '00:00:00,000 --> 00:00:05,500',
        'Wait look at the corner right now, no way we hold this angle.',
        '',
        '00:00:08,200 --> 00:00:12,500',
        'OH MY GOD WHAT A CLUTCH! Did you actually see that insane flick?!',
        '',
        '00:00:13,500 --> 00:00:17,800',
        'Bro chat is going crazy, clip that right now before it disappears!',
      ].join('\n');

      const project = await analyzeVideoProject({
        fileName: sample.fileName,
        title: sample.title,
        sourceType: sample.platform,
        sourceMode: 'local',
        transcriptText: sampleTranscript,
      });

      saveProject(project);
      res.status(201).json({ project });
    } catch (err) {
      res
        .status(500)
        .json({ error: err instanceof Error ? err.message : 'Sample stream generation failed' });
    }
  });

  /**
   * Step 2a: Select/deselect moments or refine their startSec/endSec/title before downloading in 1080p.
   */
  app.patch('/api/projects/:id/moments/:momentId', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const target = project.moments.find((m) => m.id === req.params.momentId);
    if (!target) return res.status(404).json({ error: 'Moment not found' });

    const nextStart =
      typeof req.body?.startSec === 'number'
        ? Math.max(0, Math.min(project.durationSec - 2, Number(req.body.startSec)))
        : target.startSec;
    const nextEnd =
      typeof req.body?.endSec === 'number'
        ? Math.min(project.durationSec, Math.max(nextStart + 2, Number(req.body.endSec)))
        : Math.max(nextStart + 2, target.endSec);

    const boundsChanged =
      Math.abs(nextStart - target.startSec) > 0.25 || Math.abs(nextEnd - target.endSec) > 0.25;

    const updatedMoments = project.moments.map((m) => {
      if (m.id !== target.id) return m;
      return {
        ...m,
        startSec: Math.round(nextStart * 10) / 10,
        endSec: Math.round(nextEnd * 10) / 10,
        durationSec: Math.round((nextEnd - nextStart) * 10) / 10,
        title:
          typeof req.body?.title === 'string' && req.body.title.trim()
            ? req.body.title.trim().slice(0, 90)
            : m.title,
        selected: typeof req.body?.selected === 'boolean' ? req.body.selected : m.selected,
        segmentStatus:
          boundsChanged && project.sourceMode === 'segments' ? ('pending' as const) : m.segmentStatus,
        segmentFileName: boundsChanged ? undefined : m.segmentFileName,
        segmentSizeBytes: boundsChanged ? 0 : m.segmentSizeBytes,
      };
    });

    const updated = saveProject({ ...project, moments: updatedMoments });
    res.json({ project: updated });
  });

  /**
   * Step 2b: Download ONLY selected moments in 1080p MP4 into workspace/sources/<folder>/.
   */
  app.post('/api/projects/:id/download-segments', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.sourceMode !== 'segments' || !project.sourceUrl) {
      return res.status(400).json({ error: 'Project is already backed by a local video file.' });
    }

    const requestedIds = Array.isArray(req.body?.momentIds)
      ? (req.body.momentIds as string[])
      : null;

    const targetMoments = project.moments.filter((m) => {
      if (requestedIds && requestedIds.length > 0) {
        return requestedIds.includes(m.id);
      }
      return m.selected && m.segmentStatus !== 'ready';
    });

    if (targetMoments.length === 0) {
      return res.json({ project, alreadyReady: true });
    }

    const job = createJob(
      'download-segments',
      `Downloading ${targetMoments.length} moment(s) in 1080p...`,
      project.title,
      { projectId: project.id }
    );

    (async () => {
      try {
        let currentProject = getProject(project.id) || project;

        for (let i = 0; i < targetMoments.length; i++) {
          const target = targetMoments[i];
          updateJob(job.id, {
            progress: Math.max(5, Math.round((i / targetMoments.length) * 100)),
            stage: `Downloading clip ${i + 1}/${targetMoments.length} in 1080p...`,
            detail: target.title,
          });

          try {
            const seg = await downloadMomentSegment1080p({
              project: currentProject,
              moment: target,
              onProgress: (dlPct, dlDetail) => {
                const overall = Math.round(((i + dlPct / 100) / targetMoments.length) * 100);
                updateJob(job.id, {
                  progress: overall,
                  stage: `Downloading clip ${i + 1}/${targetMoments.length} in 1080p...`,
                  detail: dlDetail,
                });
              },
            });

            currentProject = saveProject({
              ...currentProject,
              moments: currentProject.moments.map((m) =>
                m.id === target.id
                  ? {
                      ...m,
                      segmentStatus: 'ready',
                      segmentFileName: seg.segmentFileName,
                      segmentSizeBytes: seg.segmentSizeBytes,
                      segmentError: undefined,
                    }
                  : m
              ),
            });
          } catch (segErr) {
            const msg = segErr instanceof Error ? segErr.message : 'Segment download failed';
            currentProject = saveProject({
              ...currentProject,
              moments: currentProject.moments.map((m) =>
                m.id === target.id
                  ? { ...m, segmentStatus: 'error', segmentError: msg }
                  : m
              ),
            });
            throw segErr;
          }
        }

        completeJob(job.id, { project: currentProject });
      } catch (err) {
        failJob(job.id, err instanceof Error ? err.message : '1080p segment download failed');
      }
    })();

    res.status(202).json({ jobId: job.id, job });
  });

  app.post('/api/projects/:id/reanalyze', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const transcriptText =
        typeof req.body?.transcriptText === 'string'
          ? req.body.transcriptText
          : project.transcriptText;

      const moments = await findViralMoments(
        project.title,
        project.durationSec,
        project.audioEnergySeries,
        project.sourceMode,
        transcriptText
      );

      const updated = saveProject({
        ...project,
        transcriptText,
        moments,
      });
      res.json({ project: updated });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Re-analysis failed' });
    }
  });

  app.get('/api/projects/:id/moments/:momentId/preview', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const moment = project.moments.find((m) => m.id === req.params.momentId);
      if (!moment) return res.status(404).json({ error: 'Moment not found' });

      // Serve downloaded 1080p segment directly if ready on disk
      if (moment.segmentFileName && moment.segmentStatus === 'ready') {
        const segPath = resolveSafeSourcePath(moment.segmentFileName);
        if (fs.existsSync(segPath)) {
          res.sendFile(segPath);
          return;
        }
      }

      const previewDur = Math.min(55, Math.max(15, moment.durationSec + 8));
      const previewStart = Math.max(0, moment.startSec - 2);
      const previewPath = await ensureRemotePreviewSegment(project, previewStart, previewDur);
      res.sendFile(previewPath);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not prepare segment preview',
      });
    }
  });

  app.get('/api/projects/:id/preview-window', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });

      const startSec = Math.max(0, Number(req.query.start ?? 0));
      const durSec = Math.min(60, Math.max(10, Number(req.query.dur ?? 45)));
      const previewPath = await ensureRemotePreviewSegment(project, startSec, durSec);
      res.sendFile(previewPath);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not prepare timestamp preview',
      });
    }
  });

  app.post('/api/projects/:id/moments', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const startSec = Math.max(0, Number(req.body?.startSec ?? 0));
    const rawEnd = Number(req.body?.endSec ?? startSec + 15);
    const endSec = Math.min(project.durationSec, Math.max(startSec + 2, rawEnd));
    const durationSec = Math.round((endSec - startSec) * 10) / 10;
    const title =
      typeof req.body?.title === 'string' && req.body.title.trim()
        ? req.body.title.trim().slice(0, 90)
        : `Custom Clip (${startSec.toFixed(1)}s – ${endSec.toFixed(1)}s)`;

    const slice = project.audioEnergySeries.filter((p) => p.sec >= startSec && p.sec <= endSec);
    let peakDb = -18;
    let avgNorm = 0.65;
    if (slice.length > 0) {
      peakDb = slice.reduce((acc, p) => (p.db > acc ? p.db : acc), slice[0].db);
      avgNorm = slice.reduce((a, b) => a + b.normalized, 0) / slice.length;
    } else if (project.audioEnergySeries.length > 0) {
      const nearest = project.audioEnergySeries.reduce((best, p) =>
        Math.abs(p.sec - startSec) < Math.abs(best.sec - startSec) ? p : best
      );
      peakDb = nearest.db;
      avgNorm = nearest.normalized;
    }

    const audioSpikeScore = Math.round(Math.min(0.99, Math.max(0.4, avgNorm + 0.15)) * 100) / 100;
    const transcriptScore = 0.72;
    const llmScore = 0.78;
    const finalRankScore = computeFinalRankScore({
      audioSpikeScore,
      transcriptScore,
      llmScore,
      durationSec,
    });

    const newMoment: ViralMoment = {
      id: `mom_${crypto.randomBytes(4).toString('hex')}`,
      startSec: Math.round(startSec * 10) / 10,
      endSec: Math.round(endSec * 10) / 10,
      durationSec,
      title,
      hookTagline: title,
      description: `Manual clip from ${project.title}.`,
      hashtags: ['#shorts', '#highlights'],
      audioPeakDb: peakDb,
      audioSpikeScore,
      transcriptScore,
      llmScore,
      finalRankScore,
      reason: 'Custom timestamp selection',
      transcriptSnippet: '',
      selected: true,
      segmentStatus: project.sourceMode === 'local' ? 'ready' : 'pending',
      segmentSizeBytes: 0,
    };

    const updated = saveProject({
      ...project,
      moments: [newMoment, ...project.moments],
    });
    res.status(201).json({ project: updated, moment: newMoment });
  });

  app.post('/api/projects/:id/facecam', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const box = req.body?.facecamBox as Partial<FacecamBox> | undefined;
    if (!box || typeof box.x !== 'number' || typeof box.y !== 'number') {
      return res.status(400).json({ error: 'Valid normalized facecamBox coordinates required.' });
    }

    const clamped: FacecamBox = {
      x: Math.max(0, Math.min(0.9, box.x)),
      y: Math.max(0, Math.min(0.9, box.y)),
      width: Math.max(0.08, Math.min(1, Number(box.width || 0.25))),
      height: Math.max(0.08, Math.min(1, Number(box.height || 0.28))),
      confidence: Number(box.confidence ?? 1),
      presetLabel: String(box.presetLabel || 'Custom Region').slice(0, 48),
    };

    const updated = saveProject({ ...project, detectedFacecam: clamped });
    res.json({ project: updated });
  });

  app.get('/api/storage/status', (_req, res) => {
    res.json(getStorageStatus());
  });

  app.post('/api/storage/prune-sources', (_req, res) => {
    const { projects, freedBytes } = pruneAllDownloadedSources();
    res.json({
      projects,
      freedBytes,
      storage: getStorageStatus(),
    });
  });

  app.post('/api/projects/:id/cleanup-source', (req, res) => {
    try {
      const result = cleanupProjectSource(req.params.id);
      if (!result.project) return res.status(404).json({ error: 'Project not found' });
      res.json({
        project: result.project,
        freedBytes: result.freedBytes,
        storage: getStorageStatus(),
      });
    } catch {
      res.status(400).json({ error: 'Could not clean up source files safely.' });
    }
  });

  app.delete('/api/projects/:id', (req, res) => {
    const ok = deleteProject(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true });
  });

  app.get('/api/settings', (_req, res) => {
    res.json({ settings: loadAppSettings() });
  });

  app.post('/api/settings', (req, res) => {
    const settings = saveAppSettings({
      autoPruneSourceVod:
        typeof req.body?.autoPruneSourceVod === 'boolean'
          ? req.body.autoPruneSourceVod
          : undefined,
    });
    res.json({ settings });
  });

  app.patch('/api/settings', (req, res) => {
    const settings = saveAppSettings({
      autoPruneSourceVod:
        typeof req.body?.autoPruneSourceVod === 'boolean'
          ? req.body.autoPruneSourceVod
          : undefined,
    });
    res.json({ settings });
  });

  app.get('/api/clips', (_req, res) => {
    res.json({ clips: listClips() });
  });

  const queueClipRenderJob = (params: {
    project: VideoProject;
    moment: ViralMoment;
    layoutId: LayoutId;
    templateId: TemplateId;
    facecamBox: FacecamBox;
    branding: BrandingConfig;
    titleOverride?: string;
    hookTaglineOverride?: string;
    descriptionOverride?: string;
    hashtagsOverride?: string[];
  }) => {
    const job = createJob('render', 'Queued for 1080p segment -> 9:16 Short...', params.moment.title, {
      status: 'queued',
      projectId: params.project.id,
      momentId: params.moment.id,
    });

    enqueueRenderTask(async () => {
      updateJob(job.id, { status: 'running', progress: 5, stage: 'Preparing clip...' });
      try {
        let latestProject = getProject(params.project.id) || params.project;
        const latestMoment =
          latestProject.moments.find((m) => m.id === params.moment.id) || params.moment;

        const { clip, downloadedSegment } = await renderVerticalClip({
          project: latestProject,
          moment: latestMoment,
          layoutId: params.layoutId,
          templateId: params.templateId,
          facecamBox: params.facecamBox,
          branding: params.branding,
          titleOverride: params.titleOverride,
          hookTaglineOverride: params.hookTaglineOverride,
          descriptionOverride: params.descriptionOverride,
          hashtagsOverride: params.hashtagsOverride,
          onProgress: (pct, stage, detail) => updateJob(job.id, { progress: pct, stage, detail }),
        });

        saveClip(clip);

        if (downloadedSegment) {
          latestProject = saveProject({
            ...latestProject,
            moments: latestProject.moments.map((m) =>
              m.id === latestMoment.id
                ? {
                    ...m,
                    segmentStatus: 'ready',
                    segmentFileName: downloadedSegment.segmentFileName,
                    segmentSizeBytes: downloadedSegment.segmentSizeBytes,
                  }
                : m
            ),
          });
        }

        let autoPruned = false;
        let updatedProject: VideoProject | undefined = downloadedSegment ? latestProject : undefined;
        const settings = loadAppSettings();

        if (settings.autoPruneSourceVod && canAutoPruneProject(latestProject.id, job.id)) {
          const pruned = cleanupProjectSource(latestProject.id);
          if (pruned.project) {
            autoPruned = true;
            updatedProject = pruned.project;
          }
        }

        completeJob(job.id, { clip, project: updatedProject, autoPruned });
      } catch (err) {
        failJob(job.id, err instanceof Error ? err.message : 'FFmpeg render failed');
      }
    });

    return job;
  };

  app.post('/api/clips/render', (req, res) => {
    const projectId = String(req.body?.projectId || '');
    const momentId = String(req.body?.momentId || '');
    const layoutId = (req.body?.layoutId || 'split-top-cam') as LayoutId;
    const templateId = (req.body?.templateId || 'none') as TemplateId;

    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const moment = project.moments.find((m) => m.id === momentId) || project.moments[0];
    if (!moment) return res.status(404).json({ error: 'Moment not found' });

    const facecamBox = (req.body?.facecamBox as FacecamBox) || project.detectedFacecam;
    const branding: BrandingConfig = {
      creditText: String(req.body?.branding?.creditText || '@clipforge').slice(0, 40),
      backgroundHex: String(req.body?.branding?.backgroundHex || '#0B0D11').slice(0, 12),
      watermarkText: String(req.body?.branding?.watermarkText || '').slice(0, 40),
    };

    const job = queueClipRenderJob({
      project,
      moment,
      layoutId,
      templateId,
      facecamBox,
      branding,
      titleOverride: typeof req.body?.title === 'string' ? req.body.title : undefined,
      hookTaglineOverride:
        typeof req.body?.hookTagline === 'string' ? req.body.hookTagline : undefined,
      descriptionOverride:
        typeof req.body?.description === 'string' ? req.body.description : undefined,
      hashtagsOverride: Array.isArray(req.body?.hashtags) ? req.body.hashtags : undefined,
    });

    res.status(202).json({ jobId: job.id, job });
  });

  app.post('/api/clips/render-batch', (req, res) => {
    const projectId = String(req.body?.projectId || '');
    const layoutId = (req.body?.layoutId || 'split-top-cam') as LayoutId;
    const templateId = (req.body?.templateId || 'none') as TemplateId;

    const project = getProject(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const requestedIds = Array.isArray(req.body?.momentIds)
      ? (req.body.momentIds as string[])
      : null;

    const targetMoments =
      requestedIds && requestedIds.length > 0
        ? project.moments.filter((m) => requestedIds.includes(m.id))
        : project.moments.filter((m) => m.selected);

    if (targetMoments.length === 0) {
      return res.status(400).json({ error: 'Select at least one moment to render.' });
    }

    const facecamBox = (req.body?.facecamBox as FacecamBox) || project.detectedFacecam;
    const branding: BrandingConfig = {
      creditText: String(req.body?.branding?.creditText || '@clipforge').slice(0, 40),
      backgroundHex: String(req.body?.branding?.backgroundHex || '#0B0D11').slice(0, 12),
      watermarkText: String(req.body?.branding?.watermarkText || '').slice(0, 40),
    };

    const jobs = targetMoments.map((moment) =>
      queueClipRenderJob({
        project,
        moment,
        layoutId,
        templateId,
        facecamBox,
        branding,
      })
    );

    res.status(202).json({
      jobIds: jobs.map((j) => j.id),
      jobs,
    });
  });

  app.patch('/api/clips/:id', (req, res) => {
    const existing = getClip(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Clip not found' });

    const updated = saveClip({
      ...existing,
      title: typeof req.body?.title === 'string' ? req.body.title.slice(0, 100) : existing.title,
      hookTagline:
        typeof req.body?.hookTagline === 'string'
          ? req.body.hookTagline.slice(0, 120)
          : existing.hookTagline,
      description:
        typeof req.body?.description === 'string'
          ? req.body.description.slice(0, 1200)
          : existing.description,
      hashtags: Array.isArray(req.body?.hashtags)
        ? req.body.hashtags.map((h: unknown) => String(h).slice(0, 32))
        : existing.hashtags,
      youtubeVideoId:
        typeof req.body?.youtubeVideoId === 'string'
          ? req.body.youtubeVideoId
          : existing.youtubeVideoId,
      youtubePublishAt:
        typeof req.body?.youtubePublishAt === 'string'
          ? req.body.youtubePublishAt
          : existing.youtubePublishAt,
      youtubeStatus: req.body?.youtubeStatus || existing.youtubeStatus,
    });

    res.json({ clip: updated });
  });

  app.delete('/api/clips/:id', (req, res) => {
    const ok = deleteClip(req.params.id);
    if (!ok) return res.status(404).json({ error: 'Clip not found' });
    res.json({ ok: true });
  });

  // Safe static media routes (path-confined)
  app.get('/api/frames/:filename', (req, res) => {
    try {
      const target = resolveSafeChildPath(FRAMES_DIR, req.params.filename);
      if (!fs.existsSync(target)) return res.status(404).end();
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  app.get('/api/sources/*', (req, res) => {
    try {
      const wildcardPath = String((req.params as Record<string, string>)[0] || '');
      const target = resolveSafeSourcePath(wildcardPath);
      if (!fs.existsSync(target)) return res.status(404).end();
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  app.get('/api/renders/:filename', (req, res) => {
    try {
      const target = resolveSafeChildPath(RENDERS_DIR, req.params.filename);
      if (!fs.existsSync(target)) return res.status(404).end();
      if (req.query.download === '1') {
        res.download(target, path.basename(target));
        return;
      }
      res.sendFile(target);
    } catch {
      res.status(400).end();
    }
  });

  app.all('/api/*', (_req, res) => {
    res.status(404).json({ error: 'API route not found' });
  });

  if (!isProduction) {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`ClipForge server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

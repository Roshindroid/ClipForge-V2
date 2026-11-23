import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import {
  LAYOUT_OPTIONS,
  type BrandingConfig,
  type ClipProject,
  type FacecamBox,
  type LayoutId,
  type ProjectSegment,
  type TemplateId,
} from './src/types.ts';
import { parseMultilineTimestamps } from './src/lib/timestampParser.ts';
import {
  extractSegmentFrameAtFraction,
  generateSampleStreamVideo,
  inspectFromUrl,
  probeMediaFile,
} from './server/ingest.ts';
import {
  generateYouTubeMetadataWithAi,
  getAiProviderStatus,
} from './server/llmRouter.ts';
import {
  startSegmentDownloads,
  startSegmentRenders,
} from './server/projectRunner.ts';
import {
  clampFacecamBox,
  layoutUsesFacecam,
  renderLayoutPreviewFrame,
  renderPreviewVideo,
} from './server/rendererV2.ts';
import {
  FRAMES_DIR,
  RENDERS_DIR,
  SOURCES_DIR,
  clearProjectSources,
  deleteClip,
  deleteProject,
  getClip,
  getProject,
  getStorageStatus,
  listClips,
  listProjects,
  resolveSafeChildPath,
  resolveSafeSourcePath,
  restoreWorkspaceOnBoot,
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
restoreWorkspaceOnBoot();

ensureYtDlp().catch(() => {
  // Auto-bootstraps on demand when a URL is inspected
});

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';

const VALID_LAYOUT_IDS = new Set<LayoutId>(LAYOUT_OPTIONS.map((l) => l.id));
const VALID_TEMPLATE_IDS = new Set<TemplateId>(['none', 'x-post', 'tiktok-hook', 'breaking-news']);

function normalizeBranding(raw: unknown, fallback?: BrandingConfig): BrandingConfig {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    creditText:
      typeof r.creditText === 'string'
        ? r.creditText.slice(0, 40)
        : (fallback?.creditText ?? '@clipforge'),
    backgroundHex:
      typeof r.backgroundHex === 'string' && /^#[0-9a-fA-F]{6}$/.test(r.backgroundHex.trim())
        ? r.backgroundHex.trim()
        : (fallback?.backgroundHex ?? '#0B0D11'),
    watermarkText:
      typeof r.watermarkText === 'string'
        ? r.watermarkText.slice(0, 40)
        : (fallback?.watermarkText ?? ''),
  };
}

function validateLayoutId(raw: unknown, fallback: LayoutId = 'split-top-cam'): LayoutId {
  if (typeof raw === 'string' && VALID_LAYOUT_IDS.has(raw as LayoutId)) {
    return raw as LayoutId;
  }
  return fallback;
}

function validateTemplateId(raw: unknown, fallback: TemplateId = 'none'): TemplateId {
  if (typeof raw === 'string' && VALID_TEMPLATE_IDS.has(raw as TemplateId)) {
    return raw as TemplateId;
  }
  return fallback;
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.get('/favicon.ico', (_req, res) => {
    res.status(204).end();
  });

  // --- AI Provider Status & Optional YouTube Metadata Assistant (Backend-Only) ---

  app.get('/api/ai/providers', (_req, res) => {
    res.json({ providers: getAiProviderStatus() });
  });

  app.post('/api/youtube/generate-metadata', async (req, res) => {
    const clipId = typeof req.body?.clipId === 'string' ? req.body.clipId : '';
    const clip = clipId ? getClip(clipId) : undefined;
    const project = clip ? getProject(clip.projectId) : undefined;

    const clipTitle =
      typeof req.body?.clipTitle === 'string' && req.body.clipTitle.trim()
        ? req.body.clipTitle.trim().slice(0, 120)
        : clip?.title || 'Stream Highlight';

    const providerRaw = req.body?.provider;
    const provider =
      providerRaw === 'anthropic' || providerRaw === 'openai' ? providerRaw : 'auto';

    try {
      const suggestion = await generateYouTubeMetadataWithAi({
        provider,
        clipTitle,
        projectTitle: project?.title,
        durationSec:
          typeof req.body?.durationSec === 'number' ? req.body.durationSec : clip?.durationSec,
        existingHook:
          typeof req.body?.existingHook === 'string'
            ? req.body.existingHook.slice(0, 140)
            : clip?.hookTagline,
        existingDescription:
          typeof req.body?.existingDescription === 'string'
            ? req.body.existingDescription.slice(0, 500)
            : clip?.description,
      });
      res.json({ suggestion });
    } catch (err) {
      res.status(400).json({
        error:
          err instanceof Error
            ? err.message
            : 'Could not generate AI metadata. Continue editing manually.',
      });
    }
  });

  // --- yt-dlp Cookie Management ---

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

  // --- Stage 1: URL Inspection & Timestamp Validation ---

  app.post('/api/v2/inspect-url', async (req, res) => {
    const rawUrl = typeof req.body?.url === 'string' ? req.body.url.trim() : '';
    if (!rawUrl) {
      return res.status(400).json({ error: 'Video URL is required.' });
    }

    try {
      const inspected = await inspectFromUrl(
        rawUrl,
        typeof req.body?.title === 'string' ? req.body.title : undefined
      );

      res.json({
        title: inspected.title,
        platform: inspected.platform,
        durationSec: inspected.preProbed.durationSec,
        width: inspected.preProbed.width,
        height: inspected.preProbed.height,
        fps: inspected.preProbed.fps,
        hasAudio: inspected.preProbed.hasAudio,
        thumbnailUrl: inspected.thumbnailUrl,
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

  // --- Persistent Projects & Segment Management ---

  app.get('/api/projects', (_req, res) => {
    res.json({ projects: listProjects() });
  });

  app.get('/api/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    res.json({ project });
  });

  app.post('/api/projects', (req, res) => {
    const body = req.body || {};
    const sourceUrl = typeof body.sourceUrl === 'string' ? body.sourceUrl.trim() : '';
    if (!sourceUrl) {
      return res.status(400).json({ error: 'Source video URL is required.' });
    }

    const rawSegments = Array.isArray(body.segments) ? body.segments : [];
    if (rawSegments.length === 0) {
      return res.status(400).json({ error: 'At least one valid timestamp segment is required.' });
    }

    const durationSec = Number(body.durationSec || 0);
    const parsedSegments: ProjectSegment[] = [];

    for (let i = 0; i < rawSegments.length; i++) {
      const s = rawSegments[i] as Record<string, unknown>;
      const startSeconds = Number(s.startSeconds);
      const endSeconds = Number(s.endSeconds);
      if (
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        startSeconds < 0 ||
        endSeconds <= startSeconds ||
        endSeconds - startSeconds < 2
      ) {
        return res.status(400).json({
          error: `Segment #${i + 1} has invalid start/end timestamps (minimum 2s duration).`,
        });
      }
      if (durationSec > 0 && endSeconds > durationSec) {
        return res.status(400).json({
          error: `Segment #${i + 1} end time (${endSeconds}s) exceeds source video duration (${durationSec}s).`,
        });
      }
      const segDuration = Math.round((endSeconds - startSeconds) * 10) / 10;
      const label =
        typeof s.label === 'string' && s.label.trim()
          ? s.label.trim().slice(0, 90)
          : `Clip #${i + 1}`;

      parsedSegments.push({
        id: `seg_${crypto.randomBytes(5).toString('hex')}`,
        order: i + 1,
        startSeconds,
        endSeconds,
        durationSeconds: segDuration,
        title: label,
        hookTagline: label,
        downloadStatus: 'pending',
        downloadProgress: 0,
        facecamBox: null,
        hasCustomFacecam: false,
        layoutId: 'split-top-cam',
        hasCustomLayout: false,
        renderStatus: 'idle',
        renderProgress: 0,
      });
    }

    const now = new Date().toISOString();
    const project: ClipProject = {
      id: `proj_${crypto.randomBytes(6).toString('hex')}`,
      title:
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, 120)
          : 'ClipForge Project',
      sourceType:
        body.sourceType === 'youtube' ||
        body.sourceType === 'twitch' ||
        body.sourceType === 'kick' ||
        body.sourceType === 'local'
          ? body.sourceType
          : 'direct',
      sourceUrl,
      thumbnailUrl: typeof body.thumbnailUrl === 'string' ? body.thumbnailUrl : undefined,
      durationSec,
      width: Number(body.width || 1920),
      height: Number(body.height || 1080),
      fps: Number(body.fps || 30),
      hasAudio: body.hasAudio !== false,
      sharedFacecamBox: null,
      sharedLayoutId: validateLayoutId(body.sharedLayoutId, 'split-top-cam'),
      templateId: validateTemplateId(body.templateId, 'none'),
      resolution: body.resolution === '720x1280' ? '720x1280' : '1080x1920',
      frameRate: body.frameRate === '60' ? '60' : body.frameRate === '30' ? '30' : 'original',
      branding: normalizeBranding(body.branding),
      segments: parsedSegments,
      createdAt: now,
      updatedAt: now,
    };

    const saved = saveProject(project);
    res.status(201).json({ project: saved });
  });

  app.post('/api/projects/sample', async (_req, res) => {
    try {
      const sample = await generateSampleStreamVideo();
      const samplePath = resolveSafeChildPath(SOURCES_DIR, sample.fileName);
      const probed = await probeMediaFile(samplePath);
      const projectId = `proj_${crypto.randomBytes(6).toString('hex')}`;
      const projDir = resolveSafeSourcePath(projectId);
      if (!fs.existsSync(projDir)) {
        fs.mkdirSync(projDir, { recursive: true });
      }

      const defs = [
        { order: 1, startSeconds: 1, endSeconds: 7, title: 'Opening Setup Clip' },
        { order: 2, startSeconds: 8, endSeconds: 16, title: 'Clutch Highlight Moment' },
      ];

      const segments: ProjectSegment[] = [];
      for (const d of defs) {
        const segId = `seg_${crypto.randomBytes(5).toString('hex')}`;
        const relFile = `${projectId}/segment_${String(d.order).padStart(3, '0')}_${segId}.mp4`;
        const destPath = resolveSafeSourcePath(relFile);
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        await promisify(execFile)('ffmpeg', [
          '-y',
          '-ss',
          String(d.startSeconds),
          '-t',
          String(d.endSeconds - d.startSeconds),
          '-i',
          samplePath,
          '-c',
          'copy',
          destPath,
        ]);
        const frameUrl = await extractSegmentFrameAtFraction({
          projectId,
          segmentId: segId,
          segmentFilePath: destPath,
          durationSec: d.endSeconds - d.startSeconds,
          fraction: 0.5,
        });
        segments.push({
          id: segId,
          order: d.order,
          startSeconds: d.startSeconds,
          endSeconds: d.endSeconds,
          durationSeconds: d.endSeconds - d.startSeconds,
          title: d.title,
          hookTagline: d.title,
          downloadStatus: 'ready',
          downloadProgress: 100,
          sourceFileName: relFile,
          sourceSizeBytes: fs.statSync(destPath).size,
          frameUrl,
          width: probed.width,
          height: probed.height,
          fps: probed.fps,
          hasAudio: probed.hasAudio,
          facecamBox: null,
          hasCustomFacecam: false,
          layoutId: 'split-top-cam',
          hasCustomLayout: false,
          renderStatus: 'idle',
          renderProgress: 0,
        });
      }

      // Clean up temporary full sample file so only project segments remain
      if (fs.existsSync(samplePath)) {
        fs.unlinkSync(samplePath);
      }

      const now = new Date().toISOString();
      const project: ClipProject = {
        id: projectId,
        title: sample.title,
        sourceType: 'local',
        sourceUrl: 'sample://local-demo',
        thumbnailUrl: segments[0]?.frameUrl,
        durationSec: probed.durationSec,
        width: probed.width,
        height: probed.height,
        fps: probed.fps,
        hasAudio: probed.hasAudio,
        sharedFacecamBox: null,
        sharedLayoutId: 'split-top-cam',
        templateId: 'none',
        resolution: '1080x1920',
        frameRate: 'original',
        branding: { creditText: '@clipforge', backgroundHex: '#0B0D11', watermarkText: '' },
        segments,
        createdAt: now,
        updatedAt: now,
      };

      const saved = saveProject(project);
      res.status(201).json({ project: saved });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Failed to create sample project.',
      });
    }
  });

  app.patch('/api/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const body = req.body || {};
    const nextSharedFacecam =
      body.sharedFacecamBox === null
        ? null
        : body.sharedFacecamBox && typeof body.sharedFacecamBox === 'object'
          ? clampFacecamBox(body.sharedFacecamBox as FacecamBox)
          : project.sharedFacecamBox;

    const updated = saveProject({
      ...project,
      title:
        typeof body.title === 'string' && body.title.trim()
          ? body.title.trim().slice(0, 120)
          : project.title,
      sharedLayoutId: body.sharedLayoutId
        ? validateLayoutId(body.sharedLayoutId, project.sharedLayoutId)
        : project.sharedLayoutId,
      sharedFacecamBox: nextSharedFacecam,
      templateId: body.templateId
        ? validateTemplateId(body.templateId, project.templateId)
        : project.templateId,
      resolution:
        body.resolution === '720x1280'
          ? '720x1280'
          : body.resolution === '1080x1920'
            ? '1080x1920'
            : project.resolution,
      frameRate:
        body.frameRate === '60'
          ? '60'
          : body.frameRate === '30'
            ? '30'
            : body.frameRate === 'original'
              ? 'original'
              : project.frameRate,
      branding: body.branding ? normalizeBranding(body.branding, project.branding) : project.branding,
    });

    res.json({ project: updated });
  });

  app.delete('/api/projects/:id', (req, res) => {
    const deleteClips = req.query.deleteClips === 'true';
    const result = deleteProject(req.params.id, { deleteClips });
    if (!result.deleted) return res.status(404).json({ error: 'Project not found' });
    res.json({ ok: true, deletedClipCount: result.deletedClipCount });
  });

  // --- Phase C: Separated Segment Download (Never Triggers Facecam Detection or Rendering) ---

  app.post('/api/projects/:id/download-segments', (req, res) => {
    try {
      const segmentIds = Array.isArray(req.body?.segmentIds)
        ? (req.body.segmentIds as string[])
        : undefined;
      const result = startSegmentDownloads(req.params.id, segmentIds);
      const project = getProject(req.params.id);
      res.status(202).json({ ...result, project });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not start segment downloads.',
      });
    }
  });

  // --- Stage 2: Manual Facecam Positioning, Per-Segment Overrides & Bulk Apply ---

  app.patch('/api/projects/:id/segments/:segmentId', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const seg = project.segments.find((s) => s.id === req.params.segmentId);
    if (!seg) return res.status(404).json({ error: 'Segment not found' });

    const body = req.body || {};
    const nextFacecam =
      body.facecamBox === null
        ? null
        : body.facecamBox && typeof body.facecamBox === 'object'
          ? clampFacecamBox(body.facecamBox as FacecamBox)
          : seg.facecamBox;

    const updatedSegments = project.segments.map((s) => {
      if (s.id !== seg.id) return s;
      return {
        ...s,
        title:
          typeof body.title === 'string' && body.title.trim()
            ? body.title.trim().slice(0, 90)
            : s.title,
        hookTagline:
          typeof body.hookTagline === 'string'
            ? body.hookTagline.slice(0, 120)
            : s.hookTagline,
        facecamBox: nextFacecam,
        hasCustomFacecam:
          typeof body.hasCustomFacecam === 'boolean'
            ? body.hasCustomFacecam
            : body.facecamBox !== undefined
              ? true
              : s.hasCustomFacecam,
        layoutId: body.layoutId ? validateLayoutId(body.layoutId, s.layoutId) : s.layoutId,
        hasCustomLayout:
          typeof body.hasCustomLayout === 'boolean'
            ? body.hasCustomLayout
            : body.layoutId !== undefined
              ? true
              : s.hasCustomLayout,
      };
    });

    const updated = saveProject({ ...project, segments: updatedSegments });
    res.json({ project: updated });
  });

  app.post('/api/projects/:id/apply-facecam', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const rawBox = req.body?.facecamBox;
    const facecamBox =
      rawBox === null
        ? null
        : rawBox && typeof rawBox === 'object'
          ? clampFacecamBox(rawBox as FacecamBox)
          : null;

    if (!facecamBox && rawBox !== null) {
      return res.status(400).json({ error: 'Valid normalized facecamBox coordinates required.' });
    }

    const segmentIds = Array.isArray(req.body?.segmentIds)
      ? (req.body.segmentIds as string[])
      : null;
    const applyAll = !segmentIds || segmentIds.length === 0;

    const updated = saveProject({
      ...project,
      sharedFacecamBox: applyAll ? facecamBox : project.sharedFacecamBox,
      segments: project.segments.map((s) => {
        if (!applyAll && !segmentIds.includes(s.id)) return s;
        return {
          ...s,
          facecamBox,
          hasCustomFacecam: !applyAll,
        };
      }),
    });

    res.json({ project: updated });
  });

  app.post('/api/projects/:id/apply-layout', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const layoutId = validateLayoutId(req.body?.layoutId, project.sharedLayoutId);
    const segmentIds = Array.isArray(req.body?.segmentIds)
      ? (req.body.segmentIds as string[])
      : null;
    const applyAll = !segmentIds || segmentIds.length === 0;

    const updated = saveProject({
      ...project,
      sharedLayoutId: applyAll ? layoutId : project.sharedLayoutId,
      segments: project.segments.map((s) => {
        if (!applyAll && !segmentIds.includes(s.id)) return s;
        return {
          ...s,
          layoutId,
          hasCustomLayout: !applyAll,
        };
      }),
    });

    res.json({ project: updated });
  });

  app.post('/api/projects/:id/clear-sources', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const segmentIds = Array.isArray(req.body?.segmentIds)
      ? (req.body.segmentIds as string[])
      : undefined;

    const busy = project.segments.some(
      (s) =>
        (!segmentIds || segmentIds.length === 0 || segmentIds.includes(s.id)) &&
        (s.downloadStatus === 'downloading' ||
          s.renderStatus === 'queued' ||
          s.renderStatus === 'rendering')
    );
    if (busy) {
      return res.status(409).json({
        error: 'Cannot delete downloaded segment files while a download or render is in progress.',
      });
    }

    const result = clearProjectSources(req.params.id, segmentIds);
    res.json({
      project: result.project,
      freedBytes: result.freedBytes,
      storage: getStorageStatus(),
    });
  });

  // --- Frame Extraction & True FFmpeg 9:16 Composite Previews ---

  app.get('/api/projects/:id/segments/:segmentId/frame', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const seg = project.segments.find((s) => s.id === req.params.segmentId);
      if (!seg || !seg.sourceFileName) {
        return res.status(404).json({ error: 'Segment has not been downloaded yet.' });
      }
      const segPath = resolveSafeSourcePath(seg.sourceFileName);
      if (!fs.existsSync(segPath)) {
        return res.status(404).json({ error: 'Segment source file not found on disk.' });
      }
      const fraction = req.query.fraction !== undefined ? Number(req.query.fraction) : 0.5;
      const frameUrl = await extractSegmentFrameAtFraction({
        projectId: project.id,
        segmentId: seg.id,
        segmentFilePath: segPath,
        durationSec: seg.durationSeconds,
        fraction: Number.isFinite(fraction) ? fraction : 0.5,
      });

      if (seg.frameUrl !== frameUrl && Math.abs(fraction - 0.5) < 0.01) {
        saveProject({
          ...project,
          segments: project.segments.map((s) => (s.id === seg.id ? { ...s, frameUrl } : s)),
        });
      }

      res.json({ frameUrl });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Could not extract segment frame.',
      });
    }
  });

  app.post('/api/projects/:id/segments/:segmentId/preview-frame', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const seg = project.segments.find((s) => s.id === req.params.segmentId);
      if (!seg || !seg.sourceFileName) {
        return res.status(404).json({ error: 'Segment has not been downloaded yet.' });
      }
      const segPath = resolveSafeSourcePath(seg.sourceFileName);
      if (!fs.existsSync(segPath)) {
        return res.status(404).json({ error: 'Segment source file missing on disk.' });
      }

      const fraction =
        typeof req.body?.fraction === 'number' && Number.isFinite(req.body.fraction)
          ? req.body.fraction
          : 0.5;
      const frameUrl = await extractSegmentFrameAtFraction({
        projectId: project.id,
        segmentId: seg.id,
        segmentFilePath: segPath,
        durationSec: seg.durationSeconds,
        fraction,
      });
      const frameFileName = frameUrl.replace('/api/frames/', '');
      const inputImagePath = resolveSafeChildPath(FRAMES_DIR, frameFileName);

      const layoutId = validateLayoutId(
        req.body?.layoutId,
        seg.hasCustomLayout ? seg.layoutId : project.sharedLayoutId
      );
      const templateId = validateTemplateId(req.body?.templateId, project.templateId);
      const branding = normalizeBranding(req.body?.branding, project.branding);
      const rawBox =
        req.body?.facecamBox !== undefined
          ? req.body.facecamBox
          : seg.hasCustomFacecam
            ? seg.facecamBox
            : (seg.facecamBox ?? project.sharedFacecamBox);
      const facecamBox =
        rawBox && typeof rawBox === 'object' ? clampFacecamBox(rawBox as FacecamBox) : null;

      if (layoutUsesFacecam(layoutId) && !facecamBox) {
        return res.status(400).json({
          error: 'Draw a facecam box on Panel 1 to preview facecam-based layouts.',
        });
      }

      const hookTagline =
        typeof req.body?.hookTagline === 'string'
          ? req.body.hookTagline
          : seg.hookTagline || seg.title;

      const jpgBuffer = await renderLayoutPreviewFrame({
        inputImagePath,
        layoutId,
        templateId,
        facecamBox,
        branding,
        hookTagline,
        outWidth: 540,
        outHeight: 960,
      });

      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(jpgBuffer);
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not render 9:16 preview frame.',
      });
    }
  });

  app.post('/api/projects/:id/segments/:segmentId/preview-video', async (req, res) => {
    try {
      const project = getProject(req.params.id);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      const seg = project.segments.find((s) => s.id === req.params.segmentId);
      if (!seg || !seg.sourceFileName) {
        return res.status(404).json({ error: 'Segment has not been downloaded yet.' });
      }
      const segPath = resolveSafeSourcePath(seg.sourceFileName);
      if (!fs.existsSync(segPath)) {
        return res.status(404).json({ error: 'Segment source file missing on disk.' });
      }

      const layoutId = validateLayoutId(
        req.body?.layoutId,
        seg.hasCustomLayout ? seg.layoutId : project.sharedLayoutId
      );
      const templateId = validateTemplateId(req.body?.templateId, project.templateId);
      const branding = normalizeBranding(req.body?.branding, project.branding);
      const rawBox =
        req.body?.facecamBox !== undefined
          ? req.body.facecamBox
          : seg.hasCustomFacecam
            ? seg.facecamBox
            : (seg.facecamBox ?? project.sharedFacecamBox);
      const facecamBox =
        rawBox && typeof rawBox === 'object' ? clampFacecamBox(rawBox as FacecamBox) : null;

      if (layoutUsesFacecam(layoutId) && !facecamBox) {
        return res.status(400).json({
          error: 'Draw and save a facecam region before generating a 9:16 video preview.',
        });
      }

      const hookTagline =
        typeof req.body?.hookTagline === 'string'
          ? req.body.hookTagline
          : seg.hookTagline || seg.title;

      const previewUrl = await renderPreviewVideo({
        projectId: project.id,
        segmentId: seg.id,
        inputFilePath: segPath,
        layoutId,
        templateId,
        facecamBox,
        branding,
        hookTagline,
      });

      res.json({ previewUrl });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not render 9:16 video preview.',
      });
    }
  });

  // --- Phase E: Render Selected or All Segments ---

  app.post('/api/projects/:id/render', (req, res) => {
    try {
      const segmentIds = Array.isArray(req.body?.segmentIds)
        ? (req.body.segmentIds as string[])
        : undefined;
      const result = startSegmentRenders(req.params.id, segmentIds);
      const project = getProject(req.params.id);
      res.status(202).json({ ...result, project });
    } catch (err) {
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Could not start rendering.',
      });
    }
  });

  // --- Persistent Clips & Storage Status ---

  app.get('/api/storage/status', (_req, res) => {
    res.json(getStorageStatus());
  });

  app.get('/api/clips', (_req, res) => {
    res.json({ clips: listClips() });
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
      tags: Array.isArray(req.body?.tags)
        ? req.body.tags.map((t: unknown) => String(t).slice(0, 40))
        : existing.tags,
      alternativeTitles: Array.isArray(req.body?.alternativeTitles)
        ? req.body.alternativeTitles.map((t: unknown) => String(t).slice(0, 100))
        : existing.alternativeTitles,
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

  // --- Safe Path-Confined Media Routes ---

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

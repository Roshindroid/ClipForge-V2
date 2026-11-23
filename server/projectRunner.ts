import crypto from 'node:crypto';
import fs from 'node:fs';
import type {
  ClipProject,
  FacecamBox,
  LayoutId,
  ProjectSegment,
  RenderedClip,
} from '../src/types.ts';
import { downloadProjectSegmentFile } from './ingest.ts';
import {
  clampFacecamBox,
  layoutUsesFacecam,
  renderSegmentClipV2,
} from './rendererV2.ts';
import {
  getProject,
  resolveSafeSourcePath,
  sanitizeFileSlug,
  saveClip,
  saveProject,
} from './storage.ts';

const activeDownloads = new Set<string>();
const activeRenders = new Set<string>();

function updateSegmentInProject(
  projectId: string,
  segmentId: string,
  patch: Partial<ProjectSegment>
): ClipProject | undefined {
  const latest = getProject(projectId);
  if (!latest) return undefined;
  const updated: ClipProject = {
    ...latest,
    segments: latest.segments.map((s) => (s.id === segmentId ? { ...s, ...patch } : s)),
  };
  return saveProject(updated);
}

/**
 * Phase C: Downloads ONLY the requested timestamp slices into workspace/sources/<projectId>/.
 * Never runs automatic facecam detection and never triggers rendering.
 */
export function startSegmentDownloads(
  projectId: string,
  requestedSegmentIds?: string[]
): { startedCount: number; alreadyActive: boolean } {
  const project = getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const targets = project.segments.filter((seg) => {
    if (activeDownloads.has(seg.id)) return false;
    if (requestedSegmentIds && requestedSegmentIds.length > 0) {
      if (!requestedSegmentIds.includes(seg.id)) return false;
      // Only skip if already ready and verified on disk
      if (seg.downloadStatus === 'ready' && seg.sourceFileName) {
        try {
          const p = resolveSafeSourcePath(seg.sourceFileName);
          if (fs.existsSync(p) && fs.statSync(p).size > 4096) return false;
        } catch {
          // re-download
        }
      }
      return true;
    }
    return seg.downloadStatus !== 'ready';
  });

  if (targets.length === 0) {
    const anyRunning = project.segments.some((s) => activeDownloads.has(s.id));
    return { startedCount: 0, alreadyActive: anyRunning };
  }

  for (const seg of targets) {
    activeDownloads.add(seg.id);
    updateSegmentInProject(projectId, seg.id, {
      downloadStatus: 'downloading',
      downloadProgress: 2,
      downloadError: undefined,
    });
  }

  (async () => {
    for (const target of targets) {
      try {
        const latestProj = getProject(projectId);
        const latestSeg = latestProj?.segments.find((s) => s.id === target.id);
        if (!latestProj || !latestSeg) continue;

        const dl = await downloadProjectSegmentFile({
          projectId: latestProj.id,
          segmentId: latestSeg.id,
          order: latestSeg.order,
          sourceUrl: latestProj.sourceUrl,
          sourceType: latestProj.sourceType,
          startSeconds: latestSeg.startSeconds,
          endSeconds: latestSeg.endSeconds,
          onProgress: (pct) => {
            updateSegmentInProject(projectId, latestSeg.id, {
              downloadStatus: 'downloading',
              downloadProgress: Math.max(5, Math.min(95, Math.round(pct))),
            });
          },
        });

        updateSegmentInProject(projectId, latestSeg.id, {
          downloadStatus: 'ready',
          downloadProgress: 100,
          downloadError: undefined,
          sourceFileName: dl.sourceFileName,
          sourceSizeBytes: dl.sourceSizeBytes,
          frameUrl: dl.frameUrl,
          width: dl.width,
          height: dl.height,
          fps: dl.fps,
          hasAudio: dl.hasAudio,
        });
      } catch (err) {
        updateSegmentInProject(projectId, target.id, {
          downloadStatus: 'error',
          downloadProgress: 0,
          downloadError: err instanceof Error ? err.message : 'Segment download failed',
        });
      } finally {
        activeDownloads.delete(target.id);
      }
    }
  })().catch((err) => {
    console.error(`[DownloadRunner ${projectId}] Unexpected error:`, err);
  });

  return { startedCount: targets.length, alreadyActive: false };
}

export function resolveSegmentEffectiveSettings(
  project: ClipProject,
  seg: ProjectSegment
): { layoutId: LayoutId; facecamBox: FacecamBox | null } {
  const layoutId: LayoutId = seg.hasCustomLayout ? seg.layoutId : project.sharedLayoutId;
  const rawCam = seg.hasCustomFacecam
    ? seg.facecamBox
    : (seg.facecamBox ?? project.sharedFacecamBox);
  const facecamBox = rawCam ? clampFacecamBox(rawCam) : null;
  return { layoutId, facecamBox };
}

/**
 * Phase E: Renders selected or all downloaded segments into vertical 9:16 MP4 clips,
 * enforcing manual facecam selection for facecam-dependent layouts.
 */
export function startSegmentRenders(
  projectId: string,
  requestedSegmentIds?: string[]
): { queuedCount: number } {
  const project = getProject(projectId);
  if (!project) {
    throw new Error('Project not found');
  }

  const targets = project.segments.filter((seg) => {
    if (requestedSegmentIds && requestedSegmentIds.length > 0) {
      return requestedSegmentIds.includes(seg.id);
    }
    return seg.downloadStatus === 'ready';
  });

  if (targets.length === 0) {
    throw new Error('Select at least one downloaded segment to render.');
  }

  // Validate all targets BEFORE queueing
  for (const seg of targets) {
    if (activeRenders.has(seg.id)) {
      throw new Error(`Segment #${seg.order} ("${seg.title}") is already rendering.`);
    }
    if (seg.downloadStatus !== 'ready' || !seg.sourceFileName) {
      throw new Error(
        `Segment #${seg.order} ("${seg.title}") has not finished downloading yet.`
      );
    }
    const segPath = resolveSafeSourcePath(seg.sourceFileName);
    if (!fs.existsSync(segPath) || fs.statSync(segPath).size < 4096) {
      throw new Error(
        `Source file for segment #${seg.order} is missing. Retry segment download first.`
      );
    }
    const { layoutId, facecamBox } = resolveSegmentEffectiveSettings(project, seg);
    if (layoutUsesFacecam(layoutId) && !facecamBox) {
      throw new Error(
        `Segment #${seg.order} ("${seg.title}") uses layout "${layoutId}", which requires a saved manual facecam region. Draw and save the facecam box first, or switch to Center Crop.`
      );
    }
  }

  for (const seg of targets) {
    activeRenders.add(seg.id);
    updateSegmentInProject(projectId, seg.id, {
      renderStatus: 'queued',
      renderProgress: 0,
      renderError: undefined,
    });
  }

  (async () => {
    for (const target of targets) {
      try {
        const latestProj = getProject(projectId);
        const latestSeg = latestProj?.segments.find((s) => s.id === target.id);
        if (!latestProj || !latestSeg || !latestSeg.sourceFileName) continue;

        const segPath = resolveSafeSourcePath(latestSeg.sourceFileName);
        const { layoutId, facecamBox } = resolveSegmentEffectiveSettings(latestProj, latestSeg);

        updateSegmentInProject(projectId, latestSeg.id, {
          renderStatus: 'rendering',
          renderProgress: 5,
          renderError: undefined,
        });

        const slug = sanitizeFileSlug(latestSeg.title || `clip_${latestSeg.order}`, 28);
        const shortHash = crypto.randomBytes(3).toString('hex');
        const outputFileName = `${slug}_${String(latestSeg.order).padStart(3, '0')}_${shortHash}.mp4`;

        const renderRes = await renderSegmentClipV2({
          inputFilePath: segPath,
          outputFileName,
          layoutId,
          templateId: latestProj.templateId,
          facecamBox,
          branding: latestProj.branding,
          hookTagline: latestSeg.hookTagline || latestSeg.title,
          resolution: latestProj.resolution,
          frameRate: latestProj.frameRate,
          onProgress: (pct) => {
            updateSegmentInProject(projectId, latestSeg.id, {
              renderStatus: 'rendering',
              renderProgress: Math.max(5, Math.min(99, Math.round(pct))),
            });
          },
        });

        const clip: RenderedClip = {
          id: `clip_${crypto.randomBytes(6).toString('hex')}`,
          projectId: latestProj.id,
          segmentId: latestSeg.id,
          title: latestSeg.title || `Clip #${latestSeg.order}`,
          hookTagline: latestSeg.hookTagline || latestSeg.title || '',
          description: `Clipped from ${latestProj.title}.`,
          hashtags: ['#shorts', '#highlights'],
          tags: ['shorts', 'highlights'],
          layoutId,
          templateId: latestProj.templateId,
          facecamBox,
          branding: latestProj.branding,
          burnedCaptions: false,
          encoderUsed: renderRes.encoderUsed,
          outputFileName: renderRes.outputFileName,
          downloadUrl: renderRes.downloadUrl,
          durationSec: renderRes.durationSec,
          resolution: renderRes.resolution,
          fileSizeBytes: renderRes.fileSizeBytes,
          createdAt: new Date().toISOString(),
          youtubeStatus: 'ready',
        };

        saveClip(clip);

        updateSegmentInProject(projectId, latestSeg.id, {
          renderStatus: 'completed',
          renderProgress: 100,
          renderError: undefined,
          renderedClipId: clip.id,
        });
      } catch (err) {
        updateSegmentInProject(projectId, target.id, {
          renderStatus: 'failed',
          renderProgress: 0,
          renderError: err instanceof Error ? err.message : 'Render failed',
        });
      } finally {
        activeRenders.delete(target.id);
      }
    }
  })().catch((err) => {
    console.error(`[RenderRunner ${projectId}] Unexpected error:`, err);
  });

  return { queuedCount: targets.length };
}

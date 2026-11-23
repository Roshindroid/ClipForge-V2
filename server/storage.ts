import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ClipProject,
  RenderedClip,
  StorageStatus,
} from '../src/types.ts';

export const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
export const PROJECTS_DIR = path.join(WORKSPACE_ROOT, 'projects');
export const SOURCES_DIR = process.env.CLIPFORGE_SOURCES_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_SOURCES_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'sources');
export const FRAMES_DIR = path.join(WORKSPACE_ROOT, 'frames');
export const RENDERS_DIR = process.env.CLIPFORGE_RENDERS_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_RENDERS_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'renders');

const PROJECTS_FILE = path.join(WORKSPACE_ROOT, 'projects.json');
const CLIPS_FILE = path.join(WORKSPACE_ROOT, 'clips.json');

export function ensureWorkspace(): void {
  for (const dir of [WORKSPACE_ROOT, PROJECTS_DIR, SOURCES_DIR, FRAMES_DIR, RENDERS_DIR]) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }
  if (!fs.existsSync(PROJECTS_FILE)) {
    fs.writeFileSync(PROJECTS_FILE, '[]', 'utf8');
  }
  if (!fs.existsSync(CLIPS_FILE)) {
    fs.writeFileSync(CLIPS_FILE, '[]', 'utf8');
  }
}

export function sanitizeFolderName(raw?: string): string {
  if (!raw) return '';
  return raw
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) =>
      seg
        .replace(/[^a-zA-Z0-9._ -]/g, '_')
        .replace(/\.\./g, '')
        .replace(/^\.+/, '')
        .trim()
    )
    .filter((seg) => seg && seg !== '.' && seg !== '..')
    .slice(0, 2)
    .join('/');
}

export function sanitizeFileSlug(raw: string, maxLen = 48): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
  return cleaned || 'video';
}

export function resolveSafeChildPath(baseDir: string, unsafeFileName: string): string {
  const cleanName = path.basename(unsafeFileName);
  if (!cleanName || cleanName === '.' || cleanName === '..') {
    throw new Error('Invalid filename');
  }
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(resolvedBase, cleanName);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return resolvedTarget;
}

export function resolveSafeSourcePath(unsafeRelativePath: string): string {
  const normalized = unsafeRelativePath.replace(/\\/g, '/').replace(/^\/+/, '');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length === 0 || parts.some((p) => p === '.' || p === '..')) {
    throw new Error('Invalid source path');
  }
  const resolvedBase = path.resolve(SOURCES_DIR);
  const resolvedTarget = path.resolve(resolvedBase, ...parts);
  if (!resolvedTarget.startsWith(resolvedBase + path.sep)) {
    throw new Error('Path traversal blocked');
  }
  return resolvedTarget;
}

function readJson<T>(filePath: string, fallback: T): T {
  try {
    ensureWorkspace();
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, ms);
}

function writeJsonAtomic<T>(filePath: string, data: T): void {
  ensureWorkspace();
  const tmpPath = `${filePath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
  try {
    // Windows: OneDrive/AV/indexer holds transient locks that make rename() fail with EPERM.
    for (let attempt = 0; ; attempt++) {
      try {
        fs.renameSync(tmpPath, filePath);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const transient = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY' || code === 'ENOTEMPTY';
        if (!transient || attempt >= 7) throw err;
        sleepSync(40 * (attempt + 1));
      }
    }
  } catch {
    // Fallback: overwrite the destination in place, then drop the temp file.
    try {
      fs.copyFileSync(tmpPath, filePath);
    } finally {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // best-effort temp cleanup
      }
    }
  }
}

function removeEmptySourceSubdir(filePath: string): void {
  const resolvedBase = path.resolve(SOURCES_DIR);
  let current = path.dirname(path.resolve(filePath));
  while (current !== resolvedBase && current.startsWith(resolvedBase + path.sep)) {
    try {
      const entries = fs.readdirSync(current);
      if (entries.length === 0) {
        fs.rmdirSync(current);
        current = path.dirname(current);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

function syncRenderedClipsWithDisk(rawClips: RenderedClip[]): {
  clips: RenderedClip[];
  changed: boolean;
} {
  let changed = false;
  const verified: RenderedClip[] = [];

  for (const clip of rawClips) {
    if (!clip || !clip.outputFileName) {
      changed = true;
      continue;
    }
    try {
      const outPath = resolveSafeChildPath(RENDERS_DIR, clip.outputFileName);
      if (!fs.existsSync(outPath)) {
        changed = true;
        continue;
      }
      const size = fs.statSync(outPath).size;
      if (size < 4096) {
        changed = true;
        continue;
      }
      const nextClip =
        clip.fileSizeBytes !== size ? { ...clip, fileSizeBytes: size } : clip;
      if (nextClip !== clip) changed = true;
      verified.push(nextClip);
    } catch {
      changed = true;
    }
  }

  return { clips: verified, changed };
}

function reconcileProjectWithDisk(
  project: ClipProject,
  validClipIds: Set<string>,
  isBootRecovery: boolean
): { project: ClipProject; changed: boolean } {
  let changed = false;

  const nextSegments = (project.segments || []).map((seg) => {
    let updated = seg;

    // Verify downloaded source file on disk
    if (updated.sourceFileName) {
      try {
        const segPath = resolveSafeSourcePath(updated.sourceFileName);
        if (fs.existsSync(segPath) && fs.statSync(segPath).size > 4096) {
          const diskSize = fs.statSync(segPath).size;
          if (updated.downloadStatus !== 'ready' || updated.sourceSizeBytes !== diskSize) {
            updated = {
              ...updated,
              downloadStatus: 'ready',
              downloadProgress: 100,
              sourceSizeBytes: diskSize,
              downloadError: undefined,
            };
            changed = true;
          }
        } else if (updated.downloadStatus === 'ready') {
          updated = {
            ...updated,
            downloadStatus: 'interrupted',
            downloadProgress: 0,
            sourceSizeBytes: 0,
            downloadError: 'Source segment file not found on disk. Click Retry to re-download.',
          };
          changed = true;
        }
      } catch {
        // ignore invalid path
      }
    }

    // Handle interrupted downloads on server restart
    if (isBootRecovery && updated.downloadStatus === 'downloading') {
      updated = {
        ...updated,
        downloadStatus: 'interrupted',
        downloadProgress: 0,
        downloadError: 'Download was interrupted when the server closed. Click Retry to resume.',
      };
      changed = true;
    }

    // Verify frame URL still exists on disk if referenced
    if (updated.frameUrl && updated.frameUrl.startsWith('/api/frames/')) {
      const frameFile = updated.frameUrl.replace('/api/frames/', '');
      try {
        const framePath = resolveSafeChildPath(FRAMES_DIR, frameFile);
        if (!fs.existsSync(framePath)) {
          updated = { ...updated, frameUrl: undefined };
          changed = true;
        }
      } catch {
        updated = { ...updated, frameUrl: undefined };
        changed = true;
      }
    }

    // Handle interrupted renders on server restart
    if (isBootRecovery && (updated.renderStatus === 'rendering' || updated.renderStatus === 'queued')) {
      updated = {
        ...updated,
        renderStatus: 'interrupted',
        renderProgress: 0,
        renderError: 'Render was interrupted when the server closed. Click Render to retry.',
      };
      changed = true;
    }

    // Ensure renderedClipId still maps to a verified clip on disk
    if (updated.renderedClipId && !validClipIds.has(updated.renderedClipId)) {
      updated = {
        ...updated,
        renderedClipId: undefined,
        renderStatus: updated.renderStatus === 'completed' ? 'idle' : updated.renderStatus,
        renderProgress: updated.renderStatus === 'completed' ? 0 : updated.renderProgress,
      };
      changed = true;
    }

    return updated;
  });

  if (changed) {
    return {
      project: { ...project, segments: nextSegments },
      changed: true,
    };
  }
  return { project, changed: false };
}

/**
 * Restores and verifies persistent workspace projects and rendered clips on server startup.
 * Marks any in-flight downloads/renders from a previous run as interrupted while preserving
 * all completed clips and downloaded segment files.
 */
export function restoreWorkspaceOnBoot(): void {
  ensureWorkspace();
  const rawClips = readJson<RenderedClip[]>(CLIPS_FILE, []);
  const { clips, changed: clipsChanged } = syncRenderedClipsWithDisk(rawClips);
  if (clipsChanged) {
    writeJsonAtomic(CLIPS_FILE, clips);
  }

  const validClipIds = new Set(clips.map((c) => c.id));
  const rawProjects = readJson<ClipProject[]>(PROJECTS_FILE, []);
  const validProjects = rawProjects.filter((p) => p && Array.isArray(p.segments));
  let projectsChanged = validProjects.length !== rawProjects.length;

  const reconciled = validProjects.map((p) => {
    const res = reconcileProjectWithDisk(p, validClipIds, true);
    if (res.changed) projectsChanged = true;
    // Also mirror per-project JSON in workspace/projects/<id>.json for durability
    try {
      const perProjPath = resolveSafeChildPath(PROJECTS_DIR, `${res.project.id}.json`);
      writeJsonAtomic(perProjPath, res.project);
    } catch {
      // ignore mirror write issue
    }
    return res.project;
  });

  if (projectsChanged) {
    writeJsonAtomic(PROJECTS_FILE, reconciled);
  }
}

export function listProjects(): ClipProject[] {
  const rawClips = listClips();
  const validClipIds = new Set(rawClips.map((c) => c.id));
  const raw = readJson<ClipProject[]>(PROJECTS_FILE, []);
  const valid = raw.filter((p) => p && Array.isArray(p.segments));
  let anyChanged = valid.length !== raw.length;

  const synced = valid.map((p) => {
    const res = reconcileProjectWithDisk(p, validClipIds, false);
    if (res.changed) anyChanged = true;
    return res.project;
  });

  if (anyChanged) {
    writeJsonAtomic(PROJECTS_FILE, synced);
  }
  return synced;
}

export function getProject(projectId: string): ClipProject | undefined {
  return listProjects().find((p) => p.id === projectId);
}

export function saveProject(project: ClipProject): ClipProject {
  const all = readJson<ClipProject[]>(PROJECTS_FILE, []).filter(
    (p) => p && Array.isArray(p.segments)
  );
  const nextProject: ClipProject = {
    ...project,
    updatedAt: new Date().toISOString(),
  };
  const idx = all.findIndex((p) => p.id === nextProject.id);
  if (idx >= 0) {
    all[idx] = nextProject;
  } else {
    all.unshift(nextProject);
  }
  writeJsonAtomic(PROJECTS_FILE, all);
  try {
    const perProjPath = resolveSafeChildPath(PROJECTS_DIR, `${nextProject.id}.json`);
    writeJsonAtomic(perProjPath, nextProject);
  } catch {
    // ignore mirror write issue
  }
  return nextProject;
}

export function deleteProject(
  projectId: string,
  options?: { deleteClips?: boolean }
): { deleted: boolean; deletedClipCount: number } {
  const all = listProjects();
  const target = all.find((p) => p.id === projectId);
  if (!target) return { deleted: false, deletedClipCount: 0 };

  const remaining = all.filter((p) => p.id !== projectId);
  writeJsonAtomic(PROJECTS_FILE, remaining);

  try {
    const perProjPath = resolveSafeChildPath(PROJECTS_DIR, `${projectId}.json`);
    if (fs.existsSync(perProjPath)) fs.unlinkSync(perProjPath);
  } catch {
    // ignore
  }

  // Delete project's source segments from workspace/sources
  for (const seg of target.segments) {
    if (seg.sourceFileName) {
      try {
        const segPath = resolveSafeSourcePath(seg.sourceFileName);
        if (fs.existsSync(segPath)) {
          fs.unlinkSync(segPath);
          removeEmptySourceSubdir(segPath);
        }
      } catch {
        // ignore
      }
    }
  }

  // Also remove project directory in workspace/sources if empty or remaining
  try {
    const projSourceDir = resolveSafeSourcePath(projectId);
    if (fs.existsSync(projSourceDir)) {
      fs.rmSync(projSourceDir, { recursive: true, force: true });
    }
  } catch {
    // ignore
  }

  // Delete cached frames for this project
  try {
    if (fs.existsSync(FRAMES_DIR)) {
      for (const file of fs.readdirSync(FRAMES_DIR)) {
        if (file.startsWith(`${projectId}_`) || file.startsWith(`preview_${projectId}_`)) {
          fs.unlinkSync(path.join(FRAMES_DIR, file));
        }
      }
    }
  } catch {
    // ignore
  }

  let deletedClipCount = 0;
  if (options?.deleteClips) {
    const allClips = listClips();
    const toDelete = allClips.filter((c) => c.projectId === projectId);
    const keepClips = allClips.filter((c) => c.projectId !== projectId);
    for (const c of toDelete) {
      try {
        const outPath = resolveSafeChildPath(RENDERS_DIR, c.outputFileName);
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
      } catch {
        // ignore
      }
      deletedClipCount++;
    }
    writeJsonAtomic(CLIPS_FILE, keepClips);
  }

  return { deleted: true, deletedClipCount };
}

/**
 * Deletes downloaded segment source files from workspace/sources/<projectId>/ to free disk space
 * while keeping the project record and all finished rendered clips in workspace/renders/ intact.
 */
export function clearProjectSources(
  projectId: string,
  segmentIds?: string[]
): { project?: ClipProject; freedBytes: number } {
  const project = getProject(projectId);
  if (!project) return { freedBytes: 0 };

  const targetAll = !segmentIds || segmentIds.length === 0;
  const targetSet = new Set(segmentIds || []);
  let freedBytes = 0;

  const nextSegments = project.segments.map((seg) => {
    if (!targetAll && !targetSet.has(seg.id)) return seg;
    if (seg.downloadStatus === 'downloading' || seg.renderStatus === 'rendering' || seg.renderStatus === 'queued') {
      return seg;
    }

    if (seg.sourceFileName) {
      try {
        const segPath = resolveSafeSourcePath(seg.sourceFileName);
        if (fs.existsSync(segPath)) {
          freedBytes += fs.statSync(segPath).size;
          fs.unlinkSync(segPath);
          removeEmptySourceSubdir(segPath);
        }
      } catch {
        // ignore invalid path
      }
    }

    return {
      ...seg,
      downloadStatus: 'pending' as const,
      downloadProgress: 0,
      downloadError: undefined,
      sourceFileName: undefined,
      sourceSizeBytes: 0,
    };
  });

  const saved = saveProject({ ...project, segments: nextSegments });
  return { project: saved, freedBytes };
}

export function listClips(): RenderedClip[] {
  const raw = readJson<RenderedClip[]>(CLIPS_FILE, []);
  const { clips, changed } = syncRenderedClipsWithDisk(raw);
  if (changed) {
    writeJsonAtomic(CLIPS_FILE, clips);
  }
  return clips;
}

export function getClip(clipId: string): RenderedClip | undefined {
  return listClips().find((c) => c.id === clipId);
}

export function saveClip(clip: RenderedClip): RenderedClip {
  const all = listClips();
  const idx = all.findIndex((c) => c.id === clip.id);
  if (idx >= 0) {
    all[idx] = clip;
  } else {
    all.unshift(clip);
  }
  writeJsonAtomic(CLIPS_FILE, all);
  return clip;
}

export function deleteClip(clipId: string): boolean {
  const all = listClips();
  const target = all.find((c) => c.id === clipId);
  if (!target) return false;

  writeJsonAtomic(
    CLIPS_FILE,
    all.filter((c) => c.id !== clipId)
  );

  try {
    const outPath = resolveSafeChildPath(RENDERS_DIR, target.outputFileName);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch {
    // ignore
  }

  // Clear renderedClipId reference on any project segment without touching its downloaded source
  const projects = readJson<ClipProject[]>(PROJECTS_FILE, []);
  let projUpdated = false;
  const nextProjects = projects.map((p) => {
    if (p.id !== target.projectId) return p;
    const nextSegs = (p.segments || []).map((s) => {
      if (s.renderedClipId === clipId) {
        projUpdated = true;
        return { ...s, renderedClipId: undefined, renderStatus: 'idle' as const, renderProgress: 0 };
      }
      return s;
    });
    return { ...p, segments: nextSegs };
  });
  if (projUpdated) {
    writeJsonAtomic(PROJECTS_FILE, nextProjects);
  }

  return true;
}

function walkDirBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += walkDirBytes(full);
    } else if (entry.isFile()) {
      total += fs.statSync(full).size;
    }
  }
  return total;
}

export function getStorageStatus(): StorageStatus {
  ensureWorkspace();
  const projects = listProjects();
  const clips = listClips();
  let activeSegmentCount = 0;
  for (const p of projects) {
    for (const s of p.segments) {
      if (s.downloadStatus === 'ready' && (s.sourceSizeBytes || 0) > 0) {
        activeSegmentCount++;
      }
    }
  }
  return {
    sourcesDir: 'workspace/sources',
    rendersDir: 'workspace/renders',
    totalSourceBytes: walkDirBytes(SOURCES_DIR),
    totalRenderBytes: walkDirBytes(RENDERS_DIR),
    activeSegmentCount,
    totalClipCount: clips.length,
  };
}

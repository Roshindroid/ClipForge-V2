import fs from 'node:fs';
import path from 'node:path';
import type {
  AppSettings,
  RenderedClip,
  StorageStatus,
  VideoProject,
} from '../src/types.ts';

export const WORKSPACE_ROOT = path.resolve(process.cwd(), 'workspace');
export const SOURCES_DIR = process.env.CLIPFORGE_SOURCES_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_SOURCES_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'sources');
export const FRAMES_DIR = path.join(WORKSPACE_ROOT, 'frames');
export const RENDERS_DIR = process.env.CLIPFORGE_RENDERS_DIR?.trim()
  ? path.resolve(process.env.CLIPFORGE_RENDERS_DIR.trim())
  : path.join(WORKSPACE_ROOT, 'renders');

const PROJECTS_FILE = path.join(WORKSPACE_ROOT, 'projects.json');
const CLIPS_FILE = path.join(WORKSPACE_ROOT, 'clips.json');
const SETTINGS_FILE = path.join(WORKSPACE_ROOT, 'settings.json');

export const DEFAULT_SETTINGS: AppSettings = {
  autoPruneSourceVod: true,
};

export function ensureWorkspace(): void {
  for (const dir of [WORKSPACE_ROOT, SOURCES_DIR, FRAMES_DIR, RENDERS_DIR]) {
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
  if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(DEFAULT_SETTINGS, null, 2), 'utf8');
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

function writeJson<T>(filePath: string, data: T): void {
  ensureWorkspace();
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
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

function syncProjectWithDisk(project: VideoProject): { project: VideoProject; changed: boolean } {
  let changed = false;
  let nextProject = project;

  if (project.sourceMode === 'local' && project.fileName) {
    try {
      const srcPath = resolveSafeSourcePath(project.fileName);
      const exists = fs.existsSync(srcPath);
      if (!exists && !project.sourceDeleted) {
        nextProject = { ...nextProject, sourceDeleted: true, sourceSizeBytes: 0 };
        changed = true;
      } else if (exists) {
        const size = fs.statSync(srcPath).size;
        if (nextProject.sourceDeleted || nextProject.sourceSizeBytes !== size) {
          nextProject = { ...nextProject, sourceDeleted: false, sourceSizeBytes: size };
          changed = true;
        }
      }
    } catch {
      // ignore malformed path
    }
  }

  let momentsChanged = false;
  const syncedMoments = nextProject.moments.map((m) => {
    if (!m.segmentFileName) {
      return m;
    }
    try {
      const segPath = resolveSafeSourcePath(m.segmentFileName);
      const exists = fs.existsSync(segPath);
      if (!exists && m.segmentStatus === 'ready') {
        momentsChanged = true;
        return { ...m, segmentStatus: 'pruned' as const, segmentSizeBytes: 0 };
      }
      if (exists) {
        const size = fs.statSync(segPath).size;
        if (m.segmentStatus !== 'ready' || m.segmentSizeBytes !== size) {
          momentsChanged = true;
          return { ...m, segmentStatus: 'ready' as const, segmentSizeBytes: size };
        }
      }
    } catch {
      // ignore
    }
    return m;
  });

  if (momentsChanged) {
    nextProject = { ...nextProject, moments: syncedMoments };
    changed = true;
  }

  return { project: nextProject, changed };
}

export function listProjects(): VideoProject[] {
  const raw = readJson<VideoProject[]>(PROJECTS_FILE, []);
  let anyChanged = false;
  const synced = raw.map((p) => {
    const res = syncProjectWithDisk(p);
    if (res.changed) anyChanged = true;
    return res.project;
  });
  if (anyChanged) {
    writeJson(PROJECTS_FILE, synced);
  }
  return synced;
}

export function getProject(projectId: string): VideoProject | undefined {
  return listProjects().find((p) => p.id === projectId);
}

export function saveProject(project: VideoProject): VideoProject {
  const all = readJson<VideoProject[]>(PROJECTS_FILE, []);
  const idx = all.findIndex((p) => p.id === project.id);
  if (idx >= 0) {
    all[idx] = project;
  } else {
    all.unshift(project);
  }
  writeJson(PROJECTS_FILE, all);
  return project;
}

function cleanupProjectPreviewSlices(projectId: string): number {
  let freed = 0;
  try {
    if (fs.existsSync(FRAMES_DIR)) {
      for (const file of fs.readdirSync(FRAMES_DIR)) {
        if (file.startsWith(`preview_${projectId}_`)) {
          const full = path.join(FRAMES_DIR, file);
          freed += fs.statSync(full).size;
          fs.unlinkSync(full);
        }
      }
    }
  } catch {
    // ignore cleanup errors
  }
  return freed;
}

export function cleanupProjectSource(projectId: string): {
  project: VideoProject | null;
  freedBytes: number;
} {
  const target = getProject(projectId);
  if (!target) return { project: null, freedBytes: 0 };

  let freedBytes = 0;
  if (target.sourceMode === 'local' && target.fileName) {
    try {
      const srcPath = resolveSafeSourcePath(target.fileName);
      if (fs.existsSync(srcPath)) {
        freedBytes += fs.statSync(srcPath).size;
        fs.unlinkSync(srcPath);
        removeEmptySourceSubdir(srcPath);
      }
    } catch {
      // ignore
    }
  }

  const nextMoments = target.moments.map((m) => {
    if (m.segmentFileName) {
      try {
        const segPath = resolveSafeSourcePath(m.segmentFileName);
        if (fs.existsSync(segPath)) {
          freedBytes += fs.statSync(segPath).size;
          fs.unlinkSync(segPath);
          removeEmptySourceSubdir(segPath);
        }
      } catch {
        // ignore
      }
      return {
        ...m,
        segmentStatus: m.segmentStatus === 'ready' ? ('pruned' as const) : m.segmentStatus,
        segmentSizeBytes: 0,
      };
    }
    return m;
  });

  freedBytes += cleanupProjectPreviewSlices(projectId);

  const updated = saveProject({
    ...target,
    sourceDeleted: target.sourceMode === 'local' ? true : target.sourceDeleted,
    sourceSizeBytes: 0,
    moments: nextMoments,
  });
  return { project: updated, freedBytes };
}

export function pruneAllDownloadedSources(): {
  projects: VideoProject[];
  freedBytes: number;
} {
  const all = listProjects();
  let freedBytes = 0;
  const updatedProjects = all.map((proj) => {
    if (proj.sourceMode === 'local' && proj.fileName) {
      try {
        const srcPath = resolveSafeSourcePath(proj.fileName);
        if (fs.existsSync(srcPath)) {
          freedBytes += fs.statSync(srcPath).size;
          fs.unlinkSync(srcPath);
          removeEmptySourceSubdir(srcPath);
        }
      } catch {
        // ignore
      }
    }
    const nextMoments = proj.moments.map((m) => {
      if (m.segmentFileName) {
        try {
          const segPath = resolveSafeSourcePath(m.segmentFileName);
          if (fs.existsSync(segPath)) {
            freedBytes += fs.statSync(segPath).size;
            fs.unlinkSync(segPath);
            removeEmptySourceSubdir(segPath);
          }
        } catch {
          // ignore
        }
        return {
          ...m,
          segmentStatus: m.segmentStatus === 'ready' ? ('pruned' as const) : m.segmentStatus,
          segmentSizeBytes: 0,
        };
      }
      return m;
    });
    freedBytes += cleanupProjectPreviewSlices(proj.id);
    return {
      ...proj,
      sourceDeleted: proj.sourceMode === 'local' ? true : proj.sourceDeleted,
      sourceSizeBytes: 0,
      moments: nextMoments,
    };
  });
  writeJson(PROJECTS_FILE, updatedProjects);
  return { projects: updatedProjects, freedBytes };
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
  let activeSegmentCount = 0;
  for (const p of projects) {
    if (p.sourceMode === 'local' && !p.sourceDeleted && (p.sourceSizeBytes || 0) > 0) {
      activeSegmentCount++;
    }
    for (const m of p.moments) {
      if (m.segmentStatus === 'ready' && (m.segmentSizeBytes || 0) > 0) {
        activeSegmentCount++;
      }
    }
  }
  return {
    sourcesDir: SOURCES_DIR,
    rendersDir: RENDERS_DIR,
    totalSourceBytes: walkDirBytes(SOURCES_DIR),
    totalRenderBytes: walkDirBytes(RENDERS_DIR),
    activeSegmentCount,
  };
}

export function deleteProject(projectId: string): boolean {
  const all = listProjects();
  const target = all.find((p) => p.id === projectId);
  if (!target) return false;
  const remaining = all.filter((p) => p.id !== projectId);
  writeJson(PROJECTS_FILE, remaining);
  if (target.fileName && target.sourceMode === 'local') {
    try {
      const srcPath = resolveSafeSourcePath(target.fileName);
      if (fs.existsSync(srcPath)) {
        fs.unlinkSync(srcPath);
        removeEmptySourceSubdir(srcPath);
      }
    } catch {
      // ignore
    }
  }
  for (const m of target.moments) {
    if (m.segmentFileName) {
      try {
        const segPath = resolveSafeSourcePath(m.segmentFileName);
        if (fs.existsSync(segPath)) {
          fs.unlinkSync(segPath);
          removeEmptySourceSubdir(segPath);
        }
      } catch {
        // ignore
      }
    }
  }
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
  return true;
}

export function listClips(): RenderedClip[] {
  return readJson<RenderedClip[]>(CLIPS_FILE, []);
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
  writeJson(CLIPS_FILE, all);
  return clip;
}

export function deleteClip(clipId: string): boolean {
  const all = listClips();
  const target = all.find((c) => c.id === clipId);
  if (!target) return false;
  writeJson(
    CLIPS_FILE,
    all.filter((c) => c.id !== clipId)
  );
  try {
    const outPath = resolveSafeChildPath(RENDERS_DIR, target.outputFileName);
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch {
    // ignore
  }
  return true;
}

export function loadAppSettings(): AppSettings {
  const raw = readJson<Partial<AppSettings>>(SETTINGS_FILE, DEFAULT_SETTINGS);
  return {
    autoPruneSourceVod:
      typeof raw.autoPruneSourceVod === 'boolean'
        ? raw.autoPruneSourceVod
        : DEFAULT_SETTINGS.autoPruneSourceVod,
  };
}

export function saveAppSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadAppSettings();
  const next: AppSettings = {
    ...current,
    autoPruneSourceVod:
      typeof patch.autoPruneSourceVod === 'boolean'
        ? patch.autoPruneSourceVod
        : current.autoPruneSourceVod,
  };
  writeJson(SETTINGS_FILE, next);
  return next;
}

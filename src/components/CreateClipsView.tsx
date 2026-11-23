import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Cookie,
  Download,
  FolderOpen,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  Video,
} from 'lucide-react';
import type { ClipProject, InspectedVideoInfo } from '../types';
import {
  formatSecondsToTimecode,
  parseMultilineTimestamps,
} from '../lib/timestampParser';
import { FacecamLayoutStudio } from './FacecamLayoutStudio';

interface CreateClipsViewProps {
  projects: ClipProject[];
  activeProject: ClipProject | null;
  onSelectProject: (project: ClipProject | null) => void;
  onProjectCreated: (project: ClipProject) => void;
  onProjectUpdated: (project: ClipProject) => void;
  onProjectDeleted: (projectId: string, deleteClips: boolean) => Promise<void>;
  onGoToMyClips: () => void;
}

export function CreateClipsView({
  projects,
  activeProject,
  onSelectProject,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted,
  onGoToMyClips,
}: CreateClipsViewProps) {
  const [stage, setStage] = useState<'setup' | 'workspace'>(
    activeProject && activeProject.segments.length > 0 ? 'workspace' : 'setup'
  );

  // Stage 1 Form State
  const [videoUrl, setVideoUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<InspectedVideoInfo | null>(null);

  const [timestampsText, setTimestampsText] = useState(
    '00:00:10 - 00:00:45 Opening Highlight\n00:01:20 - 00:02:05 Best Moment'
  );
  const [creatingProject, setCreatingProject] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Cookies Modal
  const [cookiesConfigured, setCookiesConfigured] = useState(false);
  const [cookiesOpen, setCookiesOpen] = useState(false);
  const [cookiesInput, setCookiesInput] = useState('');
  const [cookiesSaving, setCookiesSaving] = useState(false);
  const [cookiesMsg, setCookiesMsg] = useState<string | null>(null);

  // Delete Project Confirmation
  const [deleteTarget, setDeleteTarget] = useState<ClipProject | null>(null);
  const [deleteWithClips, setDeleteWithClips] = useState(false);
  const [deletingProj, setDeletingProj] = useState(false);

  // Check cookie status on mount
  useEffect(() => {
    fetch('/api/ytdlp/cookies/status')
      .then((r) => r.json())
      .then((d) => setCookiesConfigured(Boolean(d.configured)))
      .catch(() => {});
  }, []);

  // Automatically enter Stage 2 workspace when active project has segments and at least 1 is downloaded or user just created & downloaded
  const anyDownloading = Boolean(
    activeProject?.segments.some((s) => s.downloadStatus === 'downloading')
  );
  const allReady = Boolean(
    activeProject &&
      activeProject.segments.length > 0 &&
      activeProject.segments.every((s) => s.downloadStatus === 'ready')
  );

  const parsedTimestamps = useMemo(
    () => parseMultilineTimestamps(timestampsText, inspected?.durationSec),
    [timestampsText, inspected?.durationSec]
  );

  const handleInspectUrl = async () => {
    const cleanUrl = videoUrl.trim();
    if (!cleanUrl) return;
    setInspecting(true);
    setInspectError(null);
    setInspected(null);
    try {
      const res = await fetch('/api/v2/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: cleanUrl }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not inspect video URL.');
      setInspected(data as InspectedVideoInfo);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Inspection failed');
    } finally {
      setInspecting(false);
    }
  };

  const handleDownloadSegments = async () => {
    if (!inspected || parsedTimestamps.hasErrors || parsedTimestamps.validCount === 0) return;
    setCreatingProject(true);
    setCreateError(null);

    try {
      const createRes = await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: inspected.title,
          sourceType: inspected.platform,
          sourceUrl: videoUrl.trim(),
          thumbnailUrl: inspected.thumbnailUrl,
          durationSec: inspected.durationSec,
          width: inspected.width,
          height: inspected.height,
          fps: inspected.fps,
          hasAudio: inspected.hasAudio,
          segments: parsedTimestamps.validSegments.map((s) => ({
            order: s.order,
            startSeconds: s.startSeconds,
            endSeconds: s.endSeconds,
            durationSeconds: s.durationSeconds,
            label: s.label,
          })),
        }),
      });
      const createData = await createRes.json();
      if (!createRes.ok || !createData.project) {
        throw new Error(createData.error || 'Could not create project.');
      }

      const createdProj = createData.project as ClipProject;
      onProjectCreated(createdProj);

      // Start downloading ONLY the requested timestamp segments
      const dlRes = await fetch(`/api/projects/${createdProj.id}/download-segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const dlData = await dlRes.json();
      if (dlRes.ok && dlData.project) {
        onProjectUpdated(dlData.project);
      }
      setStage('workspace');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Download start failed');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleCreateDemoProject = async () => {
    setCreateError(null);
    setCreatingProject(true);
    try {
      const res = await fetch('/api/projects/sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.project) throw new Error(data.error || 'Failed to create sample project');
      onProjectCreated(data.project);
      setStage('workspace');
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create demo project');
    } finally {
      setCreatingProject(false);
    }
  };

  const handleSaveCookies = async () => {
    setCookiesSaving(true);
    setCookiesMsg(null);
    try {
      const res = await fetch('/api/ytdlp/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesText: cookiesInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Invalid cookie file');
      setCookiesConfigured(Boolean(data.configured));
      setCookiesMsg('Cookies saved.');
      setTimeout(() => setCookiesOpen(false), 900);
    } catch (err) {
      setCookiesMsg(err instanceof Error ? err.message : 'Failed to save cookies');
    } finally {
      setCookiesSaving(false);
    }
  };

  const handleClearCookies = async () => {
    await fetch('/api/ytdlp/cookies', { method: 'DELETE' });
    setCookiesConfigured(false);
    setCookiesInput('');
    setCookiesMsg('Cookies removed.');
  };

  const confirmDeleteProject = async () => {
    if (!deleteTarget) return;
    setDeletingProj(true);
    try {
      await onProjectDeleted(deleteTarget.id, deleteWithClips);
      if (activeProject?.id === deleteTarget.id) {
        setStage('setup');
      }
      setDeleteTarget(null);
      setDeleteWithClips(false);
    } finally {
      setDeletingProj(false);
    }
  };

  return (
    <div className="space-y-5">
      {/* Persistent Project Bar */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <div className="flex items-center gap-2 text-xs text-[#94A3B8]">
            <FolderOpen className="w-4 h-4 text-rose-400 shrink-0" />
            <span className="font-medium text-[#CBD5E1]">Saved Projects:</span>
          </div>

          {projects.length > 0 ? (
            <select
              value={activeProject?.id || ''}
              onChange={(e) => {
                const found = projects.find((p) => p.id === e.target.value) || null;
                onSelectProject(found);
                if (found) setStage('workspace');
              }}
              className="bg-[#0E1016] border border-[#232834] rounded-lg px-3 py-1.5 text-xs font-medium text-[#F4F5F7] outline-none max-w-sm"
            >
              {projects.map((p) => {
                const ready = p.segments.filter((s) => s.downloadStatus === 'ready').length;
                return (
                  <option key={p.id} value={p.id}>
                    {p.title} ({ready}/{p.segments.length} downloaded)
                  </option>
                );
              })}
            </select>
          ) : (
            <span className="text-xs text-[#64748B]">No projects yet</span>
          )}

          {activeProject && stage === 'setup' && (
            <button
              type="button"
              onClick={() => setStage('workspace')}
              className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
            >
              Open Active Workspace →
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setCookiesOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-lg text-[#CBD5E1] cursor-pointer"
          >
            <Cookie className="w-3.5 h-3.5 text-amber-400" />
            {cookiesConfigured ? 'Cookies Active' : 'YouTube Cookies'}
          </button>

          {activeProject && (
            <button
              type="button"
              onClick={() => setDeleteTarget(activeProject)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#0E1016] hover:bg-rose-950/60 border border-[#232834] hover:border-rose-700 rounded-lg text-[#94A3B8] hover:text-rose-200 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete Project
            </button>
          )}

          <button
            type="button"
            onClick={() => setStage('setup')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-lg cursor-pointer ${
              stage === 'setup'
                ? 'bg-rose-600 text-white'
                : 'bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7]'
            }`}
          >
            <Plus className="w-3.5 h-3.5" />
            New Video URL
          </button>
        </div>
      </section>

      {/* STAGE 1: Enter Video URL + Timestamps -> Download Selected Segments */}
      {stage === 'setup' && (
        <div className="space-y-5">
          <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Step 1: Enter Video URL & Fetch Details
                </h2>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Paste a YouTube, Twitch, Kick, or direct media URL. ClipForge inspects metadata without downloading the full video.
                </p>
              </div>
              <button
                type="button"
                disabled={creatingProject}
                onClick={handleCreateDemoProject}
                className="px-3 py-1.5 text-xs font-medium bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-lg text-[#CBD5E1] cursor-pointer disabled:opacity-50"
              >
                Create Local Demo Project
              </button>
            </div>

            <div className="flex flex-col sm:flex-row gap-2.5">
              <div className="relative flex-1">
                <Link2 className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="url"
                  value={videoUrl}
                  onChange={(e) => setVideoUrl(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleInspectUrl();
                  }}
                  placeholder="https://www.youtube.com/watch?v=... or Twitch / Kick / Direct MP4 URL"
                  className="w-full pl-9 pr-3 py-2.5 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </div>
              <button
                type="button"
                disabled={inspecting || !videoUrl.trim()}
                onClick={handleInspectUrl}
                className="px-5 py-2.5 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                {inspecting ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Fetching Video...
                  </>
                ) : (
                  'Fetch Video'
                )}
              </button>
            </div>

            {inspectError && (
              <div className="px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg flex items-start gap-2">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5 text-rose-400" />
                <span>{inspectError}</span>
              </div>
            )}

            {inspected && (
              <div className="bg-[#0E1016] border border-[#232834] rounded-xl p-4 flex flex-col sm:flex-row items-start sm:items-center gap-4">
                {inspected.thumbnailUrl ? (
                  <img
                    src={inspected.thumbnailUrl}
                    alt={inspected.title}
                    className="w-40 aspect-video object-cover rounded-lg border border-[#232834] shrink-0"
                  />
                ) : (
                  <div className="w-40 aspect-video bg-[#13161D] rounded-lg border border-[#232834] flex items-center justify-center shrink-0">
                    <Video className="w-6 h-6 text-[#64748B]" />
                  </div>
                )}

                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 text-[10px] font-mono uppercase bg-rose-950/60 border border-rose-700/60 text-rose-300 rounded">
                      {inspected.platform}
                    </span>
                    <span className="text-xs font-mono text-emerald-400 inline-flex items-center gap-1">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      Ready for timestamp selection
                    </span>
                  </div>
                  <h3 className="font-display text-sm font-semibold text-[#F4F5F7] line-clamp-2">
                    {inspected.title}
                  </h3>
                  <p className="text-xs font-mono tabular-nums text-[#94A3B8]">
                    Duration: {formatSecondsToTimecode(inspected.durationSec, true)} ·{' '}
                    {inspected.width}×{inspected.height} · {inspected.fps} fps
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Timestamp Entry */}
          <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Step 2: Enter Clip Timestamps
                </h2>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  One segment per line: <span className="font-mono text-[#CBD5E1]">HH:MM:SS - HH:MM:SS Optional Clip Title</span> (supports <span className="font-mono">MM:SS</span> too).
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                {parsedTimestamps.validCount} valid segment(s) ·{' '}
                {Math.round(parsedTimestamps.totalDurationSeconds)}s total
              </span>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
              <div className="lg:col-span-6 space-y-2">
                <textarea
                  rows={7}
                  value={timestampsText}
                  onChange={(e) => setTimestampsText(e.target.value)}
                  placeholder={'00:05:20 - 00:06:05 Insane clutch\n00:12:10 - 00:12:55 Reaction moment'}
                  className="w-full px-3.5 py-2.5 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg font-mono text-xs text-[#F4F5F7] outline-none leading-relaxed"
                />

                {parsedTimestamps.lineErrors.length > 0 && (
                  <div className="space-y-1">
                    {parsedTimestamps.lineErrors.map((err) => (
                      <p
                        key={`${err.line}-${err.text}`}
                        className="text-xs text-rose-300 bg-rose-950/40 border border-rose-800/60 rounded px-2.5 py-1.5"
                      >
                        Line {err.line}: {err.message}
                      </p>
                    ))}
                  </div>
                )}

                {parsedTimestamps.warnings.length > 0 && (
                  <div className="space-y-1">
                    {parsedTimestamps.warnings.map((warn, i) => (
                      <p
                        key={`${warn.line}-${i}`}
                        className="text-xs text-amber-300 bg-amber-950/40 border border-amber-800/60 rounded px-2.5 py-1.5"
                      >
                        Line {warn.line}: {warn.message}
                      </p>
                    ))}
                  </div>
                )}
              </div>

              <div className="lg:col-span-6 bg-[#0E1016] border border-[#232834] rounded-lg p-3.5 space-y-2 max-h-[220px] overflow-y-auto">
                <div className="text-xs font-medium text-[#CBD5E1] pb-1 border-b border-[#232834]">
                  Parsed Segments Preview
                </div>
                {parsedTimestamps.validSegments.length === 0 ? (
                  <p className="text-xs text-[#64748B] py-4 text-center">
                    Enter valid start and end timestamps on the left to preview segments.
                  </p>
                ) : (
                  <div className="divide-y divide-[#1B202C]">
                    {parsedTimestamps.validSegments.map((seg) => (
                      <div
                        key={`${seg.order}-${seg.startSeconds}`}
                        className="py-2 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <span className="font-mono text-[#64748B] mr-2">#{seg.order}</span>
                          <span className="text-[#F4F5F7] font-medium">
                            {seg.label || `Clip #${seg.order}`}
                          </span>
                        </div>
                        <div className="font-mono tabular-nums text-[11px] text-[#94A3B8] shrink-0">
                          {formatSecondsToTimecode(seg.startSeconds)} –{' '}
                          {formatSecondsToTimecode(seg.endSeconds)} ({seg.durationSeconds}s)
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {createError && (
              <div className="px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
                {createError}
              </div>
            )}

            <button
              type="button"
              disabled={
                !inspected ||
                parsedTimestamps.hasErrors ||
                parsedTimestamps.validCount === 0 ||
                creatingProject
              }
              onClick={handleDownloadSegments}
              className="w-full py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors inline-flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
            >
              {creatingProject ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Starting Segment Downloads...
                </>
              ) : (
                <>
                  <Download className="w-4 h-4" />
                  Download {parsedTimestamps.validCount} Selected Segment(s)
                </>
              )}
            </button>
          </section>
        </div>
      )}

      {/* STAGE 2: Download Progress Banner (while downloading) + Manual Workspace */}
      {stage === 'workspace' && activeProject && (
        <div className="space-y-5">
          {(anyDownloading || !allReady) && (
            <section className="bg-[#13161D] border border-[#232834] rounded-xl p-4 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2 text-xs font-medium text-[#F4F5F7]">
                  {anyDownloading ? (
                    <Loader2 className="w-4 h-4 animate-spin text-rose-400" />
                  ) : (
                    <RefreshCw className="w-4 h-4 text-amber-400" />
                  )}
                  <span>
                    {anyDownloading
                      ? 'Downloading selected video segments into local workspace...'
                      : 'Some segments are not downloaded yet'}
                  </span>
                </div>
                {!anyDownloading && (
                  <button
                    type="button"
                    onClick={async () => {
                      const res = await fetch(
                        `/api/projects/${activeProject.id}/download-segments`,
                        {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({}),
                        }
                      );
                      const d = await res.json();
                      if (res.ok && d.project) onProjectUpdated(d.project);
                    }}
                    className="px-3 py-1.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
                  >
                    Download Remaining Segments
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                {activeProject.segments.map((seg) => (
                  <div
                    key={seg.id}
                    className="bg-[#0E1016] border border-[#232834] rounded-lg p-2.5 space-y-1.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-medium text-[#F4F5F7]">
                        #{seg.order} · {seg.title}
                      </span>
                      <span className="font-mono text-[11px] text-[#94A3B8]">
                        {seg.downloadStatus === 'ready'
                          ? 'Ready'
                          : seg.downloadStatus === 'downloading'
                            ? `${seg.downloadProgress}%`
                            : seg.downloadStatus}
                      </span>
                    </div>
                    <div className="h-1.5 bg-[#1C212C] rounded-full overflow-hidden">
                      <div
                        className={`h-full transition-all ${
                          seg.downloadStatus === 'ready'
                            ? 'bg-emerald-500'
                            : seg.downloadStatus === 'error' || seg.downloadStatus === 'interrupted'
                              ? 'bg-amber-500'
                              : 'bg-rose-500'
                        }`}
                        style={{
                          width: `${
                            seg.downloadStatus === 'ready' ? 100 : seg.downloadProgress
                          }%`,
                        }}
                      />
                    </div>
                    {seg.downloadError && (
                      <p className="text-[11px] text-rose-300 truncate" title={seg.downloadError}>
                        {seg.downloadError}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          <FacecamLayoutStudio
            project={activeProject}
            onProjectUpdated={onProjectUpdated}
            onGoToMyClips={onGoToMyClips}
          />
        </div>
      )}

      {stage === 'workspace' && !activeProject && (
        <div className="bg-[#13161D] border border-[#232834] rounded-xl p-10 text-center space-y-3">
          <p className="text-sm text-[#94A3B8]">Create or select a video project to start clipping.</p>
          <button
            type="button"
            onClick={() => setStage('setup')}
            className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
          >
            Enter Video URL
          </button>
        </div>
      )}

      {/* YouTube Cookies Modal */}
      {cookiesOpen && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-[#13161D] border border-[#2E3545] rounded-xl max-w-lg w-full p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
              YouTube Cookies (Netscape Format)
            </h3>
            <p className="text-xs text-[#94A3B8] leading-relaxed">
              Paste exported <span className="font-mono text-[#CBD5E1]">cookies.txt</span> contents if a YouTube video requires sign-in or bot verification. Stored locally in your workspace only.
            </p>
            <textarea
              rows={6}
              value={cookiesInput}
              onChange={(e) => setCookiesInput(e.target.value)}
              placeholder="# Netscape HTTP Cookie File"
              className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] rounded-lg font-mono text-xs text-[#F4F5F7] outline-none"
            />
            {cookiesMsg && <p className="text-xs text-emerald-300">{cookiesMsg}</p>}
            <div className="flex items-center justify-between gap-3">
              {cookiesConfigured ? (
                <button
                  type="button"
                  onClick={handleClearCookies}
                  className="px-3 py-1.5 text-xs text-rose-300 hover:text-rose-200 border border-rose-800/60 rounded-lg cursor-pointer"
                >
                  Clear Saved Cookies
                </button>
              ) : (
                <span />
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setCookiesOpen(false)}
                  className="px-4 py-2 text-xs font-medium bg-[#1C212C] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
                >
                  Close
                </button>
                <button
                  type="button"
                  disabled={cookiesSaving || !cookiesInput.trim()}
                  onClick={handleSaveCookies}
                  className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
                >
                  {cookiesSaving ? 'Saving...' : 'Save Cookies'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Delete Project Confirmation Modal */}
      {deleteTarget && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-[#13161D] border border-[#2E3545] rounded-xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
              Delete Project?
            </h3>
            <p className="text-sm text-[#94A3B8]">
              Deleting <span className="text-[#F4F5F7] font-medium">“{deleteTarget.title}”</span> will permanently remove all downloaded source segments and cached frames for this project from disk.
            </p>
            <label className="flex items-start gap-2.5 text-xs text-[#CBD5E1] bg-[#0E1016] border border-[#232834] rounded-lg p-3 cursor-pointer">
              <input
                type="checkbox"
                checked={deleteWithClips}
                onChange={(e) => setDeleteWithClips(e.target.checked)}
                className="mt-0.5 accent-rose-500"
              />
              <span>
                Also delete finished 9:16 rendered clips associated with this project from My Clips (leave unchecked to keep finished Shorts).
              </span>
            </label>
            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  setDeleteTarget(null);
                  setDeleteWithClips(false);
                }}
                className="px-4 py-2 text-xs font-medium bg-[#1C212C] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingProj}
                onClick={confirmDeleteProject}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
              >
                {deletingProj ? 'Deleting...' : 'Delete Project'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

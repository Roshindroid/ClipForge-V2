import { useState } from 'react';
import { Download, Film, FolderOpen, HardDrive, Trash2, Youtube } from 'lucide-react';
import type { RenderedClip, StorageStatus, VideoProject } from '../types';
import { LAYOUT_OPTIONS } from '../types';

interface RenderQueueViewProps {
  clips: RenderedClip[];
  projects: VideoProject[];
  storageStatus: StorageStatus | null;
  onDeleteClip: (clipId: string) => void;
  onCleanupSource: (projectId: string) => Promise<void>;
  onPruneAllSources: () => Promise<void>;
  onPublishClip: (clip: RenderedClip) => void;
  onGoToStudio: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function RenderQueueView({
  clips,
  projects,
  storageStatus,
  onDeleteClip,
  onCleanupSource,
  onPruneAllSources,
  onPublishClip,
  onGoToStudio,
}: RenderQueueViewProps) {
  const [busyId, setBusyId] = useState<string | null>(null);

  const projectsWithCachedSources = projects.filter((p) => {
    if (p.sourceMode === 'local') {
      return !p.sourceDeleted && (p.sourceSizeBytes || 0) > 0;
    }
    return p.moments.some((m) => m.segmentStatus === 'ready' && (m.segmentSizeBytes || 0) > 0);
  });

  const storagePanel =
    projectsWithCachedSources.length > 0 || (storageStatus && storageStatus.totalSourceBytes > 0) ? (
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start gap-2.5">
            <HardDrive className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                Cached 1080p Segments on Disk ({formatBytes(storageStatus?.totalSourceBytes || 0)})
              </h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Delete temporary 1080p segments from <span className="font-mono text-[#CBD5E1]">workspace/sources</span> anytime—your finished 9:16 Shorts in <span className="font-mono text-[#CBD5E1]">workspace/renders</span> remain intact.
              </p>
            </div>
          </div>
          {projectsWithCachedSources.length > 1 && (
            <button
              type="button"
              disabled={busyId !== null}
              onClick={async () => {
                setBusyId('all');
                try {
                  await onPruneAllSources();
                } finally {
                  setBusyId(null);
                }
              }}
              className="px-3 py-1.5 text-xs font-semibold bg-amber-500/15 hover:bg-rose-950/70 border border-amber-500/40 hover:border-rose-700 text-amber-200 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              {busyId === 'all' ? 'Deleting...' : 'Delete All Segments'}
            </button>
          )}
        </div>

        {projectsWithCachedSources.length > 0 && (
          <div className="divide-y divide-[#232834] border-t border-[#232834] pt-2">
            {projectsWithCachedSources.map((proj) => {
              const totalProjBytes =
                proj.sourceMode === 'local'
                  ? proj.sourceSizeBytes || 0
                  : proj.moments.reduce((sum, m) => sum + (m.segmentSizeBytes || 0), 0);
              const segCount =
                proj.sourceMode === 'local'
                  ? 1
                  : proj.moments.filter((m) => m.segmentStatus === 'ready').length;

              return (
                <div
                  key={proj.id}
                  className="py-2 flex flex-wrap items-center justify-between gap-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <p className="font-medium text-[#F4F5F7] truncate">{proj.title}</p>
                    <p className="text-[11px] font-mono text-[#64748B] truncate flex items-center gap-1.5 mt-0.5">
                      <FolderOpen className="w-3 h-3 shrink-0" />
                      <span>
                        {proj.sourceMode === 'local'
                          ? `workspace/sources/${proj.fileName}`
                          : `${segCount} 1080p segment(s) in workspace/sources/${proj.downloadFolder || 'segments'}`}
                      </span>
                      <span>·</span>
                      <span className="text-[#94A3B8]">{formatBytes(totalProjBytes)}</span>
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busyId !== null}
                    onClick={async () => {
                      setBusyId(proj.id);
                      try {
                        await onCleanupSource(proj.id);
                      } finally {
                        setBusyId(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-rose-950/60 border border-[#32394A] hover:border-rose-700 text-amber-300 rounded-lg transition-colors cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    {busyId === proj.id ? 'Deleting...' : `Free ${formatBytes(totalProjBytes)}`}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    ) : null;

  if (clips.length === 0) {
    return (
      <div className="space-y-5">
        {storagePanel}
        <div className="bg-[#13161D] border border-[#232834] rounded-xl p-12 text-center space-y-3">
          <Film className="w-7 h-7 text-[#64748B] mx-auto" />
          <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
            No Rendered Vertical Shorts Yet
          </h3>
          <p className="text-sm text-[#94A3B8] max-w-md mx-auto">
            Pick your moments in Discover Moments and choose your 9:16 layout in Layout & Render.
          </p>
          <button
            type="button"
            onClick={onGoToStudio}
            className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
          >
            Open Layout Studio
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {storagePanel}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#F4F5F7]">
            Rendered 9:16 Shorts ({clips.length})
          </h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Saved in <span className="font-mono text-[#CBD5E1]">workspace/renders</span> ({formatBytes(storageStatus?.totalRenderBytes || 0)} total).
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {clips.map((clip) => {
          const layoutMeta = LAYOUT_OPTIONS.find((l) => l.id === clip.layoutId);
          return (
            <article
              key={clip.id}
              className="bg-[#13161D] border border-[#232834] rounded-xl p-4 flex flex-col gap-4"
            >
              <div className="aspect-[9/16] max-h-[380px] mx-auto w-full max-w-[220px] bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                <video
                  src={clip.downloadUrl}
                  controls
                  playsInline
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="space-y-1.5 flex-1">
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-[#94A3B8]">
                  <span>{clip.resolution} · {clip.durationSec}s</span>
                  <span>{formatBytes(clip.fileSizeBytes)}</span>
                </div>
                <h3 className="font-display text-sm font-semibold text-[#F4F5F7] line-clamp-2">
                  {clip.title}
                </h3>
                <p className="text-xs text-[#94A3B8]">
                  {layoutMeta?.name || clip.layoutId} · {clip.encoderUsed || 'libx264'}
                </p>
                {clip.youtubeVideoId && (
                  <p className="text-xs text-emerald-400 font-mono pt-0.5">
                    YouTube ID: {clip.youtubeVideoId} ({clip.youtubeStatus})
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 pt-2 border-t border-[#232834]">
                <a
                  href={`${clip.downloadUrl}?download=1`}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors whitespace-nowrap"
                >
                  <Download className="w-3.5 h-3.5" />
                  MP4
                </a>
                <button
                  type="button"
                  onClick={() => onPublishClip(clip)}
                  className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors cursor-pointer whitespace-nowrap"
                >
                  <Youtube className="w-3.5 h-3.5" />
                  YouTube
                </button>
                <button
                  type="button"
                  aria-label="Delete clip"
                  onClick={() => onDeleteClip(clip.id)}
                  className="p-2 text-[#64748B] hover:text-rose-400 border border-[#232834] rounded-lg cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </article>
          );
        })}
      </div>
    </div>
  );
}

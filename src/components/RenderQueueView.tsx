import { useState } from 'react';
import { Calendar, Download, Film, HardDrive, Trash2, Youtube } from 'lucide-react';
import type { RenderedClip, StorageStatus } from '../types';
import { LAYOUT_OPTIONS } from '../types';

interface RenderQueueViewProps {
  clips: RenderedClip[];
  storageStatus: StorageStatus | null;
  onDeleteClip: (clipId: string) => Promise<void>;
  onPublishClip: (clip: RenderedClip) => void;
  onGoToCreate: () => void;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function RenderQueueView({
  clips,
  storageStatus,
  onDeleteClip,
  onPublishClip,
  onGoToCreate,
}: RenderQueueViewProps) {
  const [confirmDeleteClip, setConfirmDeleteClip] = useState<RenderedClip | null>(null);
  const [deleting, setDeleting] = useState(false);

  if (clips.length === 0) {
    return (
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-12 text-center space-y-3">
        <Film className="w-7 h-7 text-[#64748B] mx-auto" />
        <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
          No Completed Clips Yet
        </h3>
        <p className="text-sm text-[#94A3B8] max-w-md mx-auto">
          Download your timestamp segments, position your facecam region, and render vertical 9:16 Shorts in Create Clips.
        </p>
        <button
          type="button"
          onClick={onGoToCreate}
          className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
        >
          Go to Create Clips
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold text-[#F4F5F7]">
            My Clips ({clips.length})
          </h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Saved permanently in <span className="font-mono text-[#CBD5E1]">workspace/renders</span> and preserved across restarts.
          </p>
        </div>
        {storageStatus && (
          <div className="flex items-center gap-4 text-xs font-mono text-[#94A3B8]">
            <span className="inline-flex items-center gap-1.5">
              <HardDrive className="w-3.5 h-3.5 text-rose-400" />
              Renders: {formatBytes(storageStatus.totalRenderBytes)}
            </span>
            <span>Sources: {formatBytes(storageStatus.totalSourceBytes)}</span>
          </div>
        )}
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
                  preload="metadata"
                  className="w-full h-full object-contain"
                />
              </div>

              <div className="space-y-1.5 flex-1">
                <div className="flex items-center justify-between gap-2 text-[11px] font-mono tabular-nums text-[#94A3B8]">
                  <span>
                    {clip.resolution} · {clip.durationSec}s
                  </span>
                  <span>{formatBytes(clip.fileSizeBytes)}</span>
                </div>

                <h3 className="font-display text-sm font-semibold text-[#F4F5F7] line-clamp-2">
                  {clip.title}
                </h3>

                <p className="text-xs text-[#94A3B8]">
                  {layoutMeta?.name || clip.layoutId} · {clip.encoderUsed || 'libx264'}
                </p>

                <p className="text-[11px] text-[#64748B] flex items-center gap-1.5">
                  <Calendar className="w-3 h-3 shrink-0" />
                  <span>{new Date(clip.createdAt).toLocaleString()}</span>
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
                  Publish
                </button>
                <button
                  type="button"
                  aria-label="Delete clip"
                  onClick={() => setConfirmDeleteClip(clip)}
                  className="p-2 text-[#64748B] hover:text-rose-400 border border-[#232834] hover:border-rose-700 rounded-lg cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {/* Explicit Delete Clip Confirmation Modal */}
      {confirmDeleteClip && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-[#13161D] border border-[#2E3545] rounded-xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
              Delete Rendered Clip?
            </h3>
            <p className="text-sm text-[#94A3B8]">
              This will permanently delete{' '}
              <span className="text-[#F4F5F7] font-medium">“{confirmDeleteClip.title}”</span> from
              disk. Your downloaded source segment in the project remains untouched.
            </p>
            <div className="flex items-center justify-end gap-3 pt-1">
              <button
                type="button"
                onClick={() => setConfirmDeleteClip(null)}
                className="px-4 py-2 text-xs font-medium bg-[#1C212C] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await onDeleteClip(confirmDeleteClip.id);
                    setConfirmDeleteClip(null);
                  } finally {
                    setDeleting(false);
                  }
                }}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
              >
                {deleting ? 'Deleting...' : 'Delete Clip'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

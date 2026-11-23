import { useRef, useState } from 'react';
import {
  Camera,
  Check,
  Film,
  Layers,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type {
  AppSettings,
  BrandingConfig,
  FacecamBox,
  LayoutId,
  RenderedClip,
  TemplateId,
  VideoProject,
  ViralMoment,
} from '../types';
import { LAYOUT_OPTIONS } from '../types';
import { formatTimecode, pollJobUntilDone } from '../lib/jobs';
import { LayoutThumbnail } from './LayoutThumbnail';

interface FacecamLayoutStudioProps {
  project: VideoProject | null;
  moment: ViralMoment | null;
  appSettings: AppSettings;
  onSelectMoment: (moment: ViralMoment) => void;
  onProjectUpdated: (project: VideoProject) => void;
  onClipRendered: (clip: RenderedClip, updatedProject?: VideoProject) => void;
  onBatchClipsRendered?: (clips: RenderedClip[], updatedProject?: VideoProject) => void;
}

const TEMPLATES: Array<{ id: TemplateId; label: string; desc: string }> = [
  { id: 'none', label: 'Clean Raw', desc: 'Zero overlay chrome' },
  { id: 'x-post', label: 'X Post Card', desc: 'Top tweet-style header' },
  { id: 'tiktok-hook', label: 'Hook Banner', desc: 'Bold top headline strip' },
  { id: 'breaking-news', label: 'Breaking News', desc: 'Lower broadcast chyron' },
];

export function FacecamLayoutStudio({
  project,
  moment,
  appSettings,
  onSelectMoment,
  onProjectUpdated,
  onClipRendered,
  onBatchClipsRendered,
}: FacecamLayoutStudioProps) {
  const activeMoment = moment || project?.moments[0] || null;
  const [frameIndex, setFrameIndex] = useState(0);
  const [facecamBox, setFacecamBox] = useState<FacecamBox>(
    project?.detectedFacecam || {
      x: 0.72,
      y: 0.65,
      width: 0.25,
      height: 0.3,
      confidence: 0.85,
      presetLabel: 'Bottom-Right Cam',
    }
  );
  const [layoutId, setLayoutId] = useState<LayoutId>('split-top-cam');
  const [templateId, setTemplateId] = useState<TemplateId>('none');
  const [branding, setBranding] = useState<BrandingConfig>({
    creditText: '@clipforge',
    backgroundHex: '#0B0D11',
    watermarkText: '',
  });

  const [clipTitle, setClipTitle] = useState(activeMoment?.title || '');
  const [clipHook, setClipHook] = useState(activeMoment?.hookTagline || '');
  const [isRendering, setIsRendering] = useState(false);
  const [renderStage, setRenderStage] = useState('');
  const [renderProgress, setRenderProgress] = useState(0);
  const [isSavingCam, setIsSavingCam] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const prevProjectId = useRef<string | null>(null);
  const prevMomentId = useRef<string | null>(null);
  if (project && prevProjectId.current !== project.id) {
    prevProjectId.current = project.id;
    setFacecamBox(project.detectedFacecam);
    setFrameIndex(0);
  }
  if (activeMoment && prevMomentId.current !== activeMoment.id) {
    prevMomentId.current = activeMoment.id;
    setClipTitle(activeMoment.title);
    setClipHook(activeMoment.hookTagline);
  }

  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleFrameMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = facecamBox.x;
    const origY = facecamBox.y;

    const onMove = (moveEvent: MouseEvent) => {
      const dx = (moveEvent.clientX - startX) / rect.width;
      const dy = (moveEvent.clientY - startY) / rect.height;
      setFacecamBox((prev) => ({
        ...prev,
        x: Math.round(Math.max(0, Math.min(1 - prev.width, origX + dx)) * 100) / 100,
        y: Math.round(Math.max(0, Math.min(1 - prev.height, origY + dy)) * 100) / 100,
        presetLabel: 'Custom Drag Region',
        confidence: 1,
      }));
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!project || !activeMoment) {
    return (
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-10 text-center space-y-2">
        <Camera className="w-7 h-7 text-[#64748B] mx-auto" />
        <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
          Inspect a Link First
        </h3>
        <p className="text-sm text-[#94A3B8]">
          Start in Discover Moments to inspect a video link, pick your best moments, and configure your 9:16 layout.
        </p>
      </div>
    );
  }

  const activeFrameUrl = project.previewFrames[frameIndex] || project.previewFrames[0] || '';
  const selectedLayoutMeta = LAYOUT_OPTIONS.find((l) => l.id === layoutId) || LAYOUT_OPTIONS[0];
  const selectedMoments = project.moments.filter((m) => m.selected);
  const batchTargetMoments = selectedMoments.length > 0 ? selectedMoments : project.moments;
  const localDeleted = project.sourceMode === 'local' && Boolean(project.sourceDeleted);

  const handleSaveFacecam = async () => {
    setIsSavingCam(true);
    setSavedNotice(null);
    try {
      const res = await fetch(`/api/projects/${project.id}/facecam`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facecamBox }),
      });
      const data = await res.json();
      if (res.ok && data.project) {
        onProjectUpdated(data.project);
        setSavedNotice('Saved');
        setTimeout(() => setSavedNotice(null), 2500);
      }
    } finally {
      setIsSavingCam(false);
    }
  };

  const handleRenderClip = async () => {
    setIsRendering(true);
    setRenderError(null);
    setRenderStage('Starting render...');
    setRenderProgress(5);
    try {
      const res = await fetch('/api/clips/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          momentId: activeMoment.id,
          layoutId,
          templateId,
          facecamBox,
          branding,
          title: clipTitle.trim() || activeMoment.title,
          hookTagline: clipHook.trim() || activeMoment.hookTagline,
          description: activeMoment.description,
          hashtags: activeMoment.hashtags,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Render failed');

      let renderedClip = data.clip;
      let updatedProject = data.project as VideoProject | undefined;
      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setRenderProgress(job.progress);
          setRenderStage(job.stage);
        });
        renderedClip = done.clip;
        if (done.project) updatedProject = done.project;
      }

      if (!renderedClip) throw new Error('Render finished without output clip.');
      onClipRendered(renderedClip, updatedProject);
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : 'FFmpeg render failed');
    } finally {
      setIsRendering(false);
      setRenderStage('');
      setRenderProgress(0);
    }
  };

  const handleRenderSelectedBatch = async () => {
    if (batchTargetMoments.length === 0) return;
    setIsRendering(true);
    setRenderError(null);
    setRenderStage(`Queueing ${batchTargetMoments.length} clip(s)...`);
    setRenderProgress(4);

    try {
      const res = await fetch('/api/clips/render-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: project.id,
          momentIds: batchTargetMoments.map((m) => m.id),
          layoutId,
          templateId,
          facecamBox,
          branding,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Batch render failed');

      const jobIds: string[] = data.jobIds || [];
      const renderedClips: RenderedClip[] = [];
      let updatedProject: VideoProject | undefined;

      for (let i = 0; i < jobIds.length; i++) {
        const done = await pollJobUntilDone(jobIds[i], (job) => {
          const overall = Math.round(((i + job.progress / 100) / jobIds.length) * 100);
          setRenderProgress(overall);
          setRenderStage(`Clip ${i + 1}/${jobIds.length}: ${job.stage}`);
        });
        if (done.clip) renderedClips.push(done.clip);
        if (done.project) updatedProject = done.project;
      }

      if (onBatchClipsRendered) {
        onBatchClipsRendered(renderedClips, updatedProject);
      } else if (renderedClips[0]) {
        onClipRendered(renderedClips[0], updatedProject);
      }
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : 'Batch render failed');
    } finally {
      setIsRendering(false);
      setRenderStage('');
      setRenderProgress(0);
    }
  };

  const camBgStyle: React.CSSProperties = activeFrameUrl
    ? {
        backgroundImage: `url(${activeFrameUrl})`,
        backgroundSize: `${Math.round(100 / Math.max(0.1, facecamBox.width))}% ${Math.round(
          100 / Math.max(0.1, facecamBox.height)
        )}%`,
        backgroundPosition: `${Math.round(
          (facecamBox.x / Math.max(0.01, 1 - facecamBox.width)) * 100
        )}% ${Math.round((facecamBox.y / Math.max(0.01, 1 - facecamBox.height)) * 100)}%`,
      }
    : {};

  return (
    <div className="space-y-6">
      <div className="bg-[#13161D] border border-[#232834] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-xs font-medium text-[#94A3B8] shrink-0">Active Moment:</span>
          <select
            value={activeMoment.id}
            onChange={(e) => {
              const found = project.moments.find((m) => m.id === e.target.value);
              if (found) onSelectMoment(found);
            }}
            className="bg-[#0E1016] border border-[#232834] rounded-lg px-3 py-1.5 text-xs font-medium text-[#F4F5F7] outline-none max-w-md"
          >
            {project.moments.map((m, i) => (
              <option key={m.id} value={m.id}>
                #{i + 1} · {formatTimecode(m.startSec)}–{formatTimecode(m.endSec)} · {m.title}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2 text-xs text-emerald-400 font-medium">
          <ShieldCheck className="w-4 h-4 shrink-0" />
          <span>Clean Audio · YouTube Auto-Captions Mode</span>
        </div>
      </div>

      {localDeleted && (
        <div className="px-4 py-3 text-xs text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-xl">
          This local file was pruned from <span className="font-mono">workspace/sources</span>. Re-upload to render additional clips.
        </div>
      )}

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
        {/* Column 1: Source Frame + Facecam Drag Box */}
        <section className="xl:col-span-4 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                1. Source Facecam Region
              </h3>
              <p className="text-xs text-[#94A3B8]">
                Drag box on frame or pick a detected corner.
              </p>
            </div>
            <button
              type="button"
              onClick={handleSaveFacecam}
              disabled={isSavingCam}
              className="px-2.5 py-1 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer whitespace-nowrap"
            >
              {savedNotice || (isSavingCam ? 'Saving...' : 'Save Box')}
            </button>
          </div>

          <div
            ref={containerRef}
            className="relative aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834] select-none"
          >
            {activeFrameUrl ? (
              <img
                src={activeFrameUrl}
                alt="Source video frame"
                draggable={false}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-xs text-[#64748B]">
                No frame preview
              </div>
            )}

            <div
              onMouseDown={handleFrameMouseDown}
              style={{
                left: `${facecamBox.x * 100}%`,
                top: `${facecamBox.y * 100}%`,
                width: `${facecamBox.width * 100}%`,
                height: `${facecamBox.height * 100}%`,
              }}
              className="absolute border-2 border-rose-500 bg-rose-500/20 cursor-move rounded-[3px] flex items-start justify-between p-1"
            >
              <span className="bg-rose-600 text-white text-[10px] font-mono px-1.5 py-0.5 rounded-[2px]">
                FACECAM
              </span>
            </div>
          </div>

          {project.previewFrames.length > 1 && (
            <div className="flex items-center gap-2">
              {project.previewFrames.map((url, idx) => (
                <button
                  key={url}
                  type="button"
                  onClick={() => setFrameIndex(idx)}
                  className={`flex-1 h-10 rounded overflow-hidden border transition-colors cursor-pointer ${
                    frameIndex === idx ? 'border-rose-500' : 'border-[#232834] opacity-65 hover:opacity-100'
                  }`}
                >
                  <img src={url} alt={`Keyframe ${idx + 1}`} className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
          )}

          <div className="space-y-2">
            <span className="text-xs font-medium text-[#CBD5E1]">Detected Corners</span>
            <div className="grid grid-cols-2 gap-2">
              {project.facecamCandidates.map((cand) => {
                const isActive =
                  Math.abs(cand.x - facecamBox.x) < 0.03 &&
                  Math.abs(cand.y - facecamBox.y) < 0.03;
                return (
                  <button
                    key={cand.presetLabel}
                    type="button"
                    onClick={() => setFacecamBox(cand)}
                    className={`px-2.5 py-2 text-left rounded-lg border text-xs transition-colors cursor-pointer ${
                      isActive
                        ? 'bg-rose-950/40 border-rose-500 text-[#F4F5F7]'
                        : 'bg-[#0E1016] border-[#232834] text-[#94A3B8] hover:text-[#F4F5F7]'
                    }`}
                  >
                    <div className="font-medium truncate">{cand.presetLabel}</div>
                    <div className="font-mono tabular-nums text-[11px] text-[#64748B]">
                      Score {(cand.confidence * 100).toFixed(0)}%
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#232834] text-xs">
            <label className="space-y-1">
              <span className="text-[#94A3B8] flex justify-between font-mono tabular-nums">
                <span>Cam Width</span>
                <span>{Math.round(facecamBox.width * 100)}%</span>
              </span>
              <input
                type="range"
                min={12}
                max={55}
                value={Math.round(facecamBox.width * 100)}
                onChange={(e) => {
                  const w = Number(e.target.value) / 100;
                  setFacecamBox((p) => ({ ...p, width: w, x: Math.min(p.x, 1 - w) }));
                }}
                className="w-full accent-rose-500"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#94A3B8] flex justify-between font-mono tabular-nums">
                <span>Cam Height</span>
                <span>{Math.round(facecamBox.height * 100)}%</span>
              </span>
              <input
                type="range"
                min={14}
                max={60}
                value={Math.round(facecamBox.height * 100)}
                onChange={(e) => {
                  const h = Number(e.target.value) / 100;
                  setFacecamBox((p) => ({ ...p, height: h, y: Math.min(p.y, 1 - h) }));
                }}
                className="w-full accent-rose-500"
              />
            </label>
          </div>
        </section>

        {/* Column 2: Live 9:16 Preview */}
        <section className="xl:col-span-3 bg-[#13161D] border border-[#232834] rounded-xl p-5 flex flex-col items-center space-y-3">
          <div className="w-full flex items-center justify-between">
            <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
              2. Live 9:16 Preview
            </h3>
            <span className="text-[11px] font-mono text-[#94A3B8]">
              {selectedLayoutMeta.shortLabel}
            </span>
          </div>

          <div
            style={{ backgroundColor: branding.backgroundHex }}
            className="w-[234px] h-[416px] rounded-xl overflow-hidden border border-[#2E3545] relative shrink-0 select-none"
          >
            {(layoutId === 'split-top-cam' || layoutId === 'split-50-50') && (
              <div className="w-full h-full flex flex-col">
                <div
                  style={camBgStyle}
                  className={`${layoutId === 'split-50-50' ? 'h-1/2' : 'h-[35%]'} w-full bg-no-repeat border-b border-black/50`}
                />
                <div
                  style={{ backgroundImage: `url(${activeFrameUrl})` }}
                  className="flex-1 w-full bg-cover bg-center"
                />
              </div>
            )}

            {layoutId === 'split-bottom-cam' && (
              <div className="w-full h-full flex flex-col">
                <div
                  style={{ backgroundImage: `url(${activeFrameUrl})` }}
                  className="h-[65%] w-full bg-cover bg-center border-b border-black/50"
                />
                <div style={camBgStyle} className="flex-1 w-full bg-no-repeat" />
              </div>
            )}

            {(layoutId === 'pip-top-left' ||
              layoutId === 'pip-top-right' ||
              layoutId === 'pip-bottom-left' ||
              layoutId === 'pip-bottom-right') && (
              <div className="w-full h-full relative">
                <div
                  style={{ backgroundImage: `url(${activeFrameUrl})` }}
                  className="w-full h-full bg-cover bg-center"
                />
                <div
                  style={camBgStyle}
                  className={`absolute w-[74px] h-[74px] rounded-md border-2 border-white/85 bg-no-repeat ${
                    layoutId === 'pip-top-left'
                      ? 'top-10 left-3'
                      : layoutId === 'pip-top-right'
                        ? 'top-10 right-3'
                        : layoutId === 'pip-bottom-left'
                          ? 'bottom-12 left-3'
                          : 'bottom-12 right-3'
                  }`}
                />
              </div>
            )}

            {(layoutId === 'blurred-bg-cam-top' || layoutId === 'blurred-bg-cam-bottom') && (
              <div className="w-full h-full relative flex flex-col items-center justify-center">
                <div
                  style={{ backgroundImage: `url(${activeFrameUrl})` }}
                  className="absolute inset-0 bg-cover bg-center blur-md opacity-45 scale-110"
                />
                {layoutId === 'blurred-bg-cam-top' && (
                  <div
                    style={camBgStyle}
                    className="relative z-10 w-[92px] h-[74px] rounded-md border border-white/80 mb-3 bg-no-repeat"
                  />
                )}
                <img
                  src={activeFrameUrl}
                  alt="Centered 16:9 stream"
                  className="relative z-10 w-full aspect-video object-cover border-y border-white/15"
                />
                {layoutId === 'blurred-bg-cam-bottom' && (
                  <div
                    style={camBgStyle}
                    className="relative z-10 w-[92px] h-[74px] rounded-md border border-white/80 mt-3 bg-no-repeat"
                  />
                )}
              </div>
            )}

            {layoutId === 'center-crop-focus' && (
              <div
                style={{ backgroundImage: `url(${activeFrameUrl})` }}
                className="w-full h-full bg-cover bg-center"
              />
            )}

            {layoutId === 'facecam-only-zoom' && (
              <div style={camBgStyle} className="w-full h-full bg-no-repeat" />
            )}

            {templateId === 'x-post' && (
              <div className="absolute top-3 left-3 right-3 z-20 bg-[#0F1117]/95 border border-[#2A303E] rounded-md px-2.5 py-2">
                <p className="text-[9px] text-[#94A3B8]">{branding.creditText || '@creator'}</p>
                <p className="text-[10px] font-semibold text-white leading-tight mt-0.5 line-clamp-2">
                  {clipHook || activeMoment.hookTagline}
                </p>
              </div>
            )}
            {templateId === 'tiktok-hook' && (
              <div className="absolute top-4 left-4 right-4 z-20 bg-white text-[#0B0D11] rounded px-2.5 py-1.5 text-center">
                <p className="text-[10px] font-bold leading-tight line-clamp-2">
                  {clipHook || activeMoment.hookTagline}
                </p>
              </div>
            )}
            {templateId === 'breaking-news' && (
              <div className="absolute bottom-4 left-0 right-0 z-20">
                <div className="bg-rose-600 text-white text-[9px] font-bold px-2.5 py-0.5">
                  LIVE CLIP
                </div>
                <div className="bg-[#0B0D11]/95 text-white text-[10px] font-semibold px-2.5 py-1.5 line-clamp-1">
                  {clipHook || activeMoment.hookTagline}
                </div>
              </div>
            )}

            {(branding.watermarkText || branding.creditText) && (
              <span className="absolute bottom-1.5 right-2 z-20 text-[9px] font-medium text-white/75">
                {branding.watermarkText || branding.creditText}
              </span>
            )}
          </div>

          <p className="text-[11px] text-[#94A3B8] text-center">
            {selectedLayoutMeta.description}
          </p>
        </section>

        {/* Column 3: 11 Layouts + Template + Render */}
        <section className="xl:col-span-5 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-5">
          <div>
            <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
              3. Vertical Layout & Render
            </h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              {project.sourceMode === 'segments'
                ? 'Automatically fetches only the needed 1080p segment(s) before rendering 9:16 Shorts.'
                : 'Renders 720×1280 MP4 directly from your local source file.'}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {LAYOUT_OPTIONS.map((opt) => {
              const active = layoutId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setLayoutId(opt.id)}
                  className={`flex items-center gap-2.5 p-2 rounded-lg border text-left transition-colors cursor-pointer ${
                    active
                      ? 'bg-rose-950/40 border-rose-500 text-[#F4F5F7]'
                      : 'bg-[#0E1016] border-[#232834] text-[#94A3B8] hover:border-[#343C4E] hover:text-[#F4F5F7]'
                  }`}
                >
                  <LayoutThumbnail layoutId={opt.id} active={active} />
                  <div className="min-w-0">
                    <div className="text-xs font-medium leading-tight truncate">{opt.shortLabel}</div>
                    <div className="text-[10px] text-[#64748B] truncate mt-0.5">
                      {opt.facecamPlacement}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="pt-4 border-t border-[#232834] space-y-3">
            <div className="flex items-center gap-2 text-xs font-medium text-[#CBD5E1]">
              <Layers className="w-3.5 h-3.5 text-rose-400" />
              <span>Optional Header Overlay</span>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTemplateId(t.id)}
                  className={`px-2.5 py-2 rounded-lg border text-left transition-colors cursor-pointer ${
                    templateId === t.id
                      ? 'bg-[#1D2330] border-rose-500 text-[#F4F5F7]'
                      : 'bg-[#0E1016] border-[#232834] text-[#94A3B8] hover:text-[#F4F5F7]'
                  }`}
                >
                  <div className="text-xs font-medium">{t.label}</div>
                  <div className="text-[10px] text-[#64748B] truncate">{t.desc}</div>
                </button>
              ))}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Credit Handle</span>
                <input
                  type="text"
                  value={branding.creditText}
                  onChange={(e) => setBranding((b) => ({ ...b, creditText: e.target.value }))}
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Corner Watermark</span>
                <input
                  type="text"
                  value={branding.watermarkText}
                  onChange={(e) => setBranding((b) => ({ ...b, watermarkText: e.target.value }))}
                  placeholder="Optional tag"
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Backdrop Color</span>
                <div className="flex items-center gap-2">
                  <input
                    type="color"
                    value={branding.backgroundHex}
                    onChange={(e) => setBranding((b) => ({ ...b, backgroundHex: e.target.value }))}
                    className="h-8 w-10 bg-transparent border border-[#232834] rounded cursor-pointer"
                  />
                  <span className="font-mono text-[11px] text-[#94A3B8]">
                    {branding.backgroundHex}
                  </span>
                </div>
              </label>
            </div>

            <div className="space-y-2 pt-1">
              <label className="block space-y-1 text-xs">
                <span className="text-[#94A3B8]">Clip Title & Hook Tagline</span>
                <input
                  type="text"
                  value={clipTitle}
                  onChange={(e) => setClipTitle(e.target.value)}
                  placeholder="Clip title"
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                />
              </label>
              <input
                type="text"
                value={clipHook}
                onChange={(e) => setClipHook(e.target.value)}
                placeholder="1-line hook tagline"
                className="w-full px-2.5 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
              />
            </div>
          </div>

          {renderError && (
            <div className="px-3 py-2 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
              {renderError}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={handleRenderClip}
              disabled={isRendering || localDeleted}
              className="flex-1 py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isRendering ? (
                <>
                  <Sparkles className="w-4 h-4 animate-spin" />
                  {renderStage || 'Rendering...'} ({renderProgress}%)
                </>
              ) : (
                <>
                  <Film className="w-4 h-4" />
                  Render This Short ({activeMoment.durationSec}s)
                </>
              )}
            </button>

            {batchTargetMoments.length > 1 && (
              <button
                type="button"
                onClick={handleRenderSelectedBatch}
                disabled={isRendering || localDeleted}
                className="px-4 py-3 bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-50"
              >
                <Layers className="w-3.5 h-3.5 text-rose-400" />
                Render {batchTargetMoments.length} Selected
              </button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-3 text-[11px] text-[#94A3B8]">
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              720×1280 H.264 MP4 · Auto-Captions Mode
            </span>
            {appSettings.autoPruneSourceVod && (
              <span className="font-mono text-emerald-400">
                · Auto-Prune Segments ON
              </span>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

import { useState, useEffect, useRef } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
  Film,
  FolderArchive,
  Layers,
  Loader2,
  Play,
  RotateCcw,
  Scissors,
  Sparkles,
  Tv,
  Video,
  Wand2,
} from 'lucide-react';
import type {
  BatchProcessJob,
  BrandingConfig,
  LayoutId,
  RenderedClip,
  TemplateId,
  VideoSegment,
} from '../types';
import { LAYOUT_OPTIONS } from '../types';
import {
  formatSecondsToTimecode,
  parseMultilineTimestamps,
  type TimestampParseResult,
} from '../lib/timestampParser';
import { LayoutThumbnail } from './LayoutThumbnail';

interface V2AutoClipperViewProps {
  onClipsRendered?: (clips: RenderedClip[]) => void;
  onNavigateToTab?: (tab: 'queue' | 'youtube' | 'facecam') => void;
}

const DEFAULT_TIMESTAMPS_DEMO = `# ClipForge V2 Timestamp Range Input
# Format: HH:MM:SS - HH:MM:SS (optional title on the same line)
00:00:05 - 00:00:25 Opening gameplay highlight
00:00:30 - 00:00:55 Clutch round reaction
00:01:10 - 00:01:40 Boss battle encounter
00:02:00 - 00:02:45 Victory celebration`;

export function V2AutoClipperView({
  onClipsRendered,
  onNavigateToTab,
}: V2AutoClipperViewProps) {
  // Step 1: Video URL & Inspection state
  const [videoUrl, setVideoUrl] = useState('');
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<string | null>(null);
  const [videoMeta, setVideoMeta] = useState<{
    title: string;
    platform: string;
    durationSec: number;
    width: number;
    height: number;
    fps: number;
  } | null>(null);

  // Step 2: Timestamp Input state
  const [timestampsText, setTimestampsText] = useState(DEFAULT_TIMESTAMPS_DEMO);
  const [parseResult, setParseResult] = useState<TimestampParseResult>(() =>
    parseMultilineTimestamps(DEFAULT_TIMESTAMPS_DEMO)
  );

  // Step 3: Output Settings & Layout state
  const [preferredLayout, setPreferredLayout] = useState<LayoutId>('split-top-cam');
  const [resolution, setResolution] = useState<'1080x1920' | '720x1280'>('1080x1920');
  const [frameRate, setFrameRate] = useState<'original' | '60' | '30'>('original');
  const [templateId, setTemplateId] = useState<TemplateId>('none');
  const [branding, setBranding] = useState<BrandingConfig>({
    creditText: '@clipforge',
    backgroundHex: '#0B0D11',
    watermarkText: '',
  });
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false);

  // Step 4 & 5: Batch Job state
  const [activeJob, setActiveJob] = useState<BatchProcessJob | null>(null);
  const [submittingJob, setSubmittingJob] = useState(false);
  const [jobError, setJobError] = useState<string | null>(null);
  const [previewSegmentId, setPreviewSegmentId] = useState<string | null>(null);

  const pollingRef = useRef<number | null>(null);

  // Re-parse timestamps whenever text or video duration changes
  useEffect(() => {
    const res = parseMultilineTimestamps(timestampsText, videoMeta?.durationSec);
    setParseResult(res);
  }, [timestampsText, videoMeta?.durationSec]);

  // Inspect Video URL
  const handleInspectUrl = async () => {
    const trimmed = videoUrl.trim();
    if (!trimmed) {
      setInspectError('Please enter a video URL first.');
      return;
    }

    setInspecting(true);
    setInspectError(null);

    try {
      const res = await fetch('/api/v2/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to inspect video URL');
      }

      setVideoMeta(data);
    } catch (err) {
      setInspectError(err instanceof Error ? err.message : 'Could not inspect video link.');
    } finally {
      setInspecting(false);
    }
  };

  // Start Batch Processing
  const handleStartBatchProcess = async () => {
    if (!videoUrl.trim()) {
      setJobError('Please enter a valid video URL.');
      return;
    }
    if (parseResult.validSegments.length === 0) {
      setJobError('Please enter at least one valid timestamp range.');
      return;
    }

    setSubmittingJob(true);
    setJobError(null);

    try {
      const payload = {
        videoUrl: videoUrl.trim(),
        videoTitle: videoMeta?.title || 'ClipForge Batch Project',
        videoDurationSec: videoMeta?.durationSec || 0,
        segments: parseResult.validSegments.map((s) => ({
          order: s.order,
          startSeconds: s.startSeconds,
          endSeconds: s.endSeconds,
          durationSeconds: s.durationSeconds,
          label: s.label,
        })),
        preferredLayout,
        templateId,
        resolution,
        frameRate,
        branding,
      };

      const res = await fetch('/api/v2/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to start batch processing.');
      }

      setActiveJob(data.job);
      startJobPolling(data.jobId);
    } catch (err) {
      setJobError(err instanceof Error ? err.message : 'Batch processing submission failed.');
    } finally {
      setSubmittingJob(false);
    }
  };

  // Poll for Job Status updates
  const startJobPolling = (jobId: string) => {
    if (pollingRef.current) {
      window.clearInterval(pollingRef.current);
    }

    const poll = async () => {
      try {
        const res = await fetch(`/api/v2/jobs/${jobId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.job) {
          setActiveJob(data.job);

          // If job finished, stop polling
          if (
            data.job.status === 'completed' ||
            data.job.status === 'partial_failure' ||
            data.job.status === 'failed'
          ) {
            if (pollingRef.current) {
              window.clearInterval(pollingRef.current);
              pollingRef.current = null;
            }

            // Sync newly rendered clips to parent state
            const completed = (data.job.segments as VideoSegment[])
              .filter((s) => s.status === 'completed' && s.outputFileName)
              .map((s) => ({
                id: s.id,
                projectId: data.job.id,
                momentId: s.id,
                title: s.label || `Clip #${s.order}`,
                hookTagline: s.label || `Highlight #${s.order}`,
                description: `Segment ${formatSecondsToTimecode(s.startSeconds)} - ${formatSecondsToTimecode(s.endSeconds)} from ${data.job.videoTitle}`,
                hashtags: ['#shorts', '#gaming', '#highlights'],
                layoutId: s.effectiveLayout || preferredLayout,
                templateId: data.job.templateId,
                facecamBox: {
                  x: s.facecam.boundingBox?.x ?? 0.72,
                  y: s.facecam.boundingBox?.y ?? 0.65,
                  width: s.facecam.boundingBox?.width ?? 0.25,
                  height: s.facecam.boundingBox?.height ?? 0.3,
                  confidence: s.facecam.confidence ?? 0.8,
                  presetLabel: s.facecam.positionLabel || 'Detected Cam',
                },
                branding: data.job.branding,
                burnedCaptions: false as const,
                outputFileName: s.outputFileName!,
                downloadUrl: s.downloadUrl!,
                durationSec: s.durationSeconds,
                resolution: data.job.resolution,
                fileSizeBytes: s.fileSizeBytes || 0,
                createdAt: new Date().toISOString(),
              }));

            if (completed.length > 0 && onClipsRendered) {
              onClipsRendered(completed);
            }
          }
        }
      } catch {
        // Continue polling silently
      }
    };

    poll();
    pollingRef.current = window.setInterval(poll, 1500);
  };

  useEffect(() => {
    return () => {
      if (pollingRef.current) {
        window.clearInterval(pollingRef.current);
      }
    };
  }, []);

  const selectedLayoutMeta =
    LAYOUT_OPTIONS.find((l) => l.id === preferredLayout) || LAYOUT_OPTIONS[0];

  return (
    <div className="space-y-8 max-w-7xl mx-auto pb-16">
      {/* Top Banner / Heading */}
      <div className="bg-[#12151E] border border-[#232834] rounded-2xl p-6 sm:p-8">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-semibold mb-3">
              <Sparkles className="w-3.5 h-3.5" />
              <span>CLIPFORGE V2 · AUTOMATED WORKFLOW</span>
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white font-display">
              Batch Video Clipper & Automatic Facecam Formatter
            </h1>
            <p className="mt-2 text-sm text-slate-400 max-w-3xl">
              Enter a video URL, paste all your timestamps in a single box, choose a layout, and
              click Process. ClipForge independently extracts each segment, automatically detects
              webcams with computer vision, applies your layout, and falls back to Gameplay Only if
              no camera is found.
            </p>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-400 bg-[#0B0D11] px-4 py-2.5 rounded-xl border border-[#232834]">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
            <span>CV Detector: <strong>Active</strong></span>
            <span className="text-slate-600">|</span>
            <span>FFmpeg: <strong>1080p Ready</strong></span>
          </div>
        </div>
      </div>

      {/* Main 2-Column Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Workflow Configuration Steps 1, 2, 3 */}
        <div className="lg:col-span-7 space-y-6">
          {/* STEP 1: Video URL Input */}
          <div className="bg-[#12151E] border border-[#232834] rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-rose-600 text-white text-xs font-bold">
                  1
                </span>
                <h2 className="text-base font-semibold text-white">Source Video URL</h2>
              </div>
              <span className="text-xs text-slate-500">YouTube, Twitch, Kick, or Direct</span>
            </div>

            <div className="space-y-3">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="https://www.youtube.com/watch?v=... or Twitch / Kick URL"
                  value={videoUrl}
                  onChange={(e) => {
                    setVideoUrl(e.target.value);
                    setInspectError(null);
                  }}
                  className="flex-1 bg-[#0B0D11] border border-[#232834] rounded-xl px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-colors"
                />
                <button
                  type="button"
                  onClick={handleInspectUrl}
                  disabled={inspecting || !videoUrl.trim()}
                  className="px-4 py-3 bg-[#1C212E] hover:bg-[#252B3B] text-white rounded-xl text-sm font-medium border border-[#2E3547] flex items-center gap-2 disabled:opacity-50 transition-colors cursor-pointer"
                >
                  {inspecting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                      <span>Inspecting...</span>
                    </>
                  ) : (
                    <span>Inspect</span>
                  )}
                </button>
              </div>

              {inspectError && (
                <div className="flex items-center gap-2 text-xs text-rose-400 bg-rose-500/10 p-3 rounded-lg border border-rose-500/20">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  <span>{inspectError}</span>
                </div>
              )}

              {/* Inspected Metadata Preview */}
              {videoMeta && (
                <div className="bg-[#0B0D11] border border-[#232834] rounded-xl p-4 flex items-center justify-between text-xs">
                  <div className="space-y-1">
                    <p className="font-semibold text-slate-200 line-clamp-1">{videoMeta.title}</p>
                    <p className="text-slate-400">
                      Platform: <span className="capitalize text-slate-300">{videoMeta.platform}</span> ·{' '}
                      Duration:{' '}
                      <span className="text-emerald-400 font-mono">
                        {formatSecondsToTimecode(videoMeta.durationSec, true)}
                      </span>{' '}
                      · Quality: <span className="text-slate-300">{videoMeta.width}×{videoMeta.height} @ {videoMeta.fps}fps</span>
                    </p>
                  </div>
                  <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 ml-2" />
                </div>
              )}
            </div>
          </div>

          {/* STEP 2: Single Multiline Timestamp Input */}
          <div className="bg-[#12151E] border border-[#232834] rounded-2xl p-6">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-rose-600 text-white text-xs font-bold">
                  2
                </span>
                <div>
                  <h2 className="text-base font-semibold text-white">Video Segments (One Input)</h2>
                  <p className="text-xs text-slate-400">
                    Paste all desired ranges below. One range per line.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setTimestampsText(DEFAULT_TIMESTAMPS_DEMO)}
                  className="text-xs text-rose-400 hover:text-rose-300 underline cursor-pointer"
                >
                  Load Example
                </button>
                <span className="text-slate-600">·</span>
                <button
                  type="button"
                  onClick={() => setTimestampsText('')}
                  className="text-xs text-slate-400 hover:text-slate-300 cursor-pointer"
                >
                  Clear
                </button>
              </div>
            </div>

            {/* Live Count & Status Tag */}
            <div className="mb-3 flex items-center justify-between">
              <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                <Scissors className="w-3.5 h-3.5" />
                <span>
                  {parseResult.validCount} valid segment{parseResult.validCount === 1 ? '' : 's'}{' '}
                  detected
                </span>
              </div>

              {parseResult.totalDurationSeconds > 0 && (
                <div className="flex items-center gap-1 text-xs text-slate-400">
                  <Clock className="w-3.5 h-3.5" />
                  <span>
                    Total clip time: {formatSecondsToTimecode(parseResult.totalDurationSeconds)}
                  </span>
                </div>
              )}
            </div>

            {/* Textarea */}
            <div className="relative">
              <textarea
                rows={7}
                value={timestampsText}
                onChange={(e) => setTimestampsText(e.target.value)}
                placeholder={`00:05:20 - 00:06:45\n00:12:10 - 00:13:30 Insane clutch\n00:28:00 - 00:30:15`}
                className="w-full bg-[#0B0D11] border border-[#232834] rounded-xl p-4 font-mono text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-rose-500 focus:ring-1 focus:ring-rose-500 transition-colors leading-relaxed"
              />
            </div>

            {/* Line-by-line Validation Feedback */}
            {parseResult.lineErrors.length > 0 && (
              <div className="mt-3 space-y-1 bg-rose-950/20 border border-rose-800/30 rounded-xl p-3 text-xs text-rose-300">
                <p className="font-semibold flex items-center gap-1.5 text-rose-400 mb-1">
                  <AlertCircle className="w-4 h-4" />
                  <span>Timestamp Formatting Issues ({parseResult.lineErrors.length}):</span>
                </p>
                {parseResult.lineErrors.slice(0, 4).map((err, i) => (
                  <p key={i} className="pl-5">
                    Line {err.line}: {err.message}
                  </p>
                ))}
                {parseResult.lineErrors.length > 4 && (
                  <p className="pl-5 text-slate-400">
                    + {parseResult.lineErrors.length - 4} more error(s)...
                  </p>
                )}
              </div>
            )}

            {/* Overlap & Duplicate Warnings */}
            {parseResult.warnings.length > 0 && (
              <div className="mt-3 space-y-1 bg-amber-950/20 border border-amber-800/30 rounded-xl p-3 text-xs text-amber-300">
                <p className="font-semibold flex items-center gap-1.5 text-amber-400 mb-1">
                  <AlertTriangle className="w-4 h-4" />
                  <span>Notices & Overlaps:</span>
                </p>
                {parseResult.warnings.slice(0, 3).map((w, i) => (
                  <p key={i} className="pl-5">
                    {w.message}
                  </p>
                ))}
              </div>
            )}
          </div>

          {/* STEP 3: Preferred Layout & Output Settings */}
          <div className="bg-[#12151E] border border-[#232834] rounded-2xl p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <span className="flex items-center justify-center w-6 h-6 rounded-full bg-rose-600 text-white text-xs font-bold">
                  3
                </span>
                <h2 className="text-base font-semibold text-white">Preferred Layout & Format</h2>
              </div>
              <span className="text-xs text-slate-400">11 Available Layouts</span>
            </div>

            {/* Mandatory Fallback Banner */}
            <div className="bg-[#0B0D11] border border-rose-500/20 rounded-xl p-3.5 mb-5 text-xs text-slate-300 flex items-start gap-3">
              <div className="w-6 h-6 rounded-lg bg-rose-500/10 flex items-center justify-center text-rose-400 shrink-0 mt-0.5">
                <Wand2 className="w-3.5 h-3.5" />
              </div>
              <div>
                <p className="font-medium text-slate-200">
                  Independent Facecam Detection & Automatic Gameplay Fallback
                </p>
                <p className="text-slate-400 mt-0.5">
                  ClipForge independently scans every segment. If a facecam is found, your preferred layout is applied with its exact coordinates. If no facecam is detected, ClipForge automatically renders with <strong>Gameplay Only (Center Focus)</strong>, preventing empty camera boxes or wasted space.
                </p>
              </div>
            </div>

            {/* Layout Grid Selector */}
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-6">
              {LAYOUT_OPTIONS.map((layout) => {
                const isSelected = preferredLayout === layout.id;
                return (
                  <button
                    key={layout.id}
                    type="button"
                    onClick={() => setPreferredLayout(layout.id)}
                    className={`p-3 rounded-xl border text-left flex flex-col justify-between transition-all cursor-pointer ${
                      isSelected
                        ? 'border-rose-500 bg-rose-500/10 ring-1 ring-rose-500'
                        : 'border-[#232834] bg-[#0B0D11] hover:border-[#383F52]'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-semibold text-white">{layout.shortLabel}</span>
                      {layout.usesFacecam ? (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-500/20 text-rose-300">
                          Cam
                        </span>
                      ) : (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-300">
                          Game Only
                        </span>
                      )}
                    </div>
                    <div className="h-28 flex items-center justify-center my-1 bg-[#10131A] rounded-lg p-1.5">
                      <LayoutThumbnail layoutId={layout.id} />
                    </div>
                    <p className="text-[10px] text-slate-400 line-clamp-1 mt-1">
                      {layout.facecamPlacement}
                    </p>
                  </button>
                );
              })}
            </div>

            {/* Resolution and Framerate Controls */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4 border-t border-[#232834]">
              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Output Resolution (9:16)
                </label>
                <select
                  value={resolution}
                  onChange={(e) => setResolution(e.target.value as '1080x1920' | '720x1280')}
                  className="w-full bg-[#0B0D11] border border-[#232834] rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-rose-500 cursor-pointer"
                >
                  <option value="1080x1920">1080 × 1920 (Full HD Shorts)</option>
                  <option value="720x1280">720 × 1280 (Fast Encoding)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-medium text-slate-400 mb-1.5">
                  Target Framerate
                </label>
                <select
                  value={frameRate}
                  onChange={(e) => setFrameRate(e.target.value as 'original' | '60' | '30')}
                  className="w-full bg-[#0B0D11] border border-[#232834] rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-rose-500 cursor-pointer"
                >
                  <option value="original">Keep Source Framerate (Default)</option>
                  <option value="60">60 FPS Smooth</option>
                  <option value="30">30 FPS Standard</option>
                </select>
              </div>
            </div>

            {/* Advanced Branding & Templates Toggle */}
            <div className="pt-4 mt-4 border-t border-[#232834]">
              <button
                type="button"
                onClick={() => setShowAdvancedSettings(!showAdvancedSettings)}
                className="text-xs text-slate-400 hover:text-white flex items-center gap-1.5 transition-colors cursor-pointer"
              >
                <span>{showAdvancedSettings ? 'Hide' : 'Show'} Overlay & Branding Options</span>
                <ArrowRight className="w-3 h-3" />
              </button>

              {showAdvancedSettings && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3 pt-3 border-t border-[#1C212E]">
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Overlay Style</label>
                    <select
                      value={templateId}
                      onChange={(e) => setTemplateId(e.target.value as TemplateId)}
                      className="w-full bg-[#0B0D11] border border-[#232834] rounded-lg px-2.5 py-1.5 text-xs text-white"
                    >
                      <option value="none">None (Clean)</option>
                      <option value="x-post">X/Twitter Card</option>
                      <option value="tiktok-hook">TikTok Hook Header</option>
                      <option value="breaking-news">Breaking News Banner</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Credit Handle</label>
                    <input
                      type="text"
                      value={branding.creditText}
                      onChange={(e) => setBranding({ ...branding, creditText: e.target.value })}
                      className="w-full bg-[#0B0D11] border border-[#232834] rounded-lg px-2.5 py-1.5 text-xs text-white"
                      placeholder="@creator"
                    />
                  </div>
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Watermark</label>
                    <input
                      type="text"
                      value={branding.watermarkText}
                      onChange={(e) => setBranding({ ...branding, watermarkText: e.target.value })}
                      className="w-full bg-[#0B0D11] border border-[#232834] rounded-lg px-2.5 py-1.5 text-xs text-white"
                      placeholder="Optional Watermark"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* STEP 4: Big Action Button */}
          <div>
            {jobError && (
              <div className="mb-4 flex items-center gap-2 text-xs text-rose-400 bg-rose-500/10 p-3.5 rounded-xl border border-rose-500/20">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{jobError}</span>
              </div>
            )}

            <button
              type="button"
              onClick={handleStartBatchProcess}
              disabled={submittingJob || parseResult.validCount === 0 || !videoUrl.trim()}
              className="w-full py-4 bg-rose-600 hover:bg-rose-500 text-white font-semibold rounded-2xl shadow-lg shadow-rose-600/20 flex items-center justify-center gap-2.5 transition-all transform active:scale-[0.99] disabled:opacity-50 disabled:pointer-events-none cursor-pointer"
            >
              {submittingJob ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Starting Batch Queue...</span>
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 fill-current" />
                  <span>
                    Process {parseResult.validCount} Segment{parseResult.validCount === 1 ? '' : 's'} with Auto-Facecam
                  </span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* Right Column: Live Batch Progress, Segment Cards & ZIP Export */}
        <div className="lg:col-span-5 space-y-6">
          <div className="bg-[#12151E] border border-[#232834] rounded-2xl p-6 sticky top-6">
            <div className="flex items-center justify-between pb-4 border-b border-[#232834] mb-4">
              <div className="flex items-center gap-2">
                <Film className="w-5 h-5 text-rose-500" />
                <h3 className="text-base font-semibold text-white">Batch Output & Status</h3>
              </div>
              {activeJob && (
                <span
                  className={`text-xs px-2.5 py-1 rounded-full font-medium capitalize ${
                    activeJob.status === 'completed'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : activeJob.status === 'running'
                        ? 'bg-rose-500/20 text-rose-300 animate-pulse'
                        : activeJob.status === 'partial_failure'
                          ? 'bg-amber-500/20 text-amber-300'
                          : 'bg-slate-700 text-slate-300'
                  }`}
                >
                  {activeJob.status.replace('_', ' ')}
                </span>
              )}
            </div>

            {/* Empty state when no job is active */}
            {!activeJob ? (
              <div className="py-12 px-4 text-center space-y-4">
                <div className="w-14 h-14 rounded-2xl bg-[#0B0D11] border border-[#232834] flex items-center justify-center mx-auto text-slate-500">
                  <Scissors className="w-6 h-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-300">Ready to Process</p>
                  <p className="text-xs text-slate-500 max-w-xs mx-auto mt-1">
                    Configure your source video and timestamp ranges on the left, then click Process
                    to start automated clipping.
                  </p>
                </div>
              </div>
            ) : (
              <div className="space-y-6">
                {/* Overall Batch Progress */}
                <div className="bg-[#0B0D11] border border-[#232834] rounded-xl p-4 space-y-3">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-white">{activeJob.stage}</span>
                    <span className="font-mono text-rose-400 font-semibold">
                      {activeJob.progress}%
                    </span>
                  </div>

                  <div className="w-full bg-[#1C212E] rounded-full h-2.5 overflow-hidden">
                    <div
                      className="bg-rose-600 h-2.5 rounded-full transition-all duration-300 ease-out"
                      style={{ width: `${Math.max(4, activeJob.progress)}%` }}
                    />
                  </div>

                  {activeJob.detail && (
                    <p className="text-[11px] text-slate-400 truncate">{activeJob.detail}</p>
                  )}
                </div>

                {/* Batch ZIP Download Button */}
                {activeJob.segments.some((s) => s.status === 'completed') && (
                  <div className="bg-gradient-to-r from-rose-950/30 to-purple-950/30 border border-rose-500/30 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div>
                        <h4 className="text-sm font-semibold text-white flex items-center gap-1.5">
                          <FolderArchive className="w-4 h-4 text-rose-400" />
                          <span>Batch ZIP Archive Ready</span>
                        </h4>
                        <p className="text-xs text-slate-400 mt-0.5">
                          {activeJob.segments.filter((s) => s.status === 'completed').length} clip(s) ready in original sequence
                        </p>
                      </div>
                    </div>
                    <a
                      href={`/api/v2/jobs/${activeJob.id}/download-all`}
                      download
                      className="w-full py-2.5 bg-rose-600 hover:bg-rose-500 text-white rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-colors cursor-pointer"
                    >
                      <Download className="w-4 h-4" />
                      <span>Download All as ZIP</span>
                    </a>
                  </div>
                )}

                {/* Segment Cards List */}
                <div className="space-y-3 max-h-[520px] overflow-y-auto pr-1">
                  {activeJob.segments.map((seg) => {
                    const isPreviewing = previewSegmentId === seg.id;
                    return (
                      <div
                        key={seg.id}
                        className="bg-[#0B0D11] border border-[#232834] rounded-xl p-3.5 space-y-2.5 text-xs"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className="w-5 h-5 rounded-md bg-[#1C212E] text-slate-300 font-mono flex items-center justify-center font-bold text-[10px]">
                              {seg.order}
                            </span>
                            <span className="font-mono text-slate-200">
                              {formatSecondsToTimecode(seg.startSeconds)} –{' '}
                              {formatSecondsToTimecode(seg.endSeconds)}
                            </span>
                            <span className="text-slate-500">({seg.durationSeconds}s)</span>
                          </div>

                          {/* Status Tag */}
                          <span
                            className={`px-2 py-0.5 rounded text-[10px] font-medium capitalize ${
                              seg.status === 'completed'
                                ? 'bg-emerald-500/20 text-emerald-300'
                                : seg.status === 'failed'
                                  ? 'bg-rose-500/20 text-rose-300'
                                  : 'bg-amber-500/20 text-amber-300 animate-pulse'
                            }`}
                          >
                            {seg.status}
                          </span>
                        </div>

                        {seg.label && (
                          <p className="text-slate-300 font-medium truncate">{seg.label}</p>
                        )}

                        {/* Facecam Detection & Effective Layout Badges */}
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          {/* Facecam Status */}
                          <span
                            className={`px-2 py-0.5 rounded border ${
                              seg.facecam.status === 'detected'
                                ? 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
                                : seg.facecam.status === 'not_found'
                                  ? 'bg-slate-900 border-slate-700 text-slate-400'
                                  : 'bg-[#161B26] border-[#2E3547] text-slate-400'
                            }`}
                          >
                            {seg.facecam.status === 'detected'
                              ? `Facecam: ${seg.facecam.positionLabel || 'Detected'} (${Math.round((seg.facecam.confidence || 0.8) * 100)}%)`
                              : seg.facecam.status === 'not_found'
                                ? 'No Facecam (Fallback to Gameplay)'
                                : 'Facecam: Pending'}
                          </span>

                          {/* Effective Layout */}
                          {seg.effectiveLayout && (
                            <span className="px-2 py-0.5 rounded bg-blue-950/40 border border-blue-500/30 text-blue-300">
                              Layout: {seg.effectiveLayout === 'center-crop-focus' ? 'Gameplay Only' : seg.effectiveLayout}
                            </span>
                          )}
                        </div>

                        {/* Progress Bar for Segment */}
                        {seg.status !== 'completed' && seg.status !== 'failed' && (
                          <div className="w-full bg-[#1C212E] rounded-full h-1.5 overflow-hidden">
                            <div
                              className="bg-amber-500 h-1.5 rounded-full transition-all duration-200"
                              style={{ width: `${Math.max(5, seg.progress)}%` }}
                            />
                          </div>
                        )}

                        {/* Error info if segment failed */}
                        {seg.error && (
                          <div className="text-[11px] text-rose-400 bg-rose-500/10 p-2 rounded">
                            {seg.error}
                          </div>
                        )}

                        {/* Video Player Preview if completed */}
                        {seg.status === 'completed' && seg.downloadUrl && isPreviewing && (
                          <div className="pt-2">
                            <video
                              src={seg.downloadUrl}
                              controls
                              autoPlay
                              className="w-full max-h-64 rounded-lg bg-black object-contain border border-[#232834]"
                            />
                          </div>
                        )}

                        {/* Actions for completed clip */}
                        {seg.status === 'completed' && seg.downloadUrl && (
                          <div className="flex items-center justify-end gap-2 pt-1">
                            <button
                              type="button"
                              onClick={() => setPreviewSegmentId(isPreviewing ? null : seg.id)}
                              className="px-2.5 py-1 text-slate-300 hover:text-white bg-[#1C212E] hover:bg-[#252B3B] rounded text-[11px] font-medium transition-colors cursor-pointer"
                            >
                              {isPreviewing ? 'Close Preview' : 'Preview'}
                            </button>

                            <a
                              href={`/api/v2/jobs/${activeJob.id}/download/${seg.id}`}
                              download={seg.outputFileName || `clip_${String(seg.order).padStart(3, '0')}.mp4`}
                              className="px-3 py-1 bg-rose-600 hover:bg-rose-500 text-white rounded text-[11px] font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                            >
                              <Download className="w-3 h-3" />
                              <span>Download MP4</span>
                            </a>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

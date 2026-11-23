import { useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  CheckSquare,
  Cookie,
  Download,
  ExternalLink,
  FileText,
  FolderOpen,
  HardDrive,
  Link2,
  Play,
  Scissors,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import type {
  AppSettings,
  StorageStatus,
  VideoProject,
  ViralMoment,
} from '../types';
import { formatTimecode, parseTimecodeInput, pollJobUntilDone } from '../lib/jobs';

interface IngestAnalyzeViewProps {
  projects: VideoProject[];
  activeProject: VideoProject | null;
  selectedMomentId: string | null;
  storageStatus: StorageStatus | null;
  appSettings: AppSettings;
  onSelectProject: (project: VideoProject) => void;
  onSelectMoment: (moment: ViralMoment) => void;
  onOpenFacecamStudio: (moment: ViralMoment) => void;
  onProjectCreated: (project: VideoProject) => void;
  onProjectUpdated: (project: VideoProject) => void;
  onProjectDeleted: (projectId: string) => void;
  onCleanupSource: (projectId: string) => Promise<void>;
  onPruneAllSources: () => Promise<void>;
  onUpdateAppSettings: (patch: Partial<AppSettings>) => Promise<void>;
}

function formatDiskBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '0 MB';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildExternalTimestampUrl(rawUrl: string | undefined, startSec: number): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    const sec = Math.max(0, Math.floor(startSec));
    const host = parsed.hostname.toLowerCase();
    if (host.includes('youtube.com') || host === 'youtu.be') {
      parsed.searchParams.set('t', `${sec}s`);
      return parsed.toString();
    }
    if (host.includes('twitch.tv')) {
      const h = Math.floor(sec / 3600);
      const m = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      parsed.searchParams.set('t', `${h}h${m}m${s}s`);
      return parsed.toString();
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function IngestAnalyzeView({
  projects,
  activeProject,
  selectedMomentId,
  storageStatus,
  appSettings,
  onSelectProject,
  onSelectMoment,
  onOpenFacecamStudio,
  onProjectCreated,
  onProjectUpdated,
  onProjectDeleted,
  onCleanupSource,
  onPruneAllSources,
  onUpdateAppSettings,
}: IngestAnalyzeViewProps) {
  const [urlInput, setUrlInput] = useState('');
  const [customTitle, setCustomTitle] = useState('');
  const [downloadFolder, setDownloadFolder] = useState('segments');
  const [transcriptInput, setTranscriptInput] = useState('');
  const [showTranscriptBox, setShowTranscriptBox] = useState(false);
  const [showUploadBox, setShowUploadBox] = useState(false);
  const [showCookiesBox, setShowCookiesBox] = useState(false);

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [cleaningId, setCleaningId] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [jobProgress, setJobProgress] = useState(0);
  const [jobStage, setJobStage] = useState('');
  const [jobDetail, setJobDetail] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const cookiesFileRef = useRef<HTMLInputElement | null>(null);

  const [currentTime, setCurrentTime] = useState(0);
  const [markIn, setMarkIn] = useState<number | null>(null);
  const [manualTitle, setManualTitle] = useState('');
  const [previewSrc, setPreviewSrc] = useState<string | null>(null);
  const [previewOffsetSec, setPreviewOffsetSec] = useState(0);
  const [jumpInput, setJumpInput] = useState('');

  const [cookiesText, setCookiesText] = useState('');
  const [cookiesStatus, setCookiesStatus] = useState<{
    configured: boolean;
    source: string;
    cookieCount: number;
  } | null>(null);
  const [cookiesBusy, setCookiesBusy] = useState(false);

  useEffect(() => {
    fetch('/api/ytdlp/cookies/status')
      .then((r) => r.json())
      .then((data) => setCookiesStatus(data))
      .catch(() => {});
  }, []);

  useEffect(() => {
    setPreviewSrc(null);
    setMarkIn(null);
    if (activeProject?.sourceMode === 'segments' && activeProject.moments[0]) {
      const m0 = activeProject.moments[0];
      const offset = m0.segmentStatus === 'ready' ? Math.floor(m0.startSec) : Math.max(0, Math.floor(m0.startSec - 2));
      setPreviewOffsetSec(offset);
      setCurrentTime(offset);
    } else {
      setPreviewOffsetSec(0);
      setCurrentTime(0);
    }
  }, [activeProject?.id]);

  const handleInspectLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!urlInput.trim()) return;
    setErrorMsg(null);
    setBusyAction('inspect');
    setJobProgress(4);
    setJobStage('Inspecting link (zero full download)...');
    setJobDetail('');

    try {
      const res = await fetch('/api/ingest/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: urlInput.trim(),
          title: customTitle.trim() || undefined,
          transcriptText: transcriptInput.trim() || undefined,
          downloadFolder: downloadFolder.trim() || 'segments',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Link inspection failed');

      let createdProject = data.project;
      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setJobProgress(job.progress);
          setJobStage(job.stage);
          setJobDetail(job.detail || '');
        });
        createdProject = done.project;
      }

      if (!createdProject) throw new Error('Inspection completed without returning moments.');
      setJobProgress(100);
      setPreviewSrc(null);
      onProjectCreated(createdProject);
      setUrlInput('');
      setCustomTitle('');
    } catch (err) {
      setJobProgress(0);
      const msg = err instanceof Error ? err.message : 'Link inspection failed';
      setErrorMsg(msg);
      if (msg.toLowerCase().includes('bot verification') || msg.toLowerCase().includes('cookies')) {
        setShowCookiesBox(true);
      }
    } finally {
      setBusyAction(null);
      setJobStage('');
      setJobDetail('');
      setTimeout(() => setJobProgress(0), 400);
    }
  };

  const handleDownloadSegments = async (momentIds?: string[]) => {
    if (!activeProject || activeProject.sourceMode !== 'segments') return;
    setErrorMsg(null);
    setBusyAction('download-segments');
    setJobProgress(5);
    setJobStage('Downloading selected moment(s) in 1080p...');
    setJobDetail('');

    try {
      const res = await fetch(`/api/projects/${activeProject.id}/download-segments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ momentIds }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '1080p segment download failed');

      if (data.alreadyReady && data.project) {
        onProjectUpdated(data.project);
        return;
      }

      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setJobProgress(job.progress);
          setJobStage(job.stage);
          setJobDetail(job.detail || '');
        });
        if (done.project) {
          onProjectUpdated(done.project);
        }
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '1080p segment download failed');
    } finally {
      setBusyAction(null);
      setJobStage('');
      setJobDetail('');
      setTimeout(() => setJobProgress(0), 400);
    }
  };

  const handleToggleMomentSelected = async (moment: ViralMoment) => {
    if (!activeProject) return;
    const res = await fetch(`/api/projects/${activeProject.id}/moments/${moment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selected: !moment.selected }),
    });
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
    }
  };

  const handleFileUpload = async (file: File) => {
    setErrorMsg(null);
    setBusyAction('upload');
    setJobProgress(5);
    setJobStage('Uploading local video...');
    setJobDetail(file.name);

    try {
      const form = new FormData();
      form.append('video', file);
      if (customTitle.trim()) form.append('title', customTitle.trim());
      if (transcriptInput.trim()) form.append('transcriptText', transcriptInput.trim());
      const res = await fetch('/api/ingest/upload', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      let createdProject = data.project;
      if (data.jobId) {
        const done = await pollJobUntilDone(data.jobId, (job) => {
          setJobProgress(job.progress);
          setJobStage(job.stage);
          setJobDetail(job.detail || '');
        });
        createdProject = done.project;
      }

      if (!createdProject) throw new Error('Upload failed.');
      onProjectCreated(createdProject);
      setShowUploadBox(false);
      setCustomTitle('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setBusyAction(null);
      setJobStage('');
      setJobDetail('');
      setTimeout(() => setJobProgress(0), 400);
    }
  };

  const handleGenerateSample = async () => {
    setErrorMsg(null);
    setBusyAction('sample');
    try {
      const res = await fetch('/api/ingest/sample', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Sample generation failed');
      onProjectCreated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Sample generation failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleReanalyzeTranscript = async () => {
    if (!activeProject) return;
    setBusyAction('reanalyze');
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/reanalyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptText: transcriptInput }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Re-analysis failed');
      onProjectUpdated(data.project);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Re-analysis failed');
    } finally {
      setBusyAction(null);
    }
  };

  const handleCreateManualClip = async (startSec: number, endSec: number) => {
    if (!activeProject) return;
    setErrorMsg(null);
    try {
      const res = await fetch(`/api/projects/${activeProject.id}/moments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startSec,
          endSec,
          title: manualTitle.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to mark clip');
      onProjectUpdated(data.project);
      onSelectMoment(data.moment);
      setMarkIn(null);
      setManualTitle('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to mark clip');
    }
  };

  const handleSaveCookies = async (rawText?: string) => {
    const payload = (rawText ?? cookiesText).trim();
    if (!payload) return;
    setCookiesBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch('/api/ytdlp/cookies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cookiesText: payload }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save cookies');
      setCookiesStatus(data);
      setCookiesText('');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save cookies');
    } finally {
      setCookiesBusy(false);
    }
  };

  const handleClearCookies = async () => {
    setCookiesBusy(true);
    try {
      const res = await fetch('/api/ytdlp/cookies', { method: 'DELETE' });
      const data = await res.json();
      if (res.ok) setCookiesStatus(data);
    } finally {
      setCookiesBusy(false);
    }
  };

  const seekVideoTo = (sec: number, moment?: ViralMoment) => {
    if (!activeProject) return;
    if (activeProject.sourceMode === 'segments') {
      const targetOffset =
        moment && moment.segmentStatus === 'ready'
          ? Math.floor(moment.startSec)
          : Math.max(0, Math.floor(sec - (moment ? 2 : 0)));
      const src = moment
        ? `/api/projects/${activeProject.id}/moments/${moment.id}/preview`
        : `/api/projects/${activeProject.id}/preview-window?start=${targetOffset}&dur=45`;
      setPreviewOffsetSec(targetOffset);
      setPreviewSrc(src);
      setCurrentTime(targetOffset);
      return;
    }
    if (videoRef.current) {
      videoRef.current.currentTime = sec;
      videoRef.current.play().catch(() => {});
    }
  };

  const selectedMomentsCount = activeProject?.moments.filter((m) => m.selected).length || 0;
  const pendingSelectedCount =
    activeProject?.sourceMode === 'segments'
      ? activeProject.moments.filter((m) => m.selected && m.segmentStatus !== 'ready').length
      : 0;
  const externalNowUrl = buildExternalTimestampUrl(activeProject?.sourceUrl, currentTime);

  return (
    <div className="space-y-8">
      {/* Step 1: Link Inspector (AI finds best moments first, downloads 0 full VODs) */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="font-display text-lg font-semibold text-[#F4F5F7]">
              Inspect Video Link & Find Best Moments
            </h2>
            <p className="text-sm text-[#94A3B8] mt-1">
              Paste a YouTube, Twitch, Kick, or direct stream link. AI scans heatmaps, captions, and audio spikes first—downloading only your chosen 1080p moments.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setShowUploadBox((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors whitespace-nowrap cursor-pointer"
            >
              <Upload className="w-3.5 h-3.5" />
              {showUploadBox ? 'Hide Local Upload' : 'Local File'}
            </button>
            <button
              type="button"
              onClick={handleGenerateSample}
              disabled={busyAction !== null}
              className="px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {busyAction === 'sample' ? 'Synthesizing...' : 'Test Sample'}
            </button>
          </div>
        </div>

        <form onSubmit={handleInspectLink} className="space-y-3">
          <div className="flex flex-col sm:flex-row gap-2.5">
            <div className="relative flex-1">
              <Link2 className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                type="url"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="https://www.youtube.com/watch?v=... or https://www.twitch.tv/videos/..."
                className="w-full pl-9 pr-3 py-2.5 text-sm bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
              />
            </div>
            <button
              type="submit"
              disabled={busyAction !== null || !urlInput.trim()}
              className="px-5 py-2.5 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:opacity-50"
            >
              {busyAction === 'inspect' ? 'Inspecting Link...' : 'Find Best Moments'}
            </button>
          </div>

          {(busyAction === 'inspect' || busyAction === 'download-segments' || busyAction === 'upload') && (
            <div className="bg-[#0E1016] border border-[#232834] rounded-lg p-3 space-y-1.5">
              <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                <span className="text-[#F4F5F7]">{jobStage}</span>
                <span className="text-rose-400">{jobProgress}%</span>
              </div>
              <div className="w-full h-1.5 bg-[#13161D] rounded-full overflow-hidden">
                <div
                  className="h-full bg-rose-500 transition-all duration-300"
                  style={{ width: `${jobProgress}%` }}
                />
              </div>
              {jobDetail && (
                <p className="text-[11px] font-mono text-[#94A3B8] truncate">{jobDetail}</p>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
            <div className="flex flex-wrap items-center gap-3">
              <input
                type="text"
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="Optional project title"
                className="w-48 px-3 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
              />
              <div className="flex items-center gap-1.5 bg-[#0E1016] border border-[#232834] rounded-md px-2.5 py-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-[#94A3B8] shrink-0" />
                <span className="text-[11px] font-mono text-[#64748B]">workspace/sources/</span>
                <input
                  type="text"
                  value={downloadFolder}
                  onChange={(e) => setDownloadFolder(e.target.value)}
                  placeholder="segments"
                  className="w-20 text-xs font-mono bg-transparent text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
                />
              </div>
              <button
                type="button"
                onClick={() => setShowTranscriptBox((v) => !v)}
                className="inline-flex items-center gap-1.5 text-xs text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5" />
                {showTranscriptBox ? 'Hide Transcript' : 'Manual Transcript'}
              </button>
              <button
                type="button"
                onClick={() => setShowCookiesBox((v) => !v)}
                className={`inline-flex items-center gap-1.5 text-xs cursor-pointer whitespace-nowrap ${
                  cookiesStatus?.configured
                    ? 'text-emerald-400 hover:text-emerald-300'
                    : 'text-[#94A3B8] hover:text-[#F4F5F7]'
                }`}
              >
                <Cookie className="w-3.5 h-3.5" />
                {cookiesStatus?.configured
                  ? `YouTube Cookies (${cookiesStatus.cookieCount})`
                  : 'YouTube Cookies'}
              </button>
            </div>

            {/* Auto-Prune Setting */}
            <button
              type="button"
              role="switch"
              aria-checked={appSettings.autoPruneSourceVod}
              disabled={settingsBusy}
              onClick={async () => {
                setSettingsBusy(true);
                try {
                  await onUpdateAppSettings({
                    autoPruneSourceVod: !appSettings.autoPruneSourceVod,
                  });
                } finally {
                  setSettingsBusy(false);
                }
              }}
              title="Automatically delete temporary 1080p segments from workspace/sources once all queued 9:16 Shorts finish rendering"
              className="inline-flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer whitespace-nowrap disabled:opacity-50"
            >
              <span
                className={`w-8 h-4.5 rounded-full p-0.5 transition-colors flex items-center ${
                  appSettings.autoPruneSourceVod ? 'bg-emerald-500 justify-end' : 'bg-[#2B3242] justify-start'
                }`}
              >
                <span className="w-3.5 h-3.5 rounded-full bg-white block" />
              </span>
              <span>Auto-Prune Segments After Render</span>
            </button>
          </div>
        </form>

        {showUploadBox && (
          <div
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const file = e.dataTransfer.files?.[0];
              if (file) handleFileUpload(file);
            }}
            className="pt-4 border-t border-[#232834] flex flex-wrap items-center justify-between gap-4"
          >
            <div>
              <p className="text-xs font-medium text-[#F4F5F7]">Upload a Local Video File</p>
              <p className="text-[11px] text-[#94A3B8]">
                Supports MP4, MOV, MKV, or WebM files already on your computer.
              </p>
            </div>
            <div>
              <input
                ref={fileInputRef}
                type="file"
                accept="video/mp4,video/quicktime,video/webm,video/x-matroska,.mp4,.mov,.webm,.mkv"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) handleFileUpload(file);
                }}
              />
              <button
                type="button"
                disabled={busyAction !== null}
                onClick={() => fileInputRef.current?.click()}
                className="px-4 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg cursor-pointer disabled:opacity-50"
              >
                Choose Video File
              </button>
            </div>
          </div>
        )}

        {showTranscriptBox && (
          <div className="pt-4 border-t border-[#232834] space-y-2.5">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-[#CBD5E1]">
                Transcript / SRT Override (auto-fetched from links when available)
              </label>
              {activeProject && (
                <button
                  type="button"
                  onClick={handleReanalyzeTranscript}
                  disabled={busyAction !== null}
                  className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
                >
                  {busyAction === 'reanalyze' ? 'Re-scoring...' : 'Re-score Moments'}
                </button>
              )}
            </div>
            <textarea
              rows={3}
              value={transcriptInput}
              onChange={(e) => setTranscriptInput(e.target.value)}
              placeholder="Optional: paste .srt cues or transcript text to guide AI moment detection..."
              className="w-full p-3 text-xs font-mono bg-[#0E1016] border border-[#232834] rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none focus:border-rose-500"
            />
          </div>
        )}

        {showCookiesBox && (
          <div className="pt-4 border-t border-[#232834] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-xs font-medium text-[#CBD5E1]">
                  YouTube Cookies (Netscape cookies.txt or Cookie header)
                </p>
                <p className="text-[11px] text-[#94A3B8] mt-0.5">
                  Only needed if YouTube requests sign-in verification from this server IP.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <input
                  ref={cookiesFileRef}
                  type="file"
                  accept=".txt,text/plain"
                  className="hidden"
                  onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    await handleSaveCookies(await file.text());
                  }}
                />
                <button
                  type="button"
                  disabled={cookiesBusy}
                  onClick={() => cookiesFileRef.current?.click()}
                  className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
                >
                  Upload cookies.txt
                </button>
                {cookiesStatus?.configured && cookiesStatus.source === 'workspace' && (
                  <button
                    type="button"
                    disabled={cookiesBusy}
                    onClick={handleClearCookies}
                    className="px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-rose-950/60 border border-[#32394A] rounded-md text-rose-300 cursor-pointer"
                  >
                    Clear
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-col sm:flex-row gap-2">
              <textarea
                rows={2}
                value={cookiesText}
                onChange={(e) => setCookiesText(e.target.value)}
                placeholder="# Netscape HTTP Cookie File..."
                className="flex-1 p-2.5 text-xs font-mono bg-[#0E1016] border border-[#232834] rounded-lg text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
              />
              <button
                type="button"
                disabled={cookiesBusy || !cookiesText.trim()}
                onClick={() => handleSaveCookies()}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
              >
                Save Cookies
              </button>
            </div>
          </div>
        )}

        {errorMsg && (
          <div className="px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
            {errorMsg}
          </div>
        )}
      </section>

      {/* Inspected Projects List */}
      {projects.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display text-sm font-semibold text-[#CBD5E1]">
              Inspected Videos ({projects.length})
            </h3>
            {storageStatus && storageStatus.totalSourceBytes > 0 && (
              <div className="flex items-center gap-3 text-xs">
                <span className="font-mono tabular-nums text-[#94A3B8]">
                  Cached 1080p segments: {formatDiskBytes(storageStatus.totalSourceBytes)}
                </span>
                <button
                  type="button"
                  disabled={cleaningId !== null}
                  onClick={async () => {
                    setCleaningId('all');
                    try {
                      await onPruneAllSources();
                    } finally {
                      setCleaningId(null);
                    }
                  }}
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium bg-[#1C212C] hover:bg-rose-950/60 border border-[#32394A] rounded-md text-amber-300 cursor-pointer disabled:opacity-50"
                >
                  <HardDrive className="w-3.5 h-3.5" />
                  {cleaningId === 'all' ? 'Cleaning...' : 'Free All Segment Files'}
                </button>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {projects.map((p) => {
              const isSelected = activeProject?.id === p.id;
              const readyCount = p.moments.filter((m) => m.segmentStatus === 'ready').length;
              const segBytes = p.moments.reduce((s, m) => s + (m.segmentSizeBytes || 0), 0);
              const totalBytes = p.sourceMode === 'local' ? p.sourceSizeBytes || 0 : segBytes;

              return (
                <div
                  key={p.id}
                  onClick={() => onSelectProject(p)}
                  className={`flex items-center gap-3 p-3 rounded-xl border transition-colors cursor-pointer ${
                    isSelected
                      ? 'bg-[#171B24] border-rose-500/80'
                      : 'bg-[#13161D] border-[#232834] hover:border-[#343C4E]'
                  }`}
                >
                  <div className="w-24 h-14 bg-[#0B0D11] rounded-md overflow-hidden shrink-0 border border-[#232834]">
                    {p.previewFrames[0] ? (
                      <img src={p.previewFrames[0]} alt={p.title} className="w-full h-full object-cover" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-[10px] text-[#64748B]">
                        No frame
                      </div>
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-[#F4F5F7] truncate">{p.title}</p>
                    <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5 truncate">
                      {p.sourceType.toUpperCase()} · {formatTimecode(p.durationSec)} · {p.moments.length} moments
                    </p>
                    <p className="text-[11px] font-mono text-[#64748B] truncate mt-0.5">
                      {p.sourceMode === 'segments'
                        ? `${readyCount}/${p.moments.length} 1080p parts (${formatDiskBytes(totalBytes)})`
                        : p.sourceDeleted
                          ? 'Source pruned'
                          : `Local file (${formatDiskBytes(totalBytes)})`}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="Delete project"
                    onClick={(e) => {
                      e.stopPropagation();
                      onProjectDeleted(p.id);
                    }}
                    className="p-1.5 text-[#64748B] hover:text-rose-400 rounded-md cursor-pointer shrink-0"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Active Project Workspace: Left Preview + Right AI Moments & Selective 1080p Download */}
      {activeProject ? (
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-6 items-start">
          {/* Left: On-Demand Preview + Audio Waveform + Custom Timecode Mark */}
          <div className="xl:col-span-5 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="font-display text-base font-semibold text-[#F4F5F7] truncate">
                  {activeProject.title}
                </h3>
                <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5 truncate">
                  {activeProject.width}×{activeProject.height} · {formatTimecode(activeProject.durationSec)}
                  {activeProject.autoTranscriptFetched ? ' · Captions read by AI' : ''}
                </p>
              </div>
              {externalNowUrl && (
                <a
                  href={externalNowUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-rose-400 hover:text-rose-300 whitespace-nowrap shrink-0"
                >
                  Open Source Tab
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}
            </div>

            {activeProject.sourceMode === 'local' && activeProject.sourceDeleted ? (
              <div className="aspect-video bg-[#0E1016] rounded-lg border border-[#232834] flex flex-col items-center justify-center p-6 text-center space-y-1.5">
                <HardDrive className="w-6 h-6 text-[#64748B]" />
                <p className="text-sm font-medium text-[#CBD5E1]">Source File Pruned</p>
                <p className="text-xs text-[#94A3B8]">
                  Rendered 9:16 Shorts remain available in Rendered Shorts.
                </p>
              </div>
            ) : activeProject.sourceMode === 'segments' ? (
              <div className="space-y-2">
                <div className="aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                  {previewSrc || activeProject.moments[0] ? (
                    <video
                      ref={videoRef}
                      key={
                        previewSrc ||
                        `/api/projects/${activeProject.id}/moments/${activeProject.moments[0].id}/preview`
                      }
                      src={
                        previewSrc ||
                        `/api/projects/${activeProject.id}/moments/${activeProject.moments[0].id}/preview`
                      }
                      controls
                      onTimeUpdate={(e) =>
                        setCurrentTime(previewOffsetSec + e.currentTarget.currentTime)
                      }
                      className="w-full h-full object-contain"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-xs text-[#64748B]">
                      Click any moment to preview its segment
                    </div>
                  )}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    const parsed = parseTimecodeInput(jumpInput);
                    if (parsed !== null) {
                      seekVideoTo(Math.min(Math.max(0, activeProject.durationSec - 10), parsed));
                    }
                  }}
                  className="flex items-center gap-2 text-xs"
                >
                  <input
                    type="text"
                    value={jumpInput}
                    onChange={(e) => setJumpInput(e.target.value)}
                    placeholder="Jump to time (e.g. 01:24:10)"
                    className="flex-1 px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] font-mono outline-none focus:border-rose-500"
                  />
                  <button
                    type="submit"
                    className="px-3 py-1.5 bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer whitespace-nowrap"
                  >
                    Preview Window
                  </button>
                </form>
              </div>
            ) : (
              <div className="aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
                <video
                  ref={videoRef}
                  key={activeProject.fileName}
                  src={`/api/sources/${activeProject.fileName}`}
                  controls
                  onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
                  className="w-full h-full object-contain"
                />
              </div>
            )}

            {/* Audio Energy Spike Timeline */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between text-xs text-[#94A3B8]">
                <span>Audio Energy Timeline (click to preview)</span>
                <span className="font-mono tabular-nums">
                  {formatTimecode(currentTime)} / {formatTimecode(activeProject.durationSec)}
                </span>
              </div>
              <div className="h-16 bg-[#0E1016] border border-[#232834] rounded-lg px-2 py-1.5 flex items-end gap-[2px] overflow-hidden">
                {activeProject.audioEnergySeries.map((pt) => {
                  const inSelected = activeProject.moments.some(
                    (m) => m.id === selectedMomentId && pt.sec >= m.startSec && pt.sec <= m.endSec
                  );
                  const isSpike = pt.normalized >= 0.72;
                  return (
                    <button
                      key={pt.sec}
                      type="button"
                      title={`${formatTimecode(pt.sec)} · ${pt.db} dB`}
                      onClick={() => seekVideoTo(pt.sec)}
                      style={{ height: `${Math.max(12, Math.round(pt.normalized * 100))}%` }}
                      className={`flex-1 min-w-[3px] rounded-t-[2px] cursor-pointer ${
                        inSelected
                          ? 'bg-rose-500'
                          : isSpike
                            ? 'bg-amber-500/85 hover:bg-amber-400'
                            : 'bg-[#333C4D] hover:bg-[#4B576E]'
                      }`}
                    />
                  );
                })}
              </div>
            </div>

            {/* Add Custom Moment */}
            <div className="pt-3 border-t border-[#232834] space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-[#CBD5E1]">Add Custom Moment</span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMarkIn(Math.round(currentTime * 10) / 10)}
                    className="px-2.5 py-1.5 text-xs font-mono tabular-nums bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer"
                  >
                    {markIn !== null ? `In: ${formatTimecode(markIn)}` : 'Mark In'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const start =
                        markIn !== null ? Math.min(markIn, currentTime) : Math.max(0, currentTime - 15);
                      const end = Math.max(start + 5, currentTime);
                      handleCreateManualClip(start, end);
                    }}
                    className="px-2.5 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-md cursor-pointer"
                  >
                    {markIn !== null ? 'Save Clip Range' : 'Mark Last 15s'}
                  </button>
                </div>
              </div>
              <input
                type="text"
                value={manualTitle}
                onChange={(e) => setManualTitle(e.target.value)}
                placeholder="Optional title for custom clip..."
                className="w-full px-3 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
              />
            </div>
          </div>

          {/* Right: AI-Selected Moments & Selective 1080p Download */}
          <div className="xl:col-span-7 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
                  AI-Picked Moments ({selectedMomentsCount}/{activeProject.moments.length} selected)
                </h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Check the moments you want, then download only those clips in 1080p or open the Layout Studio to render vertical Shorts.
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {activeProject.sourceMode === 'segments' && pendingSelectedCount > 0 && (
                  <button
                    type="button"
                    disabled={busyAction !== null}
                    onClick={() => handleDownloadSegments()}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <Download className="w-3.5 h-3.5 text-emerald-400" />
                    Download {pendingSelectedCount} Selected in 1080p
                  </button>
                )}

                {activeProject.moments.some((m) => m.segmentStatus === 'ready') && (
                  <button
                    type="button"
                    disabled={cleaningId !== null}
                    onClick={async () => {
                      setCleaningId(activeProject.id);
                      try {
                        await onCleanupSource(activeProject.id);
                      } finally {
                        setCleaningId(null);
                      }
                    }}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-rose-950/60 border border-[#32394A] text-amber-300 rounded-lg cursor-pointer whitespace-nowrap disabled:opacity-50"
                  >
                    <HardDrive className="w-3.5 h-3.5" />
                    {cleaningId === activeProject.id ? 'Pruning...' : 'Delete Cached Segments'}
                  </button>
                )}

                <button
                  type="button"
                  onClick={() => {
                    const firstSelected =
                      activeProject.moments.find((m) => m.selected) || activeProject.moments[0];
                    if (firstSelected) onOpenFacecamStudio(firstSelected);
                  }}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer whitespace-nowrap"
                >
                  <Scissors className="w-3.5 h-3.5" />
                  Layout & Render Selected
                  <ArrowRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="divide-y divide-[#232834]">
              {activeProject.moments.map((moment, idx) => {
                const isFocused = selectedMomentId === moment.id;
                const extLink = buildExternalTimestampUrl(activeProject.sourceUrl, moment.startSec);

                return (
                  <div
                    key={moment.id}
                    onClick={() => {
                      onSelectMoment(moment);
                      seekVideoTo(moment.startSec, moment);
                    }}
                    className={`py-4 px-3 -mx-3 rounded-lg transition-colors cursor-pointer ${
                      isFocused ? 'bg-[#191E29]' : 'hover:bg-[#171B24]/60'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        aria-label={moment.selected ? 'Deselect moment' : 'Select moment'}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleMomentSelected(moment);
                        }}
                        className="mt-0.5 text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer shrink-0"
                      >
                        {moment.selected ? (
                          <CheckSquare className="w-4 h-4 text-rose-500" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>

                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-[#94A3B8]">
                          <span className="text-rose-400 font-semibold">#{idx + 1}</span>
                          <span>
                            {formatTimecode(moment.startSec)} – {formatTimecode(moment.endSec)}
                          </span>
                          <span aria-hidden="true">·</span>
                          <span>{moment.durationSec}s</span>
                          <span aria-hidden="true">·</span>
                          <span>{moment.audioPeakDb} dB</span>
                          <span aria-hidden="true">·</span>
                          <span
                            className={
                              moment.segmentStatus === 'ready'
                                ? 'text-emerald-400'
                                : moment.segmentStatus === 'pruned'
                                  ? 'text-amber-300'
                                  : moment.segmentStatus === 'error'
                                    ? 'text-rose-400'
                                    : 'text-[#64748B]'
                            }
                          >
                            {moment.segmentStatus === 'ready'
                              ? activeProject.sourceMode === 'local'
                                ? 'Local source ready'
                                : `1080p Ready (${formatDiskBytes(moment.segmentSizeBytes)})`
                              : moment.segmentStatus === 'pruned'
                                ? 'Segment pruned'
                                : moment.segmentStatus === 'error'
                                  ? 'Download error'
                                  : 'Not downloaded (0 MB)'}
                          </span>
                        </div>

                        <p className="text-sm font-semibold text-[#F4F5F7]">{moment.title}</p>

                        <p className="text-xs text-[#94A3B8]">
                          {moment.reason}
                          {moment.scoredBy ? ` · ${moment.scoredBy}` : ''}
                        </p>

                        {moment.transcriptSnippet && (
                          <p className="text-xs text-[#CBD5E1] italic line-clamp-2">
                            “{moment.transcriptSnippet}”
                          </p>
                        )}
                      </div>
                    </div>

                    <div className="mt-3 pl-7 flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-4 text-xs">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectMoment(moment);
                            seekVideoTo(moment.startSec, moment);
                          }}
                          className="inline-flex items-center gap-1.5 text-[#94A3B8] hover:text-[#F4F5F7] cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5" />
                          Preview
                        </button>

                        {extLink && (
                          <a
                            href={extLink}
                            target="_blank"
                            rel="noopener noreferrer"
                            onClick={(e) => e.stopPropagation()}
                            className="inline-flex items-center gap-1 text-[#94A3B8] hover:text-[#F4F5F7]"
                          >
                            Verify in Tab
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                      </div>

                      <div className="flex items-center gap-2">
                        {activeProject.sourceMode === 'segments' && moment.segmentStatus !== 'ready' && (
                          <button
                            type="button"
                            disabled={busyAction !== null}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownloadSegments([moment.id]);
                            }}
                            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-md cursor-pointer disabled:opacity-50"
                          >
                            <Download className="w-3.5 h-3.5 text-emerald-400" />
                            Get 1080p Clip
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenFacecamStudio(moment);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-rose-600 hover:bg-rose-500 text-white rounded-md transition-colors cursor-pointer"
                        >
                          <Scissors className="w-3.5 h-3.5" />
                          Render 9:16
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        <div className="bg-[#13161D] border border-[#232834] rounded-xl p-10 text-center space-y-2.5">
          <Sparkles className="w-7 h-7 text-rose-500 mx-auto" />
          <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
            Paste Any Link Above to Begin
          </h3>
          <p className="text-sm text-[#94A3B8] max-w-lg mx-auto">
            ClipForge inspects heatmaps, captions, and audio energy first without downloading gigabytes—then grabs only the moments you pick in 1080p before rendering vertical Shorts.
          </p>
        </div>
      )}
    </div>
  );
}

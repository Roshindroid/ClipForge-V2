import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Camera,
  Check,
  CheckSquare,
  Film,
  Layers,
  Play,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Video,
} from 'lucide-react';
import type {
  BrandingConfig,
  ClipProject,
  FacecamBox,
  LayoutId,
  ProjectSegment,
  TemplateId,
} from '../types';
import { LAYOUT_OPTIONS } from '../types';
import { formatSecondsToTimecode } from '../lib/timestampParser';
import { LayoutThumbnail } from './LayoutThumbnail';

interface FacecamLayoutStudioProps {
  project: ClipProject;
  onProjectUpdated: (project: ClipProject) => void;
  onGoToMyClips: () => void;
}

const TEMPLATES: Array<{ id: TemplateId; label: string; desc: string }> = [
  { id: 'none', label: 'Clean Raw', desc: 'Zero overlay chrome' },
  { id: 'x-post', label: 'X Post Card', desc: 'Top tweet-style header' },
  { id: 'tiktok-hook', label: 'Hook Banner', desc: 'Bold top headline strip' },
  { id: 'breaking-news', label: 'Breaking News', desc: 'Lower broadcast chyron' },
];

type HandleDir = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val));
}

function clampBox(box: FacecamBox): FacecamBox {
  const width = clamp(box.width, 0.05, 1);
  const height = clamp(box.height, 0.05, 1);
  const x = clamp(box.x, 0, Math.max(0, 1 - width));
  const y = clamp(box.y, 0, Math.max(0, 1 - height));
  return {
    x: Math.round(x * 1000) / 1000,
    y: Math.round(y * 1000) / 1000,
    width: Math.round(width * 1000) / 1000,
    height: Math.round(height * 1000) / 1000,
  };
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function FacecamLayoutStudio({
  project,
  onProjectUpdated,
  onGoToMyClips,
}: FacecamLayoutStudioProps) {
  const [activeSegmentId, setActiveSegmentId] = useState<string>(
    project.segments[0]?.id || ''
  );
  const [selectedSegmentIds, setSelectedSegmentIds] = useState<string[]>(() =>
    project.segments.filter((s) => s.downloadStatus === 'ready').map((s) => s.id)
  );

  const activeSegment: ProjectSegment | undefined =
    project.segments.find((s) => s.id === activeSegmentId) || project.segments[0];

  // Local editing state synced to active segment / project defaults
  const resolvedFacecam: FacecamBox | null = activeSegment
    ? activeSegment.hasCustomFacecam
      ? activeSegment.facecamBox
      : (activeSegment.facecamBox ?? project.sharedFacecamBox)
    : project.sharedFacecamBox;

  const resolvedLayout: LayoutId = activeSegment
    ? activeSegment.hasCustomLayout
      ? activeSegment.layoutId
      : project.sharedLayoutId
    : project.sharedLayoutId;

  const [draftBox, setDraftBox] = useState<FacecamBox | null>(resolvedFacecam);
  const [draftLayoutId, setDraftLayoutId] = useState<LayoutId>(resolvedLayout);
  const [templateId, setTemplateId] = useState<TemplateId>(project.templateId);
  const [resolution, setResolution] = useState<'1080x1920' | '720x1280'>(project.resolution);
  const [frameRate, setFrameRate] = useState<'original' | '60' | '30'>(project.frameRate);
  const [branding, setBranding] = useState<BrandingConfig>(project.branding);
  const [clipTitle, setClipTitle] = useState<string>(activeSegment?.title || '');
  const [clipHook, setClipHook] = useState<string>(activeSegment?.hookTagline || '');

  const [frameFraction, setFrameFraction] = useState<number>(0.5);
  const [activeFrameUrl, setActiveFrameUrl] = useState<string>(
    activeSegment?.frameUrl || ''
  );
  const [isDraggingBox, setIsDraggingBox] = useState(false);

  // Live FFmpeg 9:16 preview states
  const [previewImgUrl, setPreviewImgUrl] = useState<string | null>(null);
  const [previewImgLoading, setPreviewImgLoading] = useState(false);
  const [previewImgError, setPreviewImgError] = useState<string | null>(null);
  const [previewVideoUrl, setPreviewVideoUrl] = useState<string | null>(null);
  const [previewVideoLoading, setPreviewVideoLoading] = useState(false);

  // Source modal player for reviewing downloaded segment
  const [sourcePreviewSeg, setSourcePreviewSeg] = useState<ProjectSegment | null>(null);

  // Status & actions
  const [savingNotice, setSavingNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [submittingRender, setSubmittingRender] = useState(false);

  // Sync local editor when project ID or activeSegment ID changes
  const lastSyncRef = useRef<string>('');
  useEffect(() => {
    const key = `${project.id}:${activeSegment?.id || ''}`;
    if (lastSyncRef.current !== key) {
      lastSyncRef.current = key;
      const seg = project.segments.find((s) => s.id === activeSegment?.id) || project.segments[0];
      const nextCam = seg
        ? seg.hasCustomFacecam
          ? seg.facecamBox
          : (seg.facecamBox ?? project.sharedFacecamBox)
        : project.sharedFacecamBox;
      const nextLayout = seg
        ? seg.hasCustomLayout
          ? seg.layoutId
          : project.sharedLayoutId
        : project.sharedLayoutId;
      setDraftBox(nextCam);
      setDraftLayoutId(nextLayout);
      setTemplateId(project.templateId);
      setResolution(project.resolution);
      setFrameRate(project.frameRate);
      setBranding(project.branding);
      setClipTitle(seg?.title || '');
      setClipHook(seg?.hookTagline || '');
      setFrameFraction(0.5);
      setActiveFrameUrl(seg?.frameUrl || '');
      setPreviewVideoUrl(null);
      setActionError(null);
    }
  }, [project, activeSegment?.id]);

  // Keep activeFrameUrl updated once a segment finishes downloading
  useEffect(() => {
    if (activeSegment?.frameUrl && frameFraction === 0.5) {
      setActiveFrameUrl(activeSegment.frameUrl);
    }
  }, [activeSegment?.frameUrl, frameFraction]);

  // Ensure selectedSegmentIds stays valid when segments change
  useEffect(() => {
    const validIds = new Set(project.segments.map((s) => s.id));
    setSelectedSegmentIds((prev) => {
      const filtered = prev.filter((id) => validIds.has(id));
      if (filtered.length === 0 && project.segments.some((s) => s.downloadStatus === 'ready')) {
        return project.segments.filter((s) => s.downloadStatus === 'ready').map((s) => s.id);
      }
      return filtered;
    });
  }, [project.segments]);

  const prevPreviewUrlRef = useRef<string | null>(null);

  // Fetch exact FFmpeg 9:16 composite preview whenever layout/box/template/branding/frame settles
  useEffect(() => {
    if (
      !activeSegment ||
      activeSegment.downloadStatus !== 'ready' ||
      !activeFrameUrl ||
      isDraggingBox
    ) {
      return;
    }

    const layoutMeta = LAYOUT_OPTIONS.find((l) => l.id === draftLayoutId);
    if (layoutMeta?.usesFacecam && !draftBox) {
      setPreviewImgError(
        'Draw a facecam box in Panel 1 to preview this layout, or choose Center Crop.'
      );
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
        prevPreviewUrlRef.current = null;
      }
      setPreviewImgUrl(null);
      return;
    }

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setPreviewImgLoading(true);
      setPreviewImgError(null);
      try {
        const res = await fetch(
          `/api/projects/${project.id}/segments/${activeSegment.id}/preview-frame`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
              layoutId: draftLayoutId,
              templateId,
              facecamBox: draftBox,
              branding,
              hookTagline: clipHook || clipTitle || activeSegment.title,
              fraction: frameFraction,
            }),
          }
        );
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new Error(data.error || 'Could not render preview');
        }
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (prevPreviewUrlRef.current) {
          URL.revokeObjectURL(prevPreviewUrlRef.current);
        }
        prevPreviewUrlRef.current = url;
        setPreviewImgUrl(url);
      } catch (err) {
        if ((err as Error).name !== 'AbortError') {
          setPreviewImgError(err instanceof Error ? err.message : 'Preview error');
        }
      } finally {
        setPreviewImgLoading(false);
      }
    }, 160);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    project.id,
    activeSegment?.id,
    activeSegment?.downloadStatus,
    activeFrameUrl,
    draftBox,
    draftLayoutId,
    templateId,
    branding,
    clipHook,
    clipTitle,
    frameFraction,
    isDraggingBox,
  ]);

  useEffect(() => {
    return () => {
      if (prevPreviewUrlRef.current) {
        URL.revokeObjectURL(prevPreviewUrlRef.current);
      }
    };
  }, []);

  // Fast 60fps canvas fallback ONLY while dragging/resizing box
  const dragCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sourceImgRef = useRef<HTMLImageElement | null>(null);

  useEffect(() => {
    if (!isDraggingBox || !draftBox || !activeFrameUrl) return;
    const canvas = dragCanvasRef.current;
    const img = sourceImgRef.current;
    if (!canvas || !img || !img.complete || img.naturalWidth === 0) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.fillStyle = branding.backgroundHex || '#0B0D11';
    ctx.fillRect(0, 0, W, H);

    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const cx = draftBox.x * iw;
    const cy = draftBox.y * ih;
    const cw = Math.max(8, draftBox.width * iw);
    const ch = Math.max(8, draftBox.height * ih);

    const drawCover = (
      sx: number,
      sy: number,
      sw: number,
      sh: number,
      dx: number,
      dy: number,
      dw: number,
      dh: number
    ) => {
      const srcAspect = sw / Math.max(1, sh);
      const dstAspect = dw / Math.max(1, dh);
      let rx = sx,
        ry = sy,
        rw = sw,
        rh = sh;
      if (srcAspect > dstAspect) {
        rw = sh * dstAspect;
        rx = sx + (sw - rw) / 2;
      } else {
        rh = sw / dstAspect;
        ry = sy + (sh - rh) / 2;
      }
      ctx.drawImage(img, rx, ry, rw, rh, dx, dy, dw, dh);
    };

    if (draftLayoutId === 'center-crop-focus') {
      drawCover(0, 0, iw, ih, 0, 0, W, H);
    } else if (draftLayoutId === 'facecam-only-zoom') {
      drawCover(cx, cy, cw, ch, 0, 0, W, H);
    } else if (
      draftLayoutId === 'split-top-cam' ||
      draftLayoutId === 'split-bottom-cam' ||
      draftLayoutId === 'split-50-50'
    ) {
      const camH = draftLayoutId === 'split-50-50' ? H * 0.5 : H * 0.35;
      const mainH = H - camH;
      if (draftLayoutId === 'split-bottom-cam') {
        drawCover(0, 0, iw, ih, 0, 0, W, mainH);
        drawCover(cx, cy, cw, ch, 0, mainH, W, camH);
      } else {
        drawCover(cx, cy, cw, ch, 0, 0, W, camH);
        drawCover(0, 0, iw, ih, 0, camH, W, mainH);
      }
    } else if (draftLayoutId.startsWith('pip-')) {
      drawCover(0, 0, iw, ih, 0, 0, W, H);
      const pw = Math.round(W * 0.31);
      const ph = pw;
      const mx = Math.round(W * 0.04);
      const topY = Math.round(H * 0.11);
      const botY = H - ph - Math.round(H * 0.14);
      const px = draftLayoutId.endsWith('right') ? W - pw - mx : mx;
      const py = draftLayoutId.includes('top') ? topY : botY;
      drawCover(cx, cy, cw, ch, px, py, pw, ph);
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = 2;
      ctx.strokeRect(px, py, pw, ph);
    } else {
      ctx.save();
      ctx.filter = 'blur(8px)';
      drawCover(0, 0, iw, ih, 0, 0, W, H);
      ctx.restore();
      const fitH = Math.round((W * ih) / Math.max(1, iw));
      const fy = Math.round((H - fitH) / 2);
      ctx.drawImage(img, 0, 0, iw, ih, 0, fy, W, fitH);
      const cwOut = Math.round(W * 0.39);
      const chOut = Math.round(H * 0.18);
      const cxOut = Math.round((W - cwOut) / 2);
      const cyOut =
        draftLayoutId === 'blurred-bg-cam-top'
          ? Math.round(H * 0.085)
          : H - chOut - Math.round(H * 0.1);
      drawCover(cx, cy, cw, ch, cxOut, cyOut, cwOut, chOut);
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.strokeRect(cxOut, cyOut, cwOut, chOut);
    }
  }, [isDraggingBox, draftBox, draftLayoutId, activeFrameUrl, branding.backgroundHex]);

  // --- Frame Interactive Draw / Drag / 8-Handle Resize ---
  const frameContainerRef = useRef<HTMLDivElement | null>(null);

  const handleDrawNewBoxMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !activeSegment || activeSegment.downloadStatus !== 'ready') return;
    const rect = frameContainerRef.current?.getBoundingClientRect();
    if (!rect) return;
    e.preventDefault();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const normStartX = clamp((startClientX - rect.left) / rect.width, 0, 0.95);
    const normStartY = clamp((startClientY - rect.top) / rect.height, 0, 0.95);
    setIsDraggingBox(true);
    setPreviewVideoUrl(null);

    const onMove = (ev: MouseEvent) => {
      const curX = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
      const curY = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
      const left = Math.min(normStartX, curX);
      const top = Math.min(normStartY, curY);
      const width = Math.max(0.05, Math.abs(curX - normStartX));
      const height = Math.max(0.05, Math.abs(curY - normStartY));
      setDraftBox(clampBox({ x: left, y: top, width, height }));
    };

    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      const dx = Math.abs(ev.clientX - startClientX);
      const dy = Math.abs(ev.clientY - startClientY);
      if (dx < 6 && dy < 6) {
        // Simple click without drag: center a 24%x28% box around click point
        const clickX = clamp((ev.clientX - rect.left) / rect.width, 0, 1);
        const clickY = clamp((ev.clientY - rect.top) / rect.height, 0, 1);
        const w = draftBox?.width || 0.24;
        const h = draftBox?.height || 0.28;
        setDraftBox(clampBox({ x: clickX - w / 2, y: clickY - h / 2, width: w, height: h }));
      }
      setIsDraggingBox(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleMoveBoxMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !draftBox) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = frameContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...draftBox };
    setIsDraggingBox(true);
    setPreviewVideoUrl(null);

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;
      setDraftBox(
        clampBox({
          x: clamp(orig.x + dx, 0, 1 - orig.width),
          y: clamp(orig.y + dy, 0, 1 - orig.height),
          width: orig.width,
          height: orig.height,
        })
      );
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDraggingBox(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  const handleResizeMouseDown = (dir: HandleDir, e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !draftBox) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = frameContainerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const orig = { ...draftBox };
    const origRight = orig.x + orig.width;
    const origBottom = orig.y + orig.height;
    setIsDraggingBox(true);
    setPreviewVideoUrl(null);

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / rect.width;
      const dy = (ev.clientY - startY) / rect.height;

      let left = orig.x;
      let top = orig.y;
      let right = origRight;
      let bottom = origBottom;

      if (dir.includes('w')) left = clamp(orig.x + dx, 0, origRight - 0.05);
      if (dir.includes('e')) right = clamp(origRight + dx, orig.x + 0.05, 1);
      if (dir.includes('n')) top = clamp(orig.y + dy, 0, origBottom - 0.05);
      if (dir.includes('s')) bottom = clamp(origBottom + dy, orig.y + 0.05, 1);

      setDraftBox(
        clampBox({
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        })
      );
    };

    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      setIsDraggingBox(false);
    };

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  // --- API Persistence Actions ---

  const flashNotice = (msg: string) => {
    setSavingNotice(msg);
    setTimeout(() => setSavingNotice((curr) => (curr === msg ? null : curr)), 2600);
  };

  const handleScrubFrame = async (frac: number) => {
    if (!activeSegment || activeSegment.downloadStatus !== 'ready') return;
    setFrameFraction(frac);
    try {
      const res = await fetch(
        `/api/projects/${project.id}/segments/${activeSegment.id}/frame?fraction=${frac}`
      );
      const data = await res.json();
      if (res.ok && data.frameUrl) {
        setActiveFrameUrl(data.frameUrl);
      }
    } catch {
      // ignore scrub error
    }
  };

  const handleSaveFacecamSegment = async () => {
    if (!activeSegment) return;
    setActionError(null);
    const res = await fetch(
      `/api/projects/${project.id}/segments/${activeSegment.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          facecamBox: draftBox,
          hasCustomFacecam: true,
          title: clipTitle.trim() || activeSegment.title,
          hookTagline: clipHook,
        }),
      }
    );
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
      flashNotice('Saved to segment');
    } else {
      setActionError(data.error || 'Could not save facecam box.');
    }
  };

  const handleApplyFacecamBulk = async (target: 'selected' | 'all') => {
    setActionError(null);
    const body =
      target === 'all'
        ? { facecamBox: draftBox }
        : { facecamBox: draftBox, segmentIds: selectedSegmentIds };
    const res = await fetch(`/api/projects/${project.id}/apply-facecam`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
      flashNotice(target === 'all' ? 'Facecam applied to all' : 'Facecam applied to selected');
    } else {
      setActionError(data.error || 'Could not apply facecam region.');
    }
  };

  const persistProjectSettings = async (patch: Record<string, unknown>) => {
    const res = await fetch(`/api/projects/${project.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
    }
  };

  const handleSelectLayout = async (nextLayoutId: LayoutId) => {
    setDraftLayoutId(nextLayoutId);
    setPreviewVideoUrl(null);
    if (!activeSegment) return;
    const res = await fetch(
      `/api/projects/${project.id}/segments/${activeSegment.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          layoutId: nextLayoutId,
          hasCustomLayout: true,
        }),
      }
    );
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
    }
  };

  const handleApplyLayoutBulk = async (target: 'selected' | 'all') => {
    setActionError(null);
    const body =
      target === 'all'
        ? { layoutId: draftLayoutId }
        : { layoutId: draftLayoutId, segmentIds: selectedSegmentIds };
    const res = await fetch(`/api/projects/${project.id}/apply-layout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
      flashNotice(target === 'all' ? 'Layout applied to all' : 'Layout applied to selected');
    } else {
      setActionError(data.error || 'Could not apply layout.');
    }
  };

  const handleSaveSegmentMeta = async () => {
    if (!activeSegment) return;
    await fetch(`/api/projects/${project.id}/segments/${activeSegment.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: clipTitle.trim() || activeSegment.title,
        hookTagline: clipHook,
      }),
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.project) onProjectUpdated(d.project);
      })
      .catch(() => {});
  };

  const handleRetrySegmentDownload = async (segmentId: string) => {
    setActionError(null);
    const res = await fetch(`/api/projects/${project.id}/download-segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ segmentIds: [segmentId] }),
    });
    const data = await res.json();
    if (res.ok && data.project) {
      onProjectUpdated(data.project);
    } else {
      setActionError(data.error || 'Could not restart segment download.');
    }
  };

  const handleGenerateVideoPreview = async () => {
    if (!activeSegment || activeSegment.downloadStatus !== 'ready') return;
    setPreviewVideoLoading(true);
    setActionError(null);
    try {
      const res = await fetch(
        `/api/projects/${project.id}/segments/${activeSegment.id}/preview-video`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            layoutId: draftLayoutId,
            templateId,
            facecamBox: draftBox,
            branding,
            hookTagline: clipHook || clipTitle || activeSegment.title,
          }),
        }
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Video preview failed');
      setPreviewVideoUrl(`${data.previewUrl}?t=${Date.now()}`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Video preview failed');
    } finally {
      setPreviewVideoLoading(false);
    }
  };

  const handleStartRender = async (mode: 'selected' | 'all') => {
    setActionError(null);
    setSubmittingRender(true);
    try {
      // Save any pending text edits + project branding/template/res/fps first
      await handleSaveSegmentMeta();
      await persistProjectSettings({
        templateId,
        resolution,
        frameRate,
        branding,
      });

      const targetIds =
        mode === 'all'
          ? project.segments.filter((s) => s.downloadStatus === 'ready').map((s) => s.id)
          : selectedSegmentIds;

      const res = await fetch(`/api/projects/${project.id}/render`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ segmentIds: targetIds }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Could not start rendering.');
      }
      if (data.project) {
        onProjectUpdated(data.project);
      }
      flashNotice(`Queued ${data.queuedCount} clip(s)`);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Render validation failed');
    } finally {
      setSubmittingRender(false);
    }
  };

  const readySegments = useMemo(
    () => project.segments.filter((s) => s.downloadStatus === 'ready'),
    [project.segments]
  );

  const anyRendering = project.segments.some(
    (s) => s.renderStatus === 'queued' || s.renderStatus === 'rendering'
  );
  const completedCount = project.segments.filter(
    (s) => s.renderStatus === 'completed'
  ).length;

  const selectedLayoutMeta =
    LAYOUT_OPTIONS.find((l) => l.id === draftLayoutId) || LAYOUT_OPTIONS[0];

  const srcWidth = activeSegment?.width || project.width || 1920;
  const srcHeight = activeSegment?.height || project.height || 1080;

  // Check missing facecam warnings for selected segments
  const missingFacecamWarnings = useMemo(() => {
    const ids = new Set(selectedSegmentIds);
    return project.segments.filter((s) => {
      if (!ids.has(s.id) || s.downloadStatus !== 'ready') return false;
      const effLayout = s.hasCustomLayout ? s.layoutId : project.sharedLayoutId;
      if (effLayout === 'center-crop-focus') return false;
      const effCam =
        s.id === activeSegment?.id
          ? draftBox
          : s.hasCustomFacecam
            ? s.facecamBox
            : (s.facecamBox ?? project.sharedFacecamBox);
      return !effCam;
    });
  }, [project, selectedSegmentIds, activeSegment?.id, draftBox]);

  const toggleSelectSegment = (id: string) => {
    setSelectedSegmentIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
  };

  return (
    <div className="space-y-5">
      {/* Segment Library */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <h2 className="font-display text-sm font-semibold text-[#F4F5F7]">
              Segment Library ({project.segments.length})
            </h2>
            <span className="text-xs text-[#94A3B8]">
              {readySegments.length}/{project.segments.length} downloaded · {completedCount} rendered
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() =>
                setSelectedSegmentIds(
                  selectedSegmentIds.length === readySegments.length
                    ? []
                    : readySegments.map((s) => s.id)
                )
              }
              className="px-2.5 py-1.5 bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-md text-[#CBD5E1] cursor-pointer"
            >
              {selectedSegmentIds.length === readySegments.length && readySegments.length > 0
                ? 'Clear Selection'
                : 'Select All Ready'}
            </button>
            <button
              type="button"
              disabled={!draftBox || selectedSegmentIds.length === 0}
              onClick={() => handleApplyFacecamBulk('selected')}
              className="px-2.5 py-1.5 bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-md text-[#CBD5E1] cursor-pointer disabled:opacity-40"
            >
              Apply Facecam to Selected
            </button>
            <button
              type="button"
              disabled={!draftBox}
              onClick={() => handleApplyFacecamBulk('all')}
              className="px-2.5 py-1.5 bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-md text-[#CBD5E1] cursor-pointer disabled:opacity-40"
            >
              Apply Facecam to All
            </button>
            <button
              type="button"
              disabled={selectedSegmentIds.length === 0}
              onClick={() => handleApplyLayoutBulk('selected')}
              className="px-2.5 py-1.5 bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-md text-[#CBD5E1] cursor-pointer disabled:opacity-40"
            >
              Apply Layout to Selected
            </button>
            <button
              type="button"
              onClick={() => handleApplyLayoutBulk('all')}
              className="px-2.5 py-1.5 bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] rounded-md text-[#CBD5E1] cursor-pointer"
            >
              Apply Layout to All
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-2.5 max-h-[260px] overflow-y-auto pr-1">
          {project.segments.map((seg) => {
            const isActive = activeSegment?.id === seg.id;
            const isSelected = selectedSegmentIds.includes(seg.id);
            const effLayout = seg.hasCustomLayout ? seg.layoutId : project.sharedLayoutId;
            const effCam = seg.hasCustomFacecam
              ? seg.facecamBox
              : (seg.facecamBox ?? project.sharedFacecamBox);

            return (
              <div
                key={seg.id}
                onClick={() => setActiveSegmentId(seg.id)}
                className={`p-3 rounded-lg border transition-colors cursor-pointer flex items-start gap-2.5 ${
                  isActive
                    ? 'bg-[#191E29] border-rose-500'
                    : 'bg-[#0E1016] border-[#232834] hover:border-[#343C4E]'
                }`}
              >
                <button
                  type="button"
                  aria-label={`Select segment ${seg.order}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (seg.downloadStatus === 'ready') toggleSelectSegment(seg.id);
                  }}
                  disabled={seg.downloadStatus !== 'ready'}
                  className="mt-0.5 text-[#94A3B8] hover:text-white disabled:opacity-30 cursor-pointer shrink-0"
                >
                  {isSelected ? (
                    <CheckSquare className="w-4 h-4 text-rose-500" />
                  ) : (
                    <Square className="w-4 h-4" />
                  )}
                </button>

                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#F4F5F7] truncate">
                      #{seg.order} · {seg.title}
                    </span>
                    <span className="text-[11px] font-mono tabular-nums text-[#94A3B8] shrink-0">
                      {seg.durationSeconds}s
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-mono text-[#64748B]">
                    <span>
                      {formatSecondsToTimecode(seg.startSeconds)}–
                      {formatSecondsToTimecode(seg.endSeconds)}
                    </span>
                    <span>·</span>
                    <span>{formatBytes(seg.sourceSizeBytes)}</span>
                    <span>·</span>
                    <span className="text-[#94A3B8]">
                      {LAYOUT_OPTIONS.find((l) => l.id === effLayout)?.shortLabel || effLayout}
                    </span>
                    {effCam ? (
                      <span className="text-emerald-400">· Cam Set</span>
                    ) : effLayout !== 'center-crop-focus' ? (
                      <span className="text-amber-400">· Needs Cam</span>
                    ) : null}
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <div className="flex items-center gap-1.5 text-[11px]">
                      {seg.downloadStatus === 'ready' && (
                        <span className="text-emerald-400 font-medium">Downloaded</span>
                      )}
                      {seg.downloadStatus === 'downloading' && (
                        <span className="text-sky-400 font-mono">
                          Downloading {seg.downloadProgress}%
                        </span>
                      )}
                      {(seg.downloadStatus === 'error' ||
                        seg.downloadStatus === 'interrupted' ||
                        seg.downloadStatus === 'pending') && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRetrySegmentDownload(seg.id);
                          }}
                          className="inline-flex items-center gap-1 text-amber-300 hover:text-amber-200 underline cursor-pointer"
                        >
                          <RefreshCw className="w-3 h-3" />
                          {seg.downloadStatus === 'pending' ? 'Download' : 'Retry Download'}
                        </button>
                      )}

                      {seg.renderStatus === 'queued' && (
                        <span className="text-[#94A3B8]">· Queued</span>
                      )}
                      {seg.renderStatus === 'rendering' && (
                        <span className="text-rose-400 font-mono">
                          · Rendering {seg.renderProgress}%
                        </span>
                      )}
                      {seg.renderStatus === 'completed' && (
                        <span className="text-emerald-400 font-medium">· Rendered</span>
                      )}
                      {(seg.renderStatus === 'failed' || seg.renderStatus === 'interrupted') && (
                        <span
                          title={seg.renderError}
                          className="text-rose-400 font-medium"
                        >
                          · {seg.renderStatus === 'interrupted' ? 'Interrupted' : 'Failed'}
                        </span>
                      )}
                    </div>

                    {seg.downloadStatus === 'ready' && seg.sourceFileName && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSourcePreviewSeg(seg);
                        }}
                        className="inline-flex items-center gap-1 text-[11px] text-[#94A3B8] hover:text-white cursor-pointer"
                      >
                        <Play className="w-3 h-3" />
                        Source
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* Main 3-Panel Manual Workspace (Matching Reference Screenshot Layout) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-5 items-start">
        {/* Panel 1: Source Facecam Region */}
        <section className="xl:col-span-4 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                1. Source Facecam Region
              </h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Draw a box on the frame, drag to move, or drag handles to resize.
              </p>
            </div>
            <button
              type="button"
              onClick={handleSaveFacecamSegment}
              disabled={!activeSegment}
              className="px-2.5 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-md text-[#F4F5F7] cursor-pointer whitespace-nowrap shrink-0"
            >
              {savingNotice === 'Saved to segment' ? 'Saved' : 'Save Box'}
            </button>
          </div>

          <div
            ref={frameContainerRef}
            onMouseDown={handleDrawNewBoxMouseDown}
            className="relative aspect-video bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834] select-none cursor-crosshair"
          >
            {activeFrameUrl ? (
              <img
                ref={sourceImgRef}
                src={activeFrameUrl}
                alt="Selected segment frame"
                draggable={false}
                className="w-full h-full object-fill"
              />
            ) : (
              <div className="w-full h-full flex flex-col items-center justify-center text-xs text-[#64748B] px-4 text-center gap-1.5">
                <Camera className="w-5 h-5" />
                <span>
                  {activeSegment?.downloadStatus === 'downloading'
                    ? `Downloading segment (${activeSegment.downloadProgress}%)...`
                    : 'Download segment to extract source frame.'}
                </span>
              </div>
            )}

            {draftBox && (
              <div
                onMouseDown={handleMoveBoxMouseDown}
                style={{
                  left: `${draftBox.x * 100}%`,
                  top: `${draftBox.y * 100}%`,
                  width: `${draftBox.width * 100}%`,
                  height: `${draftBox.height * 100}%`,
                }}
                className="absolute border-2 border-rose-500 bg-rose-500/20 cursor-move"
              >
                <span className="inline-block bg-rose-600 text-white text-[10px] font-mono px-1.5 py-0.5 rounded-br-[2px]">
                  FACECAM
                </span>

                {/* 8 Resize Handles */}
                <div
                  onMouseDown={(e) => handleResizeMouseDown('nw', e)}
                  className="absolute -top-1.5 -left-1.5 w-3 h-3 bg-white border border-rose-600 rounded-[2px] cursor-nwse-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('n', e)}
                  className="absolute -top-1.5 left-1/2 -translate-x-1/2 w-3 h-2.5 bg-white border border-rose-600 rounded-[2px] cursor-ns-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('ne', e)}
                  className="absolute -top-1.5 -right-1.5 w-3 h-3 bg-white border border-rose-600 rounded-[2px] cursor-nesw-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('e', e)}
                  className="absolute top-1/2 -translate-y-1/2 -right-1.5 w-2.5 h-3 bg-white border border-rose-600 rounded-[2px] cursor-ew-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('se', e)}
                  className="absolute -bottom-1.5 -right-1.5 w-3 h-3 bg-white border border-rose-600 rounded-[2px] cursor-nwse-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('s', e)}
                  className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-3 h-2.5 bg-white border border-rose-600 rounded-[2px] cursor-ns-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('sw', e)}
                  className="absolute -bottom-1.5 -left-1.5 w-3 h-3 bg-white border border-rose-600 rounded-[2px] cursor-nesw-resize"
                />
                <div
                  onMouseDown={(e) => handleResizeMouseDown('w', e)}
                  className="absolute top-1/2 -translate-y-1/2 -left-1.5 w-2.5 h-3 bg-white border border-rose-600 rounded-[2px] cursor-ew-resize"
                />
              </div>
            )}
          </div>

          {/* Frame Time Scrub & Quick Box Reset */}
          <div className="flex items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-1.5">
              <span className="text-[#64748B]">Frame:</span>
              {[0.15, 0.5, 0.85].map((frac) => (
                <button
                  key={frac}
                  type="button"
                  disabled={!activeSegment || activeSegment.downloadStatus !== 'ready'}
                  onClick={() => handleScrubFrame(frac)}
                  className={`px-2 py-1 rounded border text-[11px] font-mono cursor-pointer disabled:opacity-40 ${
                    Math.abs(frameFraction - frac) < 0.05
                      ? 'bg-[#1C212C] border-rose-500 text-white'
                      : 'bg-[#0E1016] border-[#232834] text-[#94A3B8] hover:text-white'
                  }`}
                >
                  {Math.round(frac * 100)}%
                </button>
              ))}
            </div>

            {draftBox ? (
              <button
                type="button"
                onClick={() => {
                  setDraftBox(null);
                  setPreviewVideoUrl(null);
                }}
                className="inline-flex items-center gap-1 px-2 py-1 text-[11px] text-[#94A3B8] hover:text-rose-300 border border-[#232834] rounded cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Clear Box
              </button>
            ) : (
              <button
                type="button"
                onClick={() =>
                  setDraftBox({ x: 0.72, y: 0.65, width: 0.24, height: 0.28 })
                }
                className="px-2 py-1 text-[11px] text-rose-300 hover:text-rose-200 border border-rose-800/60 bg-rose-950/30 rounded cursor-pointer"
              >
                + Add Box
              </button>
            )}
          </div>

          {/* Coordinate & Pixel Readout */}
          {draftBox ? (
            <div className="bg-[#0E1016] border border-[#232834] rounded-lg px-3 py-2 text-[11px] font-mono tabular-nums text-[#94A3B8] flex flex-wrap items-center justify-between gap-2">
              <span>
                Norm: x={Math.round(draftBox.x * 100)}% y={Math.round(draftBox.y * 100)}% w=
                {Math.round(draftBox.width * 100)}% h={Math.round(draftBox.height * 100)}%
              </span>
              <span className="text-[#CBD5E1]">
                {Math.round(draftBox.x * srcWidth)},{Math.round(draftBox.y * srcHeight)} ·{' '}
                {Math.round(draftBox.width * srcWidth)}×{Math.round(draftBox.height * srcHeight)}px
              </span>
            </div>
          ) : (
            <div className="bg-[#0E1016] border border-[#232834] rounded-lg px-3 py-2 text-xs text-[#94A3B8]">
              No facecam box set. Click or drag on the frame above to mark your facecam, or use Center Crop.
            </div>
          )}

          {/* Manual Width / Height Sliders */}
          <div className="grid grid-cols-2 gap-3 pt-2 border-t border-[#232834] text-xs">
            <label className="space-y-1">
              <span className="text-[#94A3B8] flex justify-between font-mono tabular-nums">
                <span>Cam Width</span>
                <span>{draftBox ? `${Math.round(draftBox.width * 100)}%` : '—'}</span>
              </span>
              <input
                type="range"
                min={5}
                max={80}
                disabled={!draftBox}
                value={draftBox ? Math.round(draftBox.width * 100) : 24}
                onChange={(e) => {
                  const w = Number(e.target.value) / 100;
                  setDraftBox((p) => (p ? clampBox({ ...p, width: w }) : null));
                }}
                className="w-full accent-rose-500 disabled:opacity-40"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[#94A3B8] flex justify-between font-mono tabular-nums">
                <span>Cam Height</span>
                <span>{draftBox ? `${Math.round(draftBox.height * 100)}%` : '—'}</span>
              </span>
              <input
                type="range"
                min={5}
                max={80}
                disabled={!draftBox}
                value={draftBox ? Math.round(draftBox.height * 100) : 28}
                onChange={(e) => {
                  const h = Number(e.target.value) / 100;
                  setDraftBox((p) => (p ? clampBox({ ...p, height: h }) : null));
                }}
                className="w-full accent-rose-500 disabled:opacity-40"
              />
            </label>
          </div>
        </section>

        {/* Panel 2: Live 9:16 Preview (Real FFmpeg Composite) */}
        <section className="xl:col-span-3 bg-[#13161D] border border-[#232834] rounded-xl p-5 flex flex-col items-center space-y-3">
          <div className="w-full flex items-center justify-between gap-2">
            <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
              2. Live 9:16 Preview
            </h3>
            <span className="text-[11px] font-mono text-[#94A3B8]">
              {selectedLayoutMeta.shortLabel}
            </span>
          </div>

          <div
            style={{ backgroundColor: branding.backgroundHex }}
            className="w-[243px] h-[432px] rounded-xl overflow-hidden border border-[#2E3545] relative shrink-0 select-none flex items-center justify-center"
          >
            {previewVideoUrl ? (
              <video
                src={previewVideoUrl}
                controls
                autoPlay
                playsInline
                className="w-full h-full object-contain bg-black"
              />
            ) : isDraggingBox ? (
              <canvas
                ref={dragCanvasRef}
                width={270}
                height={480}
                className="w-full h-full object-contain"
              />
            ) : previewImgUrl ? (
              <img
                src={previewImgUrl}
                alt="Live FFmpeg 9:16 preview"
                className="w-full h-full object-contain"
              />
            ) : (
              <div className="p-4 text-center text-xs text-[#94A3B8] space-y-2">
                {previewImgError ? (
                  <p className="text-amber-300 leading-relaxed">{previewImgError}</p>
                ) : (
                  <p>Select a downloaded segment to render its live 9:16 FFmpeg preview.</p>
                )}
              </div>
            )}

            {previewImgLoading && !isDraggingBox && !previewVideoUrl && (
              <span className="absolute top-2 right-2 px-1.5 py-0.5 rounded bg-black/70 text-[10px] font-mono text-[#CBD5E1]">
                Updating...
              </span>
            )}
          </div>

          <p className="text-[11px] text-[#94A3B8] text-center leading-relaxed">
            {selectedLayoutMeta.description}
          </p>

          <div className="w-full flex items-center gap-2 pt-1">
            {previewVideoUrl ? (
              <button
                type="button"
                onClick={() => setPreviewVideoUrl(null)}
                className="w-full py-1.5 px-3 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
              >
                Back to Frame Preview
              </button>
            ) : (
              <button
                type="button"
                disabled={!activeSegment || activeSegment.downloadStatus !== 'ready' || previewVideoLoading}
                onClick={handleGenerateVideoPreview}
                className="w-full py-1.5 px-3 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] inline-flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-45"
              >
                <Video className="w-3.5 h-3.5 text-rose-400" />
                {previewVideoLoading ? 'Rendering Preview Video...' : 'Play 9:16 Video Preview'}
              </button>
            )}
          </div>
        </section>

        {/* Panel 3: Vertical Layout & Render */}
        <section className="xl:col-span-5 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-5">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                3. Vertical Layout & Render
              </h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Choose a vertical layout and render your downloaded segments into 9:16 Shorts.
              </p>
            </div>
            {savingNotice && (
              <span className="text-[11px] font-medium text-emerald-400 whitespace-nowrap">
                {savingNotice}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {LAYOUT_OPTIONS.map((opt) => {
              const active = draftLayoutId === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => handleSelectLayout(opt.id)}
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

          {/* Optional Header Overlay */}
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
                  onClick={() => {
                    setTemplateId(t.id);
                    persistProjectSettings({ templateId: t.id });
                  }}
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

            {/* Branding + Output Settings */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Credit Handle</span>
                <input
                  type="text"
                  value={branding.creditText}
                  onChange={(e) => setBranding((b) => ({ ...b, creditText: e.target.value }))}
                  onBlur={() => persistProjectSettings({ branding })}
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Corner Watermark</span>
                <input
                  type="text"
                  value={branding.watermarkText}
                  onChange={(e) => setBranding((b) => ({ ...b, watermarkText: e.target.value }))}
                  onBlur={() => persistProjectSettings({ branding })}
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
                    onChange={(e) => {
                      const next = { ...branding, backgroundHex: e.target.value };
                      setBranding(next);
                      persistProjectSettings({ branding: next });
                    }}
                    className="h-8 w-10 bg-transparent border border-[#232834] rounded cursor-pointer"
                  />
                  <span className="font-mono text-[11px] text-[#94A3B8]">
                    {branding.backgroundHex}
                  </span>
                </div>
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Output Resolution</span>
                <select
                  value={resolution}
                  onChange={(e) => {
                    const next = e.target.value as '1080x1920' | '720x1280';
                    setResolution(next);
                    persistProjectSettings({ resolution: next });
                  }}
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                >
                  <option value="1080x1920">1080×1920 (Full HD 9:16)</option>
                  <option value="720x1280">720×1280 (Fast 9:16)</option>
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-[#94A3B8]">Frame Rate</span>
                <select
                  value={frameRate}
                  onChange={(e) => {
                    const next = e.target.value as 'original' | '60' | '30';
                    setFrameRate(next);
                    persistProjectSettings({ frameRate: next });
                  }}
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                >
                  <option value="original">Original FPS</option>
                  <option value="60">60 FPS</option>
                  <option value="30">30 FPS</option>
                </select>
              </label>
            </div>

            <div className="space-y-2 pt-1">
              <label className="block space-y-1 text-xs">
                <span className="text-[#94A3B8]">
                  Segment #{activeSegment?.order || 1} Clip Title & Hook Tagline
                </span>
                <input
                  type="text"
                  value={clipTitle}
                  onChange={(e) => setClipTitle(e.target.value)}
                  onBlur={handleSaveSegmentMeta}
                  placeholder="Clip title"
                  className="w-full px-2.5 py-1.5 bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
                />
              </label>
              <input
                type="text"
                value={clipHook}
                onChange={(e) => setClipHook(e.target.value)}
                onBlur={handleSaveSegmentMeta}
                placeholder="Optional 1-line overlay hook tagline"
                className="w-full px-2.5 py-1.5 text-xs bg-[#0E1016] border border-[#232834] rounded-md text-[#F4F5F7] outline-none"
              />
            </div>
          </div>

          {missingFacecamWarnings.length > 0 && (
            <div className="px-3 py-2.5 text-xs text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-lg flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-400" />
              <span>
                {missingFacecamWarnings.length} selected segment(s) use a facecam layout without a saved facecam box. Draw and apply a box in Panel 1, or switch to Center Crop.
              </span>
            </div>
          )}

          {actionError && (
            <div className="px-3 py-2.5 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
              {actionError}
            </div>
          )}

          <div className="flex flex-col sm:flex-row gap-2.5">
            <button
              type="button"
              onClick={() => handleStartRender('selected')}
              disabled={submittingRender || anyRendering || selectedSegmentIds.length === 0}
              className="flex-1 py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
            >
              <Film className="w-4 h-4" />
              {anyRendering
                ? 'Rendering Queue Active...'
                : `Render Selected (${selectedSegmentIds.length})`}
            </button>

            <button
              type="button"
              onClick={() => handleStartRender('all')}
              disabled={submittingRender || anyRendering || readySegments.length === 0}
              className="px-4 py-3 bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] text-xs font-semibold rounded-lg transition-colors flex items-center justify-center gap-1.5 cursor-pointer whitespace-nowrap disabled:opacity-45"
            >
              Render All ({readySegments.length})
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#94A3B8]">
            <span className="inline-flex items-center gap-1.5">
              <Check className="w-3.5 h-3.5 text-emerald-400" />
              {resolution} H.264 MP4 · Saved locally in workspace/renders
            </span>
            {completedCount > 0 && (
              <button
                type="button"
                onClick={onGoToMyClips}
                className="text-rose-400 hover:text-rose-300 font-semibold cursor-pointer"
              >
                Open My Clips ({completedCount}) →
              </button>
            )}
          </div>
        </section>
      </div>

      {/* Source Segment Preview Modal */}
      {sourcePreviewSeg && sourcePreviewSeg.sourceFileName && (
        <div className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4">
          <div className="bg-[#13161D] border border-[#2E3545] rounded-xl max-w-2xl w-full p-5 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-display text-sm font-semibold text-[#F4F5F7]">
                #{sourcePreviewSeg.order} · {sourcePreviewSeg.title} ({sourcePreviewSeg.durationSeconds}s)
              </h3>
              <button
                type="button"
                onClick={() => setSourcePreviewSeg(null)}
                className="px-2.5 py-1 text-xs bg-[#1C212C] border border-[#32394A] rounded text-[#CBD5E1] cursor-pointer"
              >
                Close
              </button>
            </div>
            <video
              src={`/api/sources/${sourcePreviewSeg.sourceFileName}`}
              controls
              autoPlay
              className="w-full aspect-video bg-black rounded-lg border border-[#232834]"
            />
          </div>
        </div>
      )}
    </div>
  );
}

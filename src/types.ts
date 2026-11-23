export type PlatformType = 'youtube' | 'twitch' | 'kick' | 'local' | 'direct';

export type LayoutId =
  | 'split-top-cam'
  | 'split-bottom-cam'
  | 'split-50-50'
  | 'pip-top-left'
  | 'pip-top-right'
  | 'pip-bottom-left'
  | 'pip-bottom-right'
  | 'blurred-bg-cam-top'
  | 'blurred-bg-cam-bottom'
  | 'center-crop-focus'
  | 'facecam-only-zoom';

export type TemplateId = 'none' | 'x-post' | 'tiktok-hook' | 'breaking-news';

export type SegmentDownloadStatus = 'pending' | 'downloading' | 'ready' | 'pruned' | 'error';

export interface FacecamBox {
  /** Normalized 0..1 coordinates relative to source video dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  confidence: number;
  presetLabel: string;
}

export interface AudioEnergyPoint {
  sec: number;
  db: number;
  normalized: number;
}

export interface BrandingConfig {
  creditText: string;
  backgroundHex: string;
  watermarkText: string;
}

export interface ViralMoment {
  id: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  title: string;
  hookTagline: string;
  description: string;
  hashtags: string[];
  audioPeakDb: number;
  audioSpikeScore: number;
  transcriptScore: number;
  llmScore: number;
  finalRankScore: number;
  reason: string;
  scoredBy?: string;
  transcriptSnippet: string;
  selected: boolean;
  segmentStatus: SegmentDownloadStatus;
  segmentFileName?: string;
  segmentSizeBytes?: number;
  segmentError?: string;
}

export interface VideoChapter {
  startSec: number;
  endSec: number;
  title: string;
}

export interface HeatmapPoint {
  startSec: number;
  endSec: number;
  value: number;
}

export interface VideoProject {
  id: string;
  title: string;
  sourceType: PlatformType;
  /** 'segments' = URL inspected remotely; only selected moments download in 1080p. 'local' = uploaded/sample MP4 */
  sourceMode: 'segments' | 'local';
  downloadFolder?: string;
  sourceUrl?: string;
  fileName?: string;
  sourceSizeBytes?: number;
  sourceDeleted?: boolean;
  autoTranscriptFetched?: boolean;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  previewFrames: string[];
  audioEnergySeries: AudioEnergyPoint[];
  detectedFacecam: FacecamBox;
  facecamCandidates: FacecamBox[];
  moments: ViralMoment[];
  chapters?: VideoChapter[];
  heatmapPeaks?: HeatmapPoint[];
  transcriptText?: string;
  createdAt: string;
}

export interface StorageStatus {
  sourcesDir: string;
  rendersDir: string;
  totalSourceBytes: number;
  totalRenderBytes: number;
  activeSegmentCount: number;
}

export interface AppSettings {
  autoPruneSourceVod: boolean;
}

export interface RenderedClip {
  id: string;
  projectId: string;
  momentId: string;
  title: string;
  hookTagline: string;
  description: string;
  hashtags: string[];
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox;
  branding: BrandingConfig;
  /** Strictly false by design: YouTube auto-captions handle subtitles */
  burnedCaptions: false;
  encoderUsed?: 'h264_nvenc' | 'libx264';
  outputFileName: string;
  downloadUrl: string;
  durationSec: number;
  resolution: string;
  fileSizeBytes: number;
  createdAt: string;
  youtubeVideoId?: string;
  youtubePublishAt?: string;
  youtubeStatus?: 'ready' | 'uploading' | 'published' | 'scheduled';
}

export interface JobStatus {
  id: string;
  type: 'ingest-url' | 'ingest-upload' | 'download-segments' | 'render';
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  stage: string;
  detail?: string;
  error?: string;
  projectId?: string;
  momentId?: string;
  autoPruned?: boolean;
  project?: VideoProject;
  clip?: RenderedClip;
  createdAt: string;
  updatedAt: string;
}

export interface VideoSegment {
  id: string;
  order: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  label?: string;
  status:
    | 'queued'
    | 'downloading'
    | 'detecting'
    | 'rendering'
    | 'completed'
    | 'failed';
  progress: number;
  facecam: {
    status: 'pending' | 'detected' | 'not_found' | 'uncertain';
    confidence: number | null;
    boundingBox: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null;
    positionLabel?: string;
  };
  preferredLayout: LayoutId;
  effectiveLayout: LayoutId | null;
  outputFileName: string | null;
  outputPath: string | null;
  downloadUrl: string | null;
  previewUrl?: string | null;
  fileSizeBytes?: number;
  error: string | null;
}

export interface BatchProcessJob {
  id: string;
  videoUrl: string;
  videoTitle: string;
  videoDurationSec: number;
  preferredLayout: LayoutId;
  templateId: TemplateId;
  resolution: '1080x1920' | '720x1280';
  frameRate: 'original' | '60' | '30';
  branding: BrandingConfig;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'partial_failure';
  progress: number;
  stage: string;
  detail?: string;
  segments: VideoSegment[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  zipDownloadUrl?: string;
  zipSizeBytes?: number;
}

export interface LayoutOptionMeta {
  id: LayoutId;
  name: string;
  shortLabel: string;
  description: string;
  usesFacecam: boolean;
  facecamPlacement: string;
}

export const LAYOUT_OPTIONS: LayoutOptionMeta[] = [
  {
    id: 'split-top-cam',
    name: 'Facecam Top Split',
    shortLabel: 'Top Split',
    description: 'Facecam pinned in the top 35% frame, main stream fills bottom 65%.',
    usesFacecam: true,
    facecamPlacement: 'Top 35% Band',
  },
  {
    id: 'split-bottom-cam',
    name: 'Facecam Bottom Split',
    shortLabel: 'Bottom Split',
    description: 'Main stream takes top 65%, facecam anchored at bottom 35%.',
    usesFacecam: true,
    facecamPlacement: 'Bottom 35% Band',
  },
  {
    id: 'split-50-50',
    name: 'Equal 50/50 Duel',
    shortLabel: '50/50 Split',
    description: 'Balanced 50/50 vertical split ideal for podcasts and co-streams.',
    usesFacecam: true,
    facecamPlacement: 'Top 50% Equal',
  },
  {
    id: 'pip-top-left',
    name: 'PiP Top-Left',
    shortLabel: 'PiP Top-L',
    description: 'Full 9:16 cropped gameplay with facecam pinned top-left.',
    usesFacecam: true,
    facecamPlacement: 'Top-Left Overlay',
  },
  {
    id: 'pip-top-right',
    name: 'PiP Top-Right',
    shortLabel: 'PiP Top-R',
    description: 'Full 9:16 cropped gameplay with facecam pinned top-right.',
    usesFacecam: true,
    facecamPlacement: 'Top-Right Overlay',
  },
  {
    id: 'pip-bottom-left',
    name: 'PiP Bottom-Left',
    shortLabel: 'PiP Bot-L',
    description: 'Full 9:16 cropped gameplay with facecam pinned bottom-left.',
    usesFacecam: true,
    facecamPlacement: 'Bottom-Left Overlay',
  },
  {
    id: 'pip-bottom-right',
    name: 'PiP Bottom-Right',
    shortLabel: 'PiP Bot-R',
    description: 'Full 9:16 cropped gameplay with facecam pinned bottom-right.',
    usesFacecam: true,
    facecamPlacement: 'Bottom-Right Overlay',
  },
  {
    id: 'blurred-bg-cam-top',
    name: 'Blurred Card + Cam Top',
    shortLabel: 'Blur + Top Cam',
    description: 'Full 16:9 frame preserved over blurred backdrop with facecam above.',
    usesFacecam: true,
    facecamPlacement: 'Top Header Zone',
  },
  {
    id: 'blurred-bg-cam-bottom',
    name: 'Blurred Card + Cam Bottom',
    shortLabel: 'Blur + Bot Cam',
    description: 'Full 16:9 frame preserved over blurred backdrop with facecam below.',
    usesFacecam: true,
    facecamPlacement: 'Bottom Footer Zone',
  },
  {
    id: 'center-crop-focus',
    name: 'Center 9:16 Focus',
    shortLabel: 'Center Crop',
    description: 'Clean full-frame 9:16 center crop without a separate facecam box.',
    usesFacecam: false,
    facecamPlacement: 'Full Frame (No PiP)',
  },
  {
    id: 'facecam-only-zoom',
    name: 'Facecam Full Zoom',
    shortLabel: 'Cam Only',
    description: 'Zooms directly into the detected facecam region for reaction clips.',
    usesFacecam: true,
    facecamPlacement: 'Full 9:16 Cam',
  },
];

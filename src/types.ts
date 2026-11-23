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

export type SegmentDownloadStatus =
  | 'pending'
  | 'downloading'
  | 'ready'
  | 'interrupted'
  | 'error';

export type SegmentRenderStatus =
  | 'idle'
  | 'queued'
  | 'rendering'
  | 'completed'
  | 'interrupted'
  | 'failed';

export interface FacecamBox {
  /** Normalized 0..1 coordinates relative to original source video dimensions */
  x: number;
  y: number;
  width: number;
  height: number;
  label?: string;
}

export interface BrandingConfig {
  creditText: string;
  backgroundHex: string;
  watermarkText: string;
}

export interface ProjectSegment {
  id: string;
  order: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  title: string;
  hookTagline?: string;
  downloadStatus: SegmentDownloadStatus;
  downloadProgress: number;
  downloadError?: string;
  /** Relative path within workspace/sources (e.g. "<projectId>/segment_001.mp4") */
  sourceFileName?: string;
  sourceSizeBytes?: number;
  /** Cached source frame URL (/api/frames/...) for manual facecam region selection */
  frameUrl?: string;
  width?: number;
  height?: number;
  fps?: number;
  hasAudio?: boolean;
  /** Manual facecam coordinates relative to source video dimensions */
  facecamBox: FacecamBox | null;
  hasCustomFacecam: boolean;
  layoutId: LayoutId;
  hasCustomLayout: boolean;
  renderStatus: SegmentRenderStatus;
  renderProgress: number;
  renderError?: string;
  renderedClipId?: string;
}

export interface ClipProject {
  id: string;
  title: string;
  sourceType: PlatformType;
  sourceUrl: string;
  thumbnailUrl?: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  sharedFacecamBox: FacecamBox | null;
  sharedLayoutId: LayoutId;
  templateId: TemplateId;
  resolution: '1080x1920' | '720x1280';
  frameRate: 'original' | '60' | '30';
  branding: BrandingConfig;
  segments: ProjectSegment[];
  createdAt: string;
  updatedAt: string;
}

export interface InspectedVideoInfo {
  title: string;
  platform: PlatformType;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  thumbnailUrl?: string;
}

export interface StorageStatus {
  sourcesDir: string;
  rendersDir: string;
  totalSourceBytes: number;
  totalRenderBytes: number;
  activeSegmentCount: number;
  totalClipCount: number;
}

export interface RenderedClip {
  id: string;
  projectId: string;
  segmentId: string;
  title: string;
  hookTagline: string;
  description: string;
  hashtags: string[];
  tags?: string[];
  alternativeTitles?: string[];
  layoutId: LayoutId;
  templateId: TemplateId;
  facecamBox: FacecamBox | null;
  branding: BrandingConfig;
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

export interface AiMetadataSuggestion {
  title: string;
  alternativeTitles: string[];
  hookTagline: string;
  description: string;
  hashtags: string[];
  tags: string[];
  providerUsed: string;
}

export interface AiProviderStatus {
  anthropic: boolean;
  openai: boolean;
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
    name: 'Top Split',
    shortLabel: 'Top Split',
    description: 'Facecam occupies the top 35%, main footage fills the bottom 65%.',
    usesFacecam: true,
    facecamPlacement: 'Top 35% Band',
  },
  {
    id: 'split-bottom-cam',
    name: 'Bottom Split',
    shortLabel: 'Bottom Split',
    description: 'Main footage occupies the top 65%, facecam anchored at the bottom 35%.',
    usesFacecam: true,
    facecamPlacement: 'Bottom 35% Band',
  },
  {
    id: 'split-50-50',
    name: '50/50 Split',
    shortLabel: '50/50 Split',
    description: 'Equal 50/50 vertical division between facecam and main footage.',
    usesFacecam: true,
    facecamPlacement: 'Top 50% Equal',
  },
  {
    id: 'pip-top-left',
    name: 'PiP Top-L',
    shortLabel: 'PiP Top-L',
    description: 'Full 9:16 main footage with facecam overlay in the top-left.',
    usesFacecam: true,
    facecamPlacement: 'Top-Left Overlay',
  },
  {
    id: 'pip-top-right',
    name: 'PiP Top-R',
    shortLabel: 'PiP Top-R',
    description: 'Full 9:16 main footage with facecam overlay in the top-right.',
    usesFacecam: true,
    facecamPlacement: 'Top-Right Overlay',
  },
  {
    id: 'pip-bottom-left',
    name: 'PiP Bot-L',
    shortLabel: 'PiP Bot-L',
    description: 'Full 9:16 main footage with facecam overlay in the bottom-left.',
    usesFacecam: true,
    facecamPlacement: 'Bottom-Left Overlay',
  },
  {
    id: 'pip-bottom-right',
    name: 'PiP Bot-R',
    shortLabel: 'PiP Bot-R',
    description: 'Full 9:16 main footage with facecam overlay in the bottom-right.',
    usesFacecam: true,
    facecamPlacement: 'Bottom-Right Overlay',
  },
  {
    id: 'blurred-bg-cam-top',
    name: 'Blur + Top Cam',
    shortLabel: 'Blur + Top Cam',
    description: 'Blurred 9:16 background with main footage centered and facecam in the top zone.',
    usesFacecam: true,
    facecamPlacement: 'Top Header Zone',
  },
  {
    id: 'blurred-bg-cam-bottom',
    name: 'Blur + Bot Cam',
    shortLabel: 'Blur + Bot Cam',
    description: 'Blurred 9:16 background with main footage centered and facecam in the bottom zone.',
    usesFacecam: true,
    facecamPlacement: 'Bottom Footer Zone',
  },
  {
    id: 'center-crop-focus',
    name: 'Center Crop',
    shortLabel: 'Center Crop',
    description: 'Main footage fills the vertical 9:16 frame without a facecam.',
    usesFacecam: false,
    facecamPlacement: 'Full Frame (No Cam)',
  },
  {
    id: 'facecam-only-zoom',
    name: 'Cam Only',
    shortLabel: 'Cam Only',
    description: 'Selected manual facecam region fills the entire 9:16 vertical frame.',
    usesFacecam: true,
    facecamPlacement: 'Full 9:16 Cam',
  },
];

import { useEffect, useState } from 'react';
import {
  Camera,
  Film,
  Scissors,
  Wand2,
  Youtube,
} from 'lucide-react';
import type {
  AppSettings,
  RenderedClip,
  StorageStatus,
  VideoProject,
  ViralMoment,
} from './types';
import { V2AutoClipperView } from './components/V2AutoClipperView';
import { IngestAnalyzeView } from './components/IngestAnalyzeView';
import { FacecamLayoutStudio } from './components/FacecamLayoutStudio';
import { RenderQueueView } from './components/RenderQueueView';
import { YouTubePublishView } from './components/YouTubePublishView';
import type { YouTubeChannelProfile } from './lib/youtubeAuth';

type WorkspaceTab = 'v2-clipper' | 'queue' | 'facecam' | 'ingest' | 'youtube';

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: typeof Scissors }> = [
  { id: 'v2-clipper', label: '1. V2 Auto Clipper', icon: Wand2 },
  { id: 'queue', label: '2. Rendered Shorts', icon: Film },
  { id: 'facecam', label: '3. Layout Studio', icon: Camera },
  { id: 'ingest', label: '4. AI Discovery', icon: Scissors },
  { id: 'youtube', label: '5. Publish', icon: Youtube },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('v2-clipper');
  const [projects, setProjects] = useState<VideoProject[]>([]);
  const [activeProject, setActiveProject] = useState<VideoProject | null>(null);
  const [selectedMoment, setSelectedMoment] = useState<ViralMoment | null>(null);
  const [clips, setClips] = useState<RenderedClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [connectedChannel, setConnectedChannel] = useState<YouTubeChannelProfile | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [appSettings, setAppSettings] = useState<AppSettings>({ autoPruneSourceVod: true });
  const [loadingInitial, setLoadingInitial] = useState(true);

  const refreshStorageStatus = () => {
    fetch('/api/storage/status')
      .then((r) => r.json())
      .then((s) => setStorageStatus(s))
      .catch(() => {});
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      fetch('/api/projects').then((r) => r.json()),
      fetch('/api/clips').then((r) => r.json()),
      fetch('/api/storage/status').then((r) => r.json()),
      fetch('/api/settings').then((r) => r.json()),
    ])
      .then(([projRes, clipsRes, storageRes, settingsRes]) => {
        if (!mounted) return;
        const loadedProjects: VideoProject[] = projRes.projects || [];
        setProjects(loadedProjects);
        if (loadedProjects.length > 0) {
          setActiveProject(loadedProjects[0]);
          setSelectedMoment(loadedProjects[0].moments[0] || null);
        }
        const loadedClips: RenderedClip[] = clipsRes.clips || [];
        setClips(loadedClips);
        if (loadedClips.length > 0) {
          setSelectedClipId(loadedClips[0].id);
        }
        setStorageStatus(storageRes || null);
        if (settingsRes?.settings) setAppSettings(settingsRes.settings);
      })
      .finally(() => {
        if (mounted) setLoadingInitial(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  const handleProjectCreated = (project: VideoProject) => {
    setProjects((prev) => [project, ...prev]);
    setActiveProject(project);
    setSelectedMoment(project.moments[0] || null);
    refreshStorageStatus();
  };

  const handleProjectUpdated = (updated: VideoProject) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    if (activeProject?.id === updated.id) {
      setActiveProject(updated);
      if (selectedMoment) {
        const refreshed = updated.moments.find((m) => m.id === selectedMoment.id);
        setSelectedMoment(refreshed || updated.moments[0] || null);
      } else {
        setSelectedMoment(updated.moments[0] || null);
      }
    }
    refreshStorageStatus();
  };

  const handleProjectDeleted = async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    if (res.ok) {
      const remaining = projects.filter((p) => p.id !== projectId);
      setProjects(remaining);
      if (activeProject?.id === projectId) {
        const next = remaining[0] || null;
        setActiveProject(next);
        setSelectedMoment(next?.moments[0] || null);
      }
      refreshStorageStatus();
    }
  };

  const handleCleanupProjectSource = async (projectId: string) => {
    const res = await fetch(`/api/projects/${projectId}/cleanup-source`, { method: 'POST' });
    const data = await res.json();
    if (res.ok && data.project) {
      handleProjectUpdated(data.project);
      if (data.storage) setStorageStatus(data.storage);
    }
  };

  const handlePruneAllSources = async () => {
    const res = await fetch('/api/storage/prune-sources', { method: 'POST' });
    const data = await res.json();
    if (res.ok && Array.isArray(data.projects)) {
      const updatedList: VideoProject[] = data.projects;
      setProjects(updatedList);
      if (activeProject) {
        const refreshed = updatedList.find((p) => p.id === activeProject.id) || null;
        setActiveProject(refreshed);
      }
      if (data.storage) setStorageStatus(data.storage);
    }
  };

  const handleUpdateAppSettings = async (patch: Partial<AppSettings>) => {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (res.ok && data.settings) {
      setAppSettings(data.settings);
    }
  };

  const handleClipRendered = (clip: RenderedClip, updatedProject?: VideoProject) => {
    setClips((prev) => [clip, ...prev]);
    setSelectedClipId(clip.id);
    if (updatedProject) {
      handleProjectUpdated(updatedProject);
    }
    setActiveTab('queue');
    refreshStorageStatus();
  };

  const handleBatchClipsRendered = (newClips: RenderedClip[], updatedProject?: VideoProject) => {
    if (newClips.length > 0) {
      setClips((prev) => [...newClips.slice().reverse(), ...prev]);
      setSelectedClipId(newClips[0].id);
    }
    if (updatedProject) {
      handleProjectUpdated(updatedProject);
    }
    setActiveTab('queue');
    refreshStorageStatus();
  };

  const handleClipDeleted = async (clipId: string) => {
    const res = await fetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    if (res.ok) {
      const remaining = clips.filter((c) => c.id !== clipId);
      setClips(remaining);
      if (selectedClipId === clipId) {
        setSelectedClipId(remaining[0]?.id || null);
      }
      refreshStorageStatus();
    }
  };

  const handleClipUpdated = (updated: RenderedClip) => {
    setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) || NAV_ITEMS[0];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#0B0D11] text-[#F4F5F7]">
      {/* Clean Left Sidebar Navigation */}
      <aside className="w-full lg:w-[240px] shrink-0 bg-[#10131A] border-b lg:border-b-0 lg:border-r border-[#232834] flex flex-col justify-between p-4">
        <div className="space-y-6">
          <div className="px-2 pt-1">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('ingest');
              }}
              className="font-display text-xl font-bold tracking-tight text-[#F4F5F7] whitespace-nowrap shrink-0"
            >
              ClipForge
            </a>
          </div>

          <nav className="flex lg:flex-col gap-1 overflow-x-auto pb-1 lg:pb-0">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const isActive = activeTab === item.id;
              const countText =
                item.id === 'queue' && clips.length > 0
                  ? `${clips.length}`
                  : item.id === 'ingest' && projects.length > 0
                    ? `${projects.length}`
                    : null;

              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActiveTab(item.id)}
                  className={`flex items-center justify-between gap-2.5 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    isActive
                      ? 'bg-[#1B202C] text-[#F4F5F7]'
                      : 'text-[#94A3B8] hover:text-[#F4F5F7] hover:bg-[#161A24]'
                  }`}
                >
                  <span className="flex items-center gap-2.5">
                    <Icon className={`w-4 h-4 ${isActive ? 'text-rose-500' : 'text-[#64748B]'}`} />
                    <span>{item.label}</span>
                  </span>
                  {countText && (
                    <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                      {countText}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>
      </aside>

      {/* Main Workspace */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Bar Contract: Breadcrumb on left, 1 primary action on right */}
        <header className="h-16 px-6 border-b border-[#232834] bg-[#0E1016] flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-[#64748B] whitespace-nowrap">ClipForge</span>
            <span className="text-[#475569]">/</span>
            <span className="font-display font-semibold text-[#F4F5F7] whitespace-nowrap">
              {activeNavMeta.label}
            </span>
            {activeProject && activeTab !== 'queue' && (
              <>
                <span className="text-[#475569] hidden sm:inline">/</span>
                <span className="text-[#94A3B8] truncate max-w-[300px] hidden sm:inline">
                  {activeProject.title}
                </span>
              </>
            )}
          </div>

          <div className="flex items-center gap-4 shrink-0">
            {connectedChannel && (
              <span className="hidden md:inline text-xs text-[#94A3B8] whitespace-nowrap">
                {connectedChannel.title}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                if (activeTab === 'v2-clipper') {
                  setActiveTab('queue');
                } else if (activeTab === 'queue' && clips.length > 0) {
                  setActiveTab('youtube');
                } else {
                  setActiveTab('v2-clipper');
                }
              }}
              className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {activeTab === 'v2-clipper'
                ? 'View Rendered Shorts'
                : activeTab === 'queue' && clips.length > 0
                  ? 'Publish to YouTube'
                  : 'V2 Auto Clipper'}
            </button>
          </div>
        </header>

        <main className="flex-1 p-6 max-w-[1400px] w-full mx-auto">
          {loadingInitial ? (
            <div className="space-y-4">
              <div className="h-40 bg-[#13161D] border border-[#232834] rounded-xl animate-pulse" />
              <div className="h-72 bg-[#13161D] border border-[#232834] rounded-xl animate-pulse" />
            </div>
          ) : (
            <>
              {activeTab === 'v2-clipper' && (
                <V2AutoClipperView
                  onClipsRendered={(newClips) => {
                    setClips((prev) => [...newClips, ...prev]);
                    if (newClips[0]) setSelectedClipId(newClips[0].id);
                    refreshStorageStatus();
                  }}
                  onNavigateToTab={(tab) => setActiveTab(tab)}
                />
              )}

              {activeTab === 'ingest' && (
                <IngestAnalyzeView
                  projects={projects}
                  activeProject={activeProject}
                  selectedMomentId={selectedMoment?.id || null}
                  storageStatus={storageStatus}
                  appSettings={appSettings}
                  onSelectProject={(proj) => {
                    setActiveProject(proj);
                    setSelectedMoment(proj.moments[0] || null);
                  }}
                  onSelectMoment={(moment) => setSelectedMoment(moment)}
                  onOpenFacecamStudio={(moment) => {
                    setSelectedMoment(moment);
                    setActiveTab('facecam');
                  }}
                  onProjectCreated={handleProjectCreated}
                  onProjectUpdated={handleProjectUpdated}
                  onProjectDeleted={handleProjectDeleted}
                  onCleanupSource={handleCleanupProjectSource}
                  onPruneAllSources={handlePruneAllSources}
                  onUpdateAppSettings={handleUpdateAppSettings}
                />
              )}

              {activeTab === 'facecam' && (
                <FacecamLayoutStudio
                  project={activeProject}
                  moment={selectedMoment}
                  appSettings={appSettings}
                  onSelectMoment={setSelectedMoment}
                  onProjectUpdated={handleProjectUpdated}
                  onClipRendered={handleClipRendered}
                  onBatchClipsRendered={handleBatchClipsRendered}
                />
              )}

              {activeTab === 'queue' && (
                <RenderQueueView
                  clips={clips}
                  projects={projects}
                  storageStatus={storageStatus}
                  onDeleteClip={handleClipDeleted}
                  onCleanupSource={handleCleanupProjectSource}
                  onPruneAllSources={handlePruneAllSources}
                  onPublishClip={(clip) => {
                    setSelectedClipId(clip.id);
                    setActiveTab('youtube');
                  }}
                  onGoToStudio={() => setActiveTab('facecam')}
                />
              )}

              {activeTab === 'youtube' && (
                <YouTubePublishView
                  clips={clips}
                  selectedClipId={selectedClipId}
                  onSelectClipId={setSelectedClipId}
                  onClipUpdated={handleClipUpdated}
                  onChannelConnected={setConnectedChannel}
                />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}

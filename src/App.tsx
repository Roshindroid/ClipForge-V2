import { useEffect, useState } from 'react';
import { Film, Scissors, Youtube } from 'lucide-react';
import type { ClipProject, RenderedClip, StorageStatus } from './types';
import { CreateClipsView } from './components/CreateClipsView';
import { RenderQueueView } from './components/RenderQueueView';
import { YouTubePublishView } from './components/YouTubePublishView';
import type { YouTubeChannelProfile } from './lib/youtubeAuth';

type WorkspaceTab = 'create' | 'clips' | 'youtube';

const NAV_ITEMS: Array<{ id: WorkspaceTab; label: string; icon: typeof Scissors }> = [
  { id: 'create', label: '1. Create Clips', icon: Scissors },
  { id: 'clips', label: '2. My Clips', icon: Film },
  { id: 'youtube', label: '3. YouTube Upload', icon: Youtube },
];

export default function App() {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('create');
  const [projects, setProjects] = useState<ClipProject[]>([]);
  const [activeProject, setActiveProject] = useState<ClipProject | null>(null);
  const [clips, setClips] = useState<RenderedClip[]>([]);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [connectedChannel, setConnectedChannel] = useState<YouTubeChannelProfile | null>(null);
  const [storageStatus, setStorageStatus] = useState<StorageStatus | null>(null);
  const [loadingInitial, setLoadingInitial] = useState(true);

  const refreshClipsAndStorage = () => {
    Promise.all([
      fetch('/api/clips').then((r) => r.json()),
      fetch('/api/storage/status').then((r) => r.json()),
    ])
      .then(([clipsRes, storageRes]) => {
        const loadedClips: RenderedClip[] = clipsRes.clips || [];
        setClips(loadedClips);
        if (loadedClips.length > 0 && !selectedClipId) {
          setSelectedClipId(loadedClips[0].id);
        }
        setStorageStatus(storageRes || null);
      })
      .catch(() => {});
  };

  useEffect(() => {
    let mounted = true;
    Promise.all([
      fetch('/api/projects').then((r) => r.json()),
      fetch('/api/clips').then((r) => r.json()),
      fetch('/api/storage/status').then((r) => r.json()),
    ])
      .then(([projRes, clipsRes, storageRes]) => {
        if (!mounted) return;
        const loadedProjects: ClipProject[] = projRes.projects || [];
        setProjects(loadedProjects);
        if (loadedProjects.length > 0) {
          setActiveProject(loadedProjects[0]);
        }
        const loadedClips: RenderedClip[] = clipsRes.clips || [];
        setClips(loadedClips);
        if (loadedClips.length > 0) {
          setSelectedClipId(loadedClips[0].id);
        }
        setStorageStatus(storageRes || null);
      })
      .finally(() => {
        if (mounted) setLoadingInitial(false);
      });

    return () => {
      mounted = false;
    };
  }, []);

  // Poll active project only while downloads or renders are in progress
  const activeWorkInProgress = Boolean(
    activeProject?.segments.some(
      (s) =>
        s.downloadStatus === 'downloading' ||
        s.renderStatus === 'queued' ||
        s.renderStatus === 'rendering'
    )
  );

  useEffect(() => {
    if (!activeProject || !activeWorkInProgress) return;
    const activeId = activeProject.id;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(`/api/projects/${activeId}`);
        if (!res.ok) return;
        const data = await res.json();
        if (data.project) {
          const updated = data.project as ClipProject;
          setActiveProject(updated);
          setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
          refreshClipsAndStorage();
        }
      } catch {
        // ignore transient poll error
      }
    }, 1100);
    return () => clearInterval(timer);
  }, [activeProject?.id, activeWorkInProgress]);

  const handleProjectCreated = (project: ClipProject) => {
    setProjects((prev) => [project, ...prev.filter((p) => p.id !== project.id)]);
    setActiveProject(project);
    refreshClipsAndStorage();
  };

  const handleProjectUpdated = (updated: ClipProject) => {
    setProjects((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
    if (activeProject?.id === updated.id) {
      setActiveProject(updated);
    }
    refreshClipsAndStorage();
  };

  const handleProjectDeleted = async (projectId: string, deleteClips: boolean) => {
    const res = await fetch(`/api/projects/${projectId}?deleteClips=${deleteClips}`, {
      method: 'DELETE',
    });
    if (res.ok) {
      const remaining = projects.filter((p) => p.id !== projectId);
      setProjects(remaining);
      if (activeProject?.id === projectId) {
        setActiveProject(remaining[0] || null);
      }
      refreshClipsAndStorage();
    }
  };

  const handleClipDeleted = async (clipId: string) => {
    const res = await fetch(`/api/clips/${clipId}`, { method: 'DELETE' });
    if (res.ok) {
      const remaining = clips.filter((c) => c.id !== clipId);
      setClips(remaining);
      if (selectedClipId === clipId) {
        setSelectedClipId(remaining[0]?.id || null);
      }
      // Refresh active project so renderedClipId reference clears cleanly
      if (activeProject) {
        fetch(`/api/projects/${activeProject.id}`)
          .then((r) => r.json())
          .then((d) => {
            if (d.project) handleProjectUpdated(d.project);
          })
          .catch(() => {});
      }
      refreshClipsAndStorage();
    }
  };

  const handleClipUpdated = (updated: RenderedClip) => {
    setClips((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) || NAV_ITEMS[0];

  return (
    <div className="min-h-screen flex flex-col lg:flex-row bg-[#0B0D11] text-[#F4F5F7]">
      {/* Simplified 3-Section Sidebar */}
      <aside className="w-full lg:w-[232px] shrink-0 bg-[#10131A] border-b lg:border-b-0 lg:border-r border-[#232834] flex flex-col justify-between p-4">
        <div className="space-y-6">
          <div className="px-2 pt-1">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('create');
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
                item.id === 'clips' && clips.length > 0
                  ? `${clips.length}`
                  : item.id === 'create' && projects.length > 0
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
        <header className="h-16 px-6 border-b border-[#232834] bg-[#0E1016] flex items-center justify-between gap-8 shrink-0">
          <div className="flex items-center gap-2 text-sm min-w-0">
            <span className="text-[#64748B] whitespace-nowrap">ClipForge</span>
            <span className="text-[#475569]">/</span>
            <span className="font-display font-semibold text-[#F4F5F7] whitespace-nowrap">
              {activeNavMeta.label}
            </span>
            {activeProject && activeTab === 'create' && (
              <>
                <span className="text-[#475569] hidden sm:inline">/</span>
                <span className="text-[#94A3B8] truncate max-w-[320px] hidden sm:inline">
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
                if (activeTab === 'create') {
                  setActiveTab('clips');
                } else if (activeTab === 'clips' && clips.length > 0) {
                  setActiveTab('youtube');
                } else {
                  setActiveTab('create');
                }
              }}
              className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {activeTab === 'create'
                ? `My Clips (${clips.length})`
                : activeTab === 'clips' && clips.length > 0
                  ? 'YouTube Upload'
                  : 'Create Clips'}
            </button>
          </div>
        </header>

        <main className="flex-1 p-6 max-w-[1440px] w-full mx-auto">
          {loadingInitial ? (
            <div className="space-y-4">
              <div className="h-36 bg-[#13161D] border border-[#232834] rounded-xl animate-pulse" />
              <div className="h-80 bg-[#13161D] border border-[#232834] rounded-xl animate-pulse" />
            </div>
          ) : (
            <>
              {activeTab === 'create' && (
                <CreateClipsView
                  projects={projects}
                  activeProject={activeProject}
                  onSelectProject={setActiveProject}
                  onProjectCreated={handleProjectCreated}
                  onProjectUpdated={handleProjectUpdated}
                  onProjectDeleted={handleProjectDeleted}
                  onGoToMyClips={() => setActiveTab('clips')}
                />
              )}

              {activeTab === 'clips' && (
                <RenderQueueView
                  clips={clips}
                  storageStatus={storageStatus}
                  onDeleteClip={handleClipDeleted}
                  onPublishClip={(clip) => {
                    setSelectedClipId(clip.id);
                    setActiveTab('youtube');
                  }}
                  onGoToCreate={() => setActiveTab('create')}
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

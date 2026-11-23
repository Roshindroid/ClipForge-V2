import { useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  LogOut,
  RefreshCw,
  UploadCloud,
  Youtube,
} from 'lucide-react';
import type { RenderedClip } from '../types';
import {
  fetchMyYouTubeChannel,
  getCachedYouTubeToken,
  initYouTubeAuth,
  signInWithYouTube,
  signOutYouTube,
  uploadShortToYouTube,
  type YouTubeChannelProfile,
} from '../lib/youtubeAuth';

interface YouTubePublishViewProps {
  clips: RenderedClip[];
  selectedClipId: string | null;
  onSelectClipId: (id: string) => void;
  onClipUpdated: (clip: RenderedClip) => void;
  onChannelConnected?: (channel: YouTubeChannelProfile | null) => void;
}

export function YouTubePublishView({
  clips,
  selectedClipId,
  onSelectClipId,
  onClipUpdated,
  onChannelConnected,
}: YouTubePublishViewProps) {
  const activeClip = clips.find((c) => c.id === selectedClipId) || clips[0] || null;

  const [accessToken, setAccessToken] = useState<string | null>(getCachedYouTubeToken());
  const [channel, setChannel] = useState<YouTubeChannelProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const [title, setTitle] = useState(activeClip?.title || '');
  const [tagline, setTagline] = useState(activeClip?.hookTagline || '');
  const [description, setDescription] = useState(activeClip?.description || '');
  const [hashtagsText, setHashtagsText] = useState(
    activeClip?.hashtags?.join(' ') || '#shorts #streamclips #highlights'
  );
  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedVideoId, setUploadedVideoId] = useState<string | null>(null);

  useEffect(() => {
    const unsub = initYouTubeAuth(
      async (_user, token) => {
        setAccessToken(token);
        try {
          const ch = await fetchMyYouTubeChannel(token);
          setChannel(ch);
          onChannelConnected?.(ch);
        } catch {
          // ignore silent channel refresh error
        }
      },
      () => {
        setAccessToken(null);
        setChannel(null);
        onChannelConnected?.(null);
      }
    );
    return () => unsub();
  }, [onChannelConnected]);

  useEffect(() => {
    if (activeClip) {
      setTitle(activeClip.title);
      setTagline(activeClip.hookTagline);
      setDescription(activeClip.description);
      setHashtagsText(activeClip.hashtags.join(' '));
      setUploadedVideoId(activeClip.youtubeVideoId || null);
      setUploadError(null);
    }
  }, [activeClip?.id]);

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const { accessToken: token } = await signInWithYouTube();
      setAccessToken(token);
      const ch = await fetchMyYouTubeChannel(token);
      setChannel(ch);
      onChannelConnected?.(ch);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await signOutYouTube();
    setAccessToken(null);
    setChannel(null);
    onChannelConnected?.(null);
  };

  const handleRegenerateMetadata = () => {
    if (!activeClip) return;
    const base = activeClip.title.replace(/#shorts/gi, '').trim();
    const hooks = [
      `Wait until the final 3 seconds — ${base}`,
      `This ${activeClip.durationSec}s clip broke the stream: ${base}`,
      `Unfiltered reaction: ${base}`,
    ];
    const nextTagline = hooks[Math.floor(Math.random() * hooks.length)];
    setTagline(nextTagline);
    setTitle(`${base.slice(0, 72)} #Shorts`);
    setDescription(
      `${nextTagline}\n\nRendered at ${activeClip.resolution} with clean audio & YouTube auto-captions enabled.\n\n${hashtagsText}`
    );
  };

  const executeUpload = async () => {
    if (!activeClip || !accessToken) return;
    setConfirmOpen(false);
    setUploadError(null);
    setUploadProgress(2);

    try {
      const publishAtIso =
        scheduleEnabled && scheduleDateTime
          ? new Date(scheduleDateTime).toISOString()
          : undefined;

      const fullDesc = `${tagline ? `${tagline}\n\n` : ''}${description}\n\n${hashtagsText}`.trim();
      const tags = hashtagsText
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean);

      const { videoId } = await uploadShortToYouTube({
        accessToken,
        clipDownloadUrl: activeClip.downloadUrl,
        title: title.trim() || activeClip.title,
        description: fullDesc,
        tags,
        privacyStatus,
        publishAtIso,
        onProgress: (pct) => setUploadProgress(pct),
      });

      setUploadedVideoId(videoId);
      const patchRes = await fetch(`/api/clips/${activeClip.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          hookTagline: tagline,
          description,
          hashtags: tags,
          youtubeVideoId: videoId,
          youtubePublishAt: publishAtIso,
          youtubeStatus: publishAtIso ? 'scheduled' : 'published',
        }),
      });
      const patchData = await patchRes.json();
      if (patchRes.ok && patchData.clip) {
        onClipUpdated(patchData.clip);
      }
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'YouTube upload failed');
    } finally {
      setUploadProgress(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* YouTube Channel Connection Card */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          {channel?.thumbnailUrl ? (
            <img
              src={channel.thumbnailUrl}
              alt={channel.title}
              referrerPolicy="no-referrer"
              className="w-12 h-12 rounded-full border border-[#32394A] object-cover"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-[#1C212C] border border-[#32394A] flex items-center justify-center">
              <Youtube className="w-5 h-5 text-rose-500" />
            </div>
          )}

          <div>
            {channel ? (
              <>
                <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                  {channel.title}
                </h2>
                <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5">
                  {channel.customUrl || channel.id}
                  {channel.subscriberCount ? ` · ${Number(channel.subscriberCount).toLocaleString()} subscribers` : ''}
                  {channel.videoCount ? ` · ${Number(channel.videoCount).toLocaleString()} videos` : ''}
                </p>
              </>
            ) : (
              <>
                <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Connect Your YouTube Channel
                </h2>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Sign in with Google to upload or schedule 9:16 Shorts directly (tokens stay in browser memory only).
                </p>
              </>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3">
          {accessToken ? (
            <button
              type="button"
              onClick={handleDisconnect}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              Disconnect Channel
            </button>
          ) : (
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={authLoading}
              className="gsi-material-button"
            >
              <div className="gsi-material-button-content-wrapper">
                <div className="gsi-material-button-icon">
                  <svg
                    version="1.1"
                    xmlns="http://www.w3.org/2000/svg"
                    viewBox="0 0 48 48"
                    style={{ display: 'block' }}
                  >
                    <path
                      fill="#EA4335"
                      d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                    />
                    <path
                      fill="#4285F4"
                      d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                    />
                    <path
                      fill="#34A853"
                      d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                    />
                    <path fill="none" d="M0 0h48v48H0z" />
                  </svg>
                </div>
                <span className="gsi-material-button-contents">
                  {authLoading ? 'Connecting...' : 'Sign in with Google'}
                </span>
              </div>
            </button>
          )}
        </div>
      </section>

      {authError && (
        <div className="px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
          {authError}
        </div>
      )}

      {/* Clip Selection + Metadata Composer */}
      {activeClip ? (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
          {/* Left: Clip Picker & Video Preview */}
          <section className="lg:col-span-4 bg-[#13161D] border border-[#232834] rounded-xl p-5 space-y-4">
            <label className="block space-y-1.5 text-xs">
              <span className="font-medium text-[#CBD5E1]">Select Rendered Short</span>
              <select
                value={activeClip.id}
                onChange={(e) => onSelectClipId(e.target.value)}
                className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] rounded-lg text-[#F4F5F7] outline-none"
              >
                {clips.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title} ({c.durationSec}s)
                  </option>
                ))}
              </select>
            </label>

            <div className="aspect-[9/16] max-h-[420px] mx-auto w-full max-w-[240px] bg-[#080A0D] rounded-lg overflow-hidden border border-[#232834]">
              <video
                key={activeClip.id}
                src={activeClip.downloadUrl}
                controls
                playsInline
                className="w-full h-full object-contain"
              />
            </div>

            <p className="text-[11px] text-[#94A3B8] text-center font-mono">
              {activeClip.resolution} · {activeClip.durationSec}s · YouTube Auto-Captions
            </p>
          </section>

          {/* Right: Generated Taglines, Description & Upload Schedule */}
          <section className="lg:col-span-8 bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Shorts Metadata & Schedule
                </h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Review your generated title, hook tagline, description, and hashtags before publishing.
                </p>
              </div>
              <button
                type="button"
                onClick={handleRegenerateMetadata}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Refresh Hook & Description
              </button>
            </div>

            <div className="space-y-4 text-xs">
              <label className="block space-y-1.5">
                <span className="font-medium text-[#CBD5E1]">YouTube Shorts Title (max 100 chars)</span>
                <input
                  type="text"
                  maxLength={100}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="font-medium text-[#CBD5E1]">Generated Hook Tagline</span>
                <input
                  type="text"
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="font-medium text-[#CBD5E1]">Description</span>
                <textarea
                  rows={4}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              <label className="block space-y-1.5">
                <span className="font-medium text-[#CBD5E1]">Hashtags / Tags</span>
                <input
                  type="text"
                  value={hashtagsText}
                  onChange={(e) => setHashtagsText(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-xs font-mono text-[#F4F5F7] outline-none"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2 border-t border-[#232834]">
                <label className="block space-y-1.5">
                  <span className="font-medium text-[#CBD5E1]">Visibility</span>
                  <select
                    value={privacyStatus}
                    disabled={scheduleEnabled}
                    onChange={(e) =>
                      setPrivacyStatus(e.target.value as 'public' | 'unlisted' | 'private')
                    }
                    className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] rounded-lg text-xs text-[#F4F5F7] outline-none disabled:opacity-50"
                  >
                    <option value="private">Private (Safe Draft)</option>
                    <option value="unlisted">Unlisted</option>
                    <option value="public">Public Immediately</option>
                  </select>
                </label>

                <div className="space-y-1.5">
                  <label className="inline-flex items-center gap-2 font-medium text-[#CBD5E1] cursor-pointer">
                    <input
                      type="checkbox"
                      checked={scheduleEnabled}
                      onChange={(e) => setScheduleEnabled(e.target.checked)}
                      className="accent-rose-500"
                    />
                    <CalendarClock className="w-3.5 h-3.5 text-rose-400" />
                    <span>Schedule Publish Time</span>
                  </label>
                  <input
                    type="datetime-local"
                    disabled={!scheduleEnabled}
                    value={scheduleDateTime}
                    onChange={(e) => setScheduleDateTime(e.target.value)}
                    className="w-full px-3 py-1.5 bg-[#0E1016] border border-[#232834] rounded-lg text-xs font-mono text-[#F4F5F7] outline-none disabled:opacity-40"
                  />
                </div>
              </div>
            </div>

            {uploadProgress !== null && (
              <div className="space-y-1.5">
                <div className="flex justify-between text-xs font-mono tabular-nums text-[#CBD5E1]">
                  <span>Uploading MP4 to YouTube...</span>
                  <span>{uploadProgress}%</span>
                </div>
                <div className="h-2 bg-[#0E1016] rounded-full overflow-hidden">
                  <div
                    className="h-full bg-rose-500 transition-all"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
              </div>
            )}

            {uploadError && (
              <div className="px-4 py-3 text-xs text-rose-200 bg-rose-950/50 border border-rose-800/70 rounded-lg">
                {uploadError}
              </div>
            )}

            {uploadedVideoId && (
              <div className="px-4 py-3 bg-emerald-950/40 border border-emerald-700/60 rounded-lg flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-xs text-emerald-300">
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                  <span>
                    Uploaded to YouTube (ID: <span className="font-mono">{uploadedVideoId}</span>)
                  </span>
                </div>
                <a
                  href={`https://youtube.com/shorts/${uploadedVideoId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-xs font-medium text-emerald-200 hover:underline"
                >
                  Open Short
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
            )}

            <button
              type="button"
              disabled={!accessToken || uploadProgress !== null}
              onClick={() => setConfirmOpen(true)}
              className="w-full py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
            >
              <UploadCloud className="w-4 h-4" />
              {accessToken
                ? scheduleEnabled
                  ? 'Schedule Short on YouTube'
                  : 'Upload Short to YouTube'
                : 'Sign in with Google Above to Enable Upload'}
            </button>
          </section>
        </div>
      ) : (
        <div className="bg-[#13161D] border border-[#232834] rounded-xl p-10 text-center space-y-2">
          <UploadCloud className="w-7 h-7 text-[#64748B] mx-auto" />
          <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
            No Rendered Clip Selected
          </h3>
          <p className="text-sm text-[#94A3B8]">
            Render a 9:16 vertical Short first, then return here to upload it directly to your YouTube channel.
          </p>
        </div>
      )}

      {/* Explicit Confirmation Modal before mutating user YouTube channel */}
      {confirmOpen && activeClip && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="bg-[#13161D] border border-[#2E3545] rounded-xl max-w-md w-full p-6 space-y-4">
            <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
              Confirm YouTube Upload
            </h3>
            <p className="text-sm text-[#94A3B8]">
              Upload <span className="text-[#F4F5F7] font-medium">“{title || activeClip.title}”</span> ({activeClip.durationSec}s) to channel{' '}
              <span className="text-[#F4F5F7] font-medium">{channel?.title || 'Connected Channel'}</span> as{' '}
              <span className="text-[#F4F5F7] font-medium">
                {scheduleEnabled && scheduleDateTime
                  ? `Scheduled (${new Date(scheduleDateTime).toLocaleString()})`
                  : privacyStatus}
              </span>
              ?
            </p>
            <div className="flex items-center justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setConfirmOpen(false)}
                className="px-4 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={executeUpload}
                className="px-4 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer"
              >
                Confirm & Upload
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

import { useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Info,
  Loader2,
  LogOut,
  RefreshCw,
  Save,
  Sparkles,
  UploadCloud,
  Youtube,
} from 'lucide-react';
import type { AiMetadataSuggestion, AiProviderStatus, RenderedClip } from '../types';
import {
  OAUTH_PROJECT_ID,
  fetchMyYouTubeChannel,
  getCachedYouTubeToken,
  getSignedInEmail,
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

function parseHashtagsInput(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter(Boolean)
        .map((t) => (t.startsWith('#') ? t : `#${t}`))
    )
  );
}

function parseSearchTagsInput(text: string): string[] {
  return Array.from(
    new Set(
      text
        .split(',')
        .map((t) => t.trim().replace(/^#/, ''))
        .filter(Boolean)
    )
  );
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
  const [accountEmail, setAccountEmail] = useState<string | null>(getSignedInEmail());
  const [channel, setChannel] = useState<YouTubeChannelProfile | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [showSecondaryHelp, setShowSecondaryHelp] = useState(false);

  // Editable metadata fields (pre-populated from already generated clip metadata)
  const [title, setTitle] = useState(activeClip?.title || '');
  const [alternativeTitles, setAlternativeTitles] = useState<string[]>(
    activeClip?.alternativeTitles || []
  );
  const [tagline, setTagline] = useState(activeClip?.hookTagline || '');
  const [description, setDescription] = useState(activeClip?.description || '');
  const [hashtagsText, setHashtagsText] = useState(
    activeClip?.hashtags?.join(' ') || '#shorts #highlights'
  );
  const [tagsText, setTagsText] = useState(
    activeClip?.tags?.join(', ') || 'shorts, highlights, stream clips'
  );
  const [modifyInstruction, setModifyInstruction] = useState('');

  // AI Metadata Modifier (Both OpenAI + Anthropic, or individual)
  const [aiProviders, setAiProviders] = useState<AiProviderStatus>({
    anthropic: false,
    openai: false,
  });
  const [aiLoading, setAiLoading] = useState<string | null>(null);
  const [aiNotice, setAiNotice] = useState<string | null>(null);
  const [aiWarnings, setAiWarnings] = useState<string[]>([]);
  const [aiError, setAiError] = useState<string | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [privacyStatus, setPrivacyStatus] = useState<'public' | 'unlisted' | 'private'>('private');
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleDateTime, setScheduleDateTime] = useState('');

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadedVideoId, setUploadedVideoId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/ai/providers')
      .then((r) => r.json())
      .then((d) => {
        if (d?.providers) setAiProviders(d.providers);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = initYouTubeAuth(
      async (user, token) => {
        setAccessToken(token);
        setAccountEmail(user.email || getSignedInEmail());
        setAuthError(null);
        try {
          const ch = await fetchMyYouTubeChannel(token, user.email);
          setChannel(ch);
          onChannelConnected?.(ch);
        } catch (err) {
          setChannel(null);
          onChannelConnected?.(null);
          setAuthError(err instanceof Error ? err.message : 'Could not load YouTube channel.');
        }
      },
      () => {
        setAccessToken(null);
        setAccountEmail(null);
        setChannel(null);
        onChannelConnected?.(null);
      }
    );
    return () => unsub();
  }, [onChannelConnected]);

  // Restore channel card if cached token already exists in memory when revisiting tab
  useEffect(() => {
    if (accessToken && !channel) {
      fetchMyYouTubeChannel(accessToken, accountEmail)
        .then((ch) => {
          setChannel(ch);
          onChannelConnected?.(ch);
        })
        .catch((err) => {
          setAccessToken(getCachedYouTubeToken());
          setAuthError(err instanceof Error ? err.message : 'Could not load YouTube channel.');
        });
    }
  }, [accessToken, accountEmail, channel, onChannelConnected]);

  useEffect(() => {
    if (activeClip) {
      setTitle(activeClip.title);
      setAlternativeTitles(activeClip.alternativeTitles || []);
      setTagline(activeClip.hookTagline);
      setDescription(activeClip.description);
      setHashtagsText(activeClip.hashtags.join(' '));
      setTagsText(activeClip.tags?.join(', ') || 'shorts, highlights, stream clips');
      setUploadedVideoId(activeClip.youtubeVideoId || null);
      setUploadError(null);
      setAiError(null);
      setAiNotice(null);
      setAiWarnings([]);
      setSavedNotice(null);
    }
  }, [activeClip?.id]);

  const persistClipMetadata = async (fields: {
    title: string;
    alternativeTitles: string[];
    hookTagline: string;
    description: string;
    hashtags: string[];
    tags: string[];
    youtubeVideoId?: string;
    youtubePublishAt?: string;
    youtubeStatus?: 'ready' | 'uploading' | 'published' | 'scheduled';
  }) => {
    if (!activeClip) return null;
    const patchRes = await fetch(`/api/clips/${activeClip.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(fields),
    });
    const patchData = await patchRes.json();
    if (patchRes.ok && patchData.clip) {
      onClipUpdated(patchData.clip);
      return patchData.clip as RenderedClip;
    }
    return null;
  };

  const handleSaveDraft = async () => {
    if (!activeClip) return;
    setSavingDraft(true);
    setSavedNotice(null);
    try {
      const saved = await persistClipMetadata({
        title: title.trim() || activeClip.title,
        alternativeTitles,
        hookTagline: tagline,
        description,
        hashtags: parseHashtagsInput(hashtagsText),
        tags: parseSearchTagsInput(tagsText),
      });
      if (saved) {
        setSavedNotice('Metadata draft saved locally.');
      }
    } finally {
      setSavingDraft(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const { user, accessToken: token } = await signInWithYouTube();
      setAccessToken(token);
      setAccountEmail(user.email || getSignedInEmail());
      const ch = await fetchMyYouTubeChannel(token, user.email);
      setChannel(ch);
      onChannelConnected?.(ch);
    } catch (err) {
      setChannel(null);
      setAccessToken(getCachedYouTubeToken());
      setAccountEmail(getSignedInEmail());
      onChannelConnected?.(null);
      setAuthError(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setAuthLoading(false);
    }
  };

  const handleDisconnect = async () => {
    await signOutYouTube();
    setAccessToken(null);
    setAccountEmail(null);
    setChannel(null);
    setAuthError(null);
    onChannelConnected?.(null);
  };

  const handleModifyWithAi = async (provider: 'both' | 'anthropic' | 'openai') => {
    if (!activeClip) return;
    setAiLoading(provider);
    setAiError(null);
    setAiNotice(null);
    setAiWarnings([]);
    setSavedNotice(null);

    const currentHashtags = parseHashtagsInput(hashtagsText);
    const currentTags = parseSearchTagsInput(tagsText);

    try {
      const res = await fetch('/api/youtube/generate-metadata', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider,
          clipId: activeClip.id,
          clipTitle: title.trim() || activeClip.title,
          durationSec: activeClip.durationSec,
          existingTitle: title.trim() || activeClip.title,
          existingHook: tagline,
          existingDescription: description,
          existingHashtags: currentHashtags,
          existingTags: currentTags,
          existingAlternativeTitles: alternativeTitles,
          modifyInstruction: modifyInstruction.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.suggestion) {
        throw new Error(
          data.error || 'AI metadata request failed. You can edit all fields manually.'
        );
      }

      const sug = data.suggestion as AiMetadataSuggestion;
      const nextTitle = sug.title || title;
      const nextAlts = sug.alternativeTitles || [];
      const nextHook = sug.hookTagline || tagline;
      const nextDesc = sug.description || description;
      const nextHashtags = sug.hashtags || currentHashtags;
      const nextTags = sug.tags || currentTags;

      setTitle(nextTitle);
      setAlternativeTitles(nextAlts);
      setTagline(nextHook);
      setDescription(nextDesc);
      setHashtagsText(nextHashtags.join(' '));
      setTagsText(nextTags.join(', '));
      setAiWarnings(sug.warnings || []);
      setAiNotice(
        `Modified existing metadata using ${sug.providerUsed}. Saved to draft — review before uploading.`
      );

      await persistClipMetadata({
        title: nextTitle,
        alternativeTitles: nextAlts,
        hookTagline: nextHook,
        description: nextDesc,
        hashtags: nextHashtags,
        tags: nextTags,
      });
    } catch (err) {
      setAiError(
        err instanceof Error
          ? err.message
          : 'AI metadata unavailable. Continue editing metadata manually.'
      );
    } finally {
      setAiLoading(null);
    }
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

      const parsedHashtags = parseHashtagsInput(hashtagsText);
      const parsedSearchTags = parseSearchTagsInput(tagsText);

      const fullDesc = `${tagline ? `${tagline}\n\n` : ''}${description}\n\n${parsedHashtags.join(' ')}`.trim();

      const combinedYouTubeTags = Array.from(
        new Set([
          ...parsedSearchTags,
          ...parsedHashtags.map((h) => h.replace(/^#/, '')),
        ])
      ).filter(Boolean);

      const { videoId } = await uploadShortToYouTube({
        accessToken,
        clipDownloadUrl: activeClip.downloadUrl,
        title: title.trim() || activeClip.title,
        description: fullDesc,
        tags: combinedYouTubeTags,
        privacyStatus,
        publishAtIso,
        onProgress: (pct) => setUploadProgress(pct),
      });

      setUploadedVideoId(videoId);
      await persistClipMetadata({
        title,
        alternativeTitles,
        hookTagline: tagline,
        description,
        hashtags: parsedHashtags,
        tags: parsedSearchTags,
        youtubeVideoId: videoId,
        youtubePublishAt: publishAtIso,
        youtubeStatus: publishAtIso ? 'scheduled' : 'published',
      });
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'YouTube upload failed');
      if (err instanceof Error && err.message.toLowerCase().includes('session expired')) {
        setAccessToken(null);
        setChannel(null);
        onChannelConnected?.(null);
      }
    } finally {
      setUploadProgress(null);
    }
  };

  const anyAiConfigured = aiProviders.anthropic || aiProviders.openai;
  const bothAiConfigured = aiProviders.anthropic && aiProviders.openai;

  return (
    <div className="space-y-6">
      {/* YouTube Channel Connection Card */}
      <section className="bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
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
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                      {channel.title}
                    </h2>
                    <span className="text-[11px] font-medium text-emerald-300 bg-emerald-950/60 border border-emerald-700/60 rounded-md px-2 py-0.5">
                      Connected
                    </span>
                  </div>
                  <p className="text-xs text-[#94A3B8] font-mono tabular-nums mt-0.5">
                    {channel.customUrl || channel.id}
                    {channel.subscriberCount
                      ? ` · ${Number(channel.subscriberCount).toLocaleString()} subscribers`
                      : ''}
                    {channel.videoCount ? ` · ${Number(channel.videoCount).toLocaleString()} videos` : ''}
                    {channel.accountEmail || accountEmail
                      ? ` · ${channel.accountEmail || accountEmail}`
                      : ''}
                  </p>
                </>
              ) : (
                <>
                  <h2 className="font-display text-base font-semibold text-[#F4F5F7]">
                    {accessToken && accountEmail
                      ? `Signed in as ${accountEmail} (No YouTube Channel)`
                      : 'Connect Your YouTube Channel'}
                  </h2>
                  <p className="text-xs text-[#94A3B8] mt-0.5">
                    {accessToken && accountEmail
                      ? 'Switch to your secondary Google account or Brand Account that owns your YouTube channel.'
                      : 'Sign in with Google and select the primary or secondary email ID that owns your YouTube channel.'}
                  </p>
                </>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => setShowSecondaryHelp((prev) => !prev)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#0E1016] hover:bg-[#1C212C] border border-[#232834] text-[#CBD5E1] rounded-lg cursor-pointer"
            >
              <Info className="w-3.5 h-3.5 text-rose-400" />
              Secondary Email Help
            </button>

            {accessToken ? (
              <>
                <button
                  type="button"
                  onClick={handleGoogleSignIn}
                  disabled={authLoading}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg cursor-pointer disabled:opacity-50"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${authLoading ? 'animate-spin' : ''}`} />
                  Switch Account / Channel
                </button>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="inline-flex items-center gap-2 px-3.5 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] text-[#F4F5F7] rounded-lg cursor-pointer"
                >
                  <LogOut className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              </>
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
        </div>

        {(showSecondaryHelp || authError) && (
          <div className="bg-[#0E1016] border border-[#232834] rounded-lg p-3.5 text-xs text-[#CBD5E1] space-y-1.5">
            <p className="font-medium text-[#F4F5F7]">
              Connecting a YouTube Channel on a Secondary Email ID
            </p>
            <ol className="list-decimal list-inside space-y-1 text-[#94A3B8]">
              <li>
                If Google blocks your secondary email with <span className="text-[#F4F5F7] font-mono">403: access_denied</span>, open{' '}
                <span className="text-[#F4F5F7]">Google Cloud Console → Google Auth Platform → Audience → Test users</span>{' '}
                for project <span className="font-mono text-[#F4F5F7]">{OAUTH_PROJECT_ID}</span> and add your secondary email ID.
              </li>
              <li>
                Click <span className="text-[#F4F5F7]">Sign in with Google</span> (or <span className="text-[#F4F5F7]">Switch Account / Channel</span>) — the prompt lets you choose your secondary Google account and pick the specific YouTube / Brand Account channel.
              </li>
            </ol>
          </div>
        )}
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
              <span className="font-medium text-[#CBD5E1]">Select Completed Short</span>
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
              {activeClip.resolution} · {activeClip.durationSec}s
            </p>
          </section>

          {/* Right: Metadata Composer + Dual OpenAI & Anthropic Modifier + Upload Schedule */}
          <section className="lg:col-span-8 bg-[#13161D] border border-[#232834] rounded-xl p-6 space-y-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="font-display text-base font-semibold text-[#F4F5F7]">
                  Shorts Metadata & Schedule
                </h3>
                <p className="text-xs text-[#94A3B8] mt-0.5">
                  Refine your already-generated title, small description, hashtags, and searchable tags with OpenAI & Anthropic, or edit manually.
                </p>
              </div>

              <button
                type="button"
                disabled={savingDraft}
                onClick={handleSaveDraft}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer disabled:opacity-50"
              >
                {savingDraft ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5 text-[#94A3B8]" />
                )}
                Save Draft
              </button>
            </div>

            {/* Dual OpenAI + Anthropic Refinement Bar */}
            <div className="bg-[#0E1016] border border-[#232834] rounded-xl p-3.5 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-[#CBD5E1] flex items-center gap-1.5">
                  <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                  Modify Existing Metadata with AI
                </span>
                <div className="flex items-center gap-2 text-[11px] font-mono text-[#94A3B8]">
                  <span className={aiProviders.openai ? 'text-emerald-400' : 'text-[#64748B]'}>
                    OpenAI {aiProviders.openai ? 'Ready' : 'Off'}
                  </span>
                  <span>·</span>
                  <span className={aiProviders.anthropic ? 'text-rose-400' : 'text-[#64748B]'}>
                    Anthropic {aiProviders.anthropic ? 'Ready' : 'Off'}
                  </span>
                </div>
              </div>

              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={modifyInstruction}
                  onChange={(e) => setModifyInstruction(e.target.value)}
                  placeholder="Optional instruction (e.g. shorter punchy title, focus on clutch, add gaming tags)..."
                  className="flex-1 px-3 py-2 bg-[#13161D] border border-[#232834] focus:border-rose-500 rounded-lg text-xs text-[#F4F5F7] placeholder:text-[#64748B] outline-none"
                />

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {bothAiConfigured && (
                    <button
                      type="button"
                      disabled={aiLoading !== null}
                      onClick={() => handleModifyWithAi('both')}
                      className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold bg-rose-600 hover:bg-rose-500 text-white rounded-lg cursor-pointer disabled:opacity-50"
                    >
                      {aiLoading === 'both' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5" />
                      )}
                      Modify with Both (OpenAI + Anthropic)
                    </button>
                  )}

                  {aiProviders.openai && (
                    <button
                      type="button"
                      disabled={aiLoading !== null}
                      onClick={() => handleModifyWithAi('openai')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer disabled:opacity-50"
                    >
                      {aiLoading === 'openai' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                      )}
                      OpenAI
                    </button>
                  )}

                  {aiProviders.anthropic && (
                    <button
                      type="button"
                      disabled={aiLoading !== null}
                      onClick={() => handleModifyWithAi('anthropic')}
                      className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium bg-[#1C212C] hover:bg-[#252B39] border border-[#32394A] rounded-lg text-[#F4F5F7] cursor-pointer disabled:opacity-50"
                    >
                      {aiLoading === 'anthropic' ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-rose-400" />
                      )}
                      Anthropic
                    </button>
                  )}
                </div>
              </div>

              {!anyAiConfigured && (
                <p className="text-[11px] text-[#64748B]">
                  Manual mode (configure OPENAI_API_KEY and/or ANTHROPIC_API_KEY in .env to enable AI modification).
                </p>
              )}
            </div>

            {aiNotice && (
              <div className="px-3 py-2 text-xs text-emerald-300 bg-emerald-950/35 border border-emerald-700/50 rounded-lg">
                {aiNotice}
              </div>
            )}

            {aiWarnings.length > 0 && (
              <div className="px-3 py-2 text-xs text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-lg">
                {aiWarnings.join(' · ')}
              </div>
            )}

            {aiError && (
              <div className="px-3 py-2 text-xs text-amber-200 bg-amber-950/40 border border-amber-700/60 rounded-lg">
                {aiError}
              </div>
            )}

            {savedNotice && !aiNotice && (
              <div className="px-3 py-2 text-xs text-emerald-300 bg-emerald-950/35 border border-emerald-700/50 rounded-lg">
                {savedNotice}
              </div>
            )}

            <div className="space-y-4 text-xs">
              <label className="block space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-[#CBD5E1]">YouTube Shorts Title</span>
                  <span className="text-[11px] font-mono tabular-nums text-[#64748B]">
                    {title.length}/100
                  </span>
                </div>
                <input
                  type="text"
                  maxLength={100}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              {alternativeTitles.length > 0 && (
                <div className="space-y-1.5">
                  <span className="font-medium text-[#94A3B8]">
                    Alternative Title Suggestions (click to swap)
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {alternativeTitles.map((alt) => (
                      <button
                        key={alt}
                        type="button"
                        onClick={() => setTitle(alt)}
                        className="px-2.5 py-1.5 text-left text-xs bg-[#0E1016] hover:bg-[#1B202C] border border-[#232834] hover:border-rose-500/60 rounded-md text-[#CBD5E1] cursor-pointer"
                      >
                        {alt}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <label className="block space-y-1.5">
                <span className="font-medium text-[#CBD5E1]">Hook Tagline</span>
                <input
                  type="text"
                  value={tagline}
                  onChange={(e) => setTagline(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              <label className="block space-y-1.5">
                <div className="flex items-center justify-between">
                  <span className="font-medium text-[#CBD5E1]">Small Description</span>
                  <span className="text-[11px] font-mono tabular-nums text-[#64748B]">
                    {description.length}/240 recommended
                  </span>
                </div>
                <textarea
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-sm text-[#F4F5F7] outline-none"
                />
              </label>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <label className="block space-y-1.5">
                  <span className="font-medium text-[#CBD5E1]">Hashtags</span>
                  <input
                    type="text"
                    value={hashtagsText}
                    onChange={(e) => setHashtagsText(e.target.value)}
                    placeholder="#shorts #gaming #highlights"
                    className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-xs font-mono text-[#F4F5F7] outline-none"
                  />
                </label>

                <label className="block space-y-1.5">
                  <span className="font-medium text-[#CBD5E1]">Searchable Tags (comma-separated)</span>
                  <input
                    type="text"
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="shorts, highlights, stream clips"
                    className="w-full px-3 py-2 bg-[#0E1016] border border-[#232834] focus:border-rose-500 rounded-lg text-xs font-mono text-[#F4F5F7] outline-none"
                  />
                </label>
              </div>

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
              disabled={!accessToken || !channel || uploadProgress !== null}
              onClick={() => setConfirmOpen(true)}
              className="w-full py-3 px-4 bg-rose-600 hover:bg-rose-500 text-white text-sm font-semibold rounded-lg transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-45"
            >
              <UploadCloud className="w-4 h-4" />
              {accessToken && channel
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
            No Completed Clip Selected
          </h3>
          <p className="text-sm text-[#94A3B8]">
            Render a 9:16 vertical Short first in Create Clips, then return here to upload it directly to your YouTube channel.
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
              Upload <span className="text-[#F4F5F7] font-medium">“{title || activeClip.title}”</span> (
              {activeClip.durationSec}s) to channel{' '}
              <span className="text-[#F4F5F7] font-medium">
                {channel?.title || 'Connected Channel'}
              </span>{' '}
              as{' '}
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

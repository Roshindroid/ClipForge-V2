import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  signInWithPopup,
  GoogleAuthProvider,
  onAuthStateChanged,
  type User,
} from 'firebase/auth';
import firebaseConfig from '../../firebase-applet-config.json';

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
const auth = getAuth(app);

export const OAUTH_PROJECT_ID = firebaseConfig.projectId;

function createYouTubeProvider() {
  const p = new GoogleAuthProvider();
  p.addScope('https://www.googleapis.com/auth/youtube.upload');
  p.addScope('https://www.googleapis.com/auth/youtube.readonly');
  // Force both Google account picker (for secondary email IDs) and consent/Brand Account channel picker
  p.setCustomParameters({
    prompt: 'select_account consent',
  });
  return p;
}

let isSigningIn = false;
// Strictly in-memory token cache (never persisted to localStorage or sessionStorage)
let cachedAccessToken: string | null = null;

export interface YouTubeChannelProfile {
  id: string;
  title: string;
  customUrl?: string;
  thumbnailUrl?: string;
  subscriberCount?: string;
  videoCount?: string;
  accountEmail?: string;
}

export function initYouTubeAuth(
  onAuthSuccess?: (user: User, token: string) => void,
  onAuthCleared?: () => void
) {
  return onAuthStateChanged(auth, (user) => {
    if (user && cachedAccessToken) {
      onAuthSuccess?.(user, cachedAccessToken);
    } else if (!isSigningIn) {
      if (!user) cachedAccessToken = null;
      onAuthCleared?.();
    }
  });
}

function formatSignInError(err: unknown): Error {
  const code = (err as { code?: string })?.code || '';
  const message = err instanceof Error ? err.message : 'Google sign-in failed';
  const lower = message.toLowerCase();

  if (code === 'auth/popup-blocked') {
    return new Error(
      'Sign-in popup was blocked by your browser. Allow popups for this site and click Sign in with Google again.'
    );
  }
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return new Error(
      `Google sign-in was cancelled or blocked. If Google showed "Access blocked (403)" for your secondary email, add that secondary email under Google Cloud Console → Google Auth Platform → Audience → Test users for project "${OAUTH_PROJECT_ID}".`
    );
  }
  if (lower.includes('access_denied') || lower.includes('403')) {
    return new Error(
      `Google blocked access for that secondary email because the OAuth app is in Testing mode. Add your secondary email ID under Google Cloud Console → Google Auth Platform → Audience → Test users (Project: ${OAUTH_PROJECT_ID}), then try again.`
    );
  }
  if (code === 'auth/unauthorized-domain') {
    return new Error(
      `This domain (${window.location.hostname}) is not authorized in Firebase Authentication. Refresh or authorize this host in Firebase Console.`
    );
  }
  return new Error(message);
}

export async function signInWithYouTube(): Promise<{
  user: User;
  accessToken: string;
}> {
  try {
    isSigningIn = true;
    const provider = createYouTubeProvider();
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error(
        'Google sign-in completed, but no YouTube access token was returned. Re-try and grant YouTube permissions.'
      );
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } catch (err) {
    throw formatSignInError(err);
  } finally {
    isSigningIn = false;
  }
}

export function getCachedYouTubeToken(): string | null {
  return cachedAccessToken;
}

export function getSignedInEmail(): string | null {
  return auth.currentUser?.email || null;
}

export async function signOutYouTube(): Promise<void> {
  await auth.signOut();
  cachedAccessToken = null;
}

export async function fetchMyYouTubeChannel(
  accessToken: string,
  accountEmail?: string | null
): Promise<YouTubeChannelProfile> {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
  if (res.status === 401) {
    cachedAccessToken = null;
    throw new Error('Your Google session expired. Please sign in again to connect your channel.');
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`YouTube channel lookup failed (${res.status}): ${errText.slice(0, 180)}`);
  }
  const data = (await res.json()) as {
    items?: Array<{
      id: string;
      snippet?: {
        title?: string;
        customUrl?: string;
        thumbnails?: { default?: { url?: string }; medium?: { url?: string } };
      };
      statistics?: { subscriberCount?: string; videoCount?: string };
    }>;
  };
  const ch = data.items?.[0];
  const resolvedEmail = accountEmail ?? auth.currentUser?.email ?? undefined;
  if (!ch) {
    throw new Error(
      `Signed in${resolvedEmail ? ` as ${resolvedEmail}` : ''}, but no YouTube channel was found on that account. Click "Switch Account / Channel" and select your secondary email ID or Brand Account.`
    );
  }
  return {
    id: ch.id,
    title: ch.snippet?.title || 'Connected Channel',
    customUrl: ch.snippet?.customUrl,
    thumbnailUrl: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url,
    subscriberCount: ch.statistics?.subscriberCount,
    videoCount: ch.statistics?.videoCount,
    accountEmail: resolvedEmail,
  };
}

export async function uploadShortToYouTube(params: {
  accessToken: string;
  clipDownloadUrl: string;
  title: string;
  description: string;
  tags: string[];
  privacyStatus: 'public' | 'unlisted' | 'private';
  publishAtIso?: string;
  onProgress?: (pct: number) => void;
}): Promise<{ videoId: string }> {
  params.onProgress?.(5);
  const videoRes = await fetch(params.clipDownloadUrl);
  if (!videoRes.ok) {
    throw new Error('Could not read rendered MP4 file from local workspace.');
  }
  const videoBlob = await videoRes.blob();
  params.onProgress?.(20);

  const isScheduled = Boolean(params.publishAtIso);
  const metadata = {
    snippet: {
      title: params.title.slice(0, 100),
      description: `${params.description}\n\n#Shorts`.trim().slice(0, 4900),
      tags: params.tags.map((t) => t.replace(/^#/, '')).slice(0, 15),
      categoryId: '20', // Gaming / Entertainment default
    },
    status: {
      privacyStatus: isScheduled ? 'private' : params.privacyStatus,
      ...(isScheduled && params.publishAtIso ? { publishAt: params.publishAtIso } : {}),
      selfDeclaredMadeForKids: false,
    },
  };

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(videoBlob.size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify(metadata),
    }
  );

  if (initRes.status === 401) {
    cachedAccessToken = null;
    throw new Error('YouTube upload session expired. Please reconnect your channel and try again.');
  }

  if (!initRes.ok) {
    const errBody = await initRes.text();
    throw new Error(`YouTube upload session rejected (${initRes.status}): ${errBody.slice(0, 200)}`);
  }

  const uploadUrl = initRes.headers.get('Location');
  if (!uploadUrl) {
    throw new Error('YouTube did not return a resumable upload location.');
  }

  params.onProgress?.(55);

  const putRes = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'Content-Type': 'video/mp4',
    },
    body: videoBlob,
  });

  if (!putRes.ok) {
    const errBody = await putRes.text();
    throw new Error(`YouTube binary upload failed (${putRes.status}): ${errBody.slice(0, 200)}`);
  }

  params.onProgress?.(100);
  const created = (await putRes.json()) as { id?: string };
  if (!created.id) {
    throw new Error('Upload completed without returning a YouTube video ID.');
  }

  return { videoId: created.id };
}

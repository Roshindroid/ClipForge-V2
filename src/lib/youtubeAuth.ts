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

const provider = new GoogleAuthProvider();
provider.addScope('https://www.googleapis.com/auth/youtube.upload');
provider.addScope('https://www.googleapis.com/auth/youtube.readonly');

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

export async function signInWithYouTube(): Promise<{
  user: User;
  accessToken: string;
}> {
  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Google sign-in completed, but no YouTube access token was returned.');
    }
    cachedAccessToken = credential.accessToken;
    return { user: result.user, accessToken: cachedAccessToken };
  } finally {
    isSigningIn = false;
  }
}

export function getCachedYouTubeToken(): string | null {
  return cachedAccessToken;
}

export async function signOutYouTube(): Promise<void> {
  await auth.signOut();
  cachedAccessToken = null;
}

export async function fetchMyYouTubeChannel(
  accessToken: string
): Promise<YouTubeChannelProfile | null> {
  const res = await fetch(
    'https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&mine=true',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );
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
  if (!ch) return null;
  return {
    id: ch.id,
    title: ch.snippet?.title || 'Connected Channel',
    customUrl: ch.snippet?.customUrl,
    thumbnailUrl: ch.snippet?.thumbnails?.medium?.url || ch.snippet?.thumbnails?.default?.url,
    subscriberCount: ch.statistics?.subscriberCount,
    videoCount: ch.statistics?.videoCount,
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

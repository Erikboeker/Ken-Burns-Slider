// Google Photos Picker API integration
// Uses the new Picker API instead of the deprecated Library API

let CLIENT_ID = '';
try {
  CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
} catch {
  // fallback
}

// Picker API scope only - video downloads go through server-side proxy to bypass CORS
const SCOPES = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PICKER_API_BASE = 'https://photospicker.googleapis.com/v1';

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let accessToken: string | null = sessionStorage.getItem('gphoto_token');

// Load Google Identity Services script
let gsiLoaded = false;
export function loadGsi(): Promise<void> {
  if (gsiLoaded) return Promise.resolve();
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src*="accounts.google.com/gsi/client"]')) {
      gsiLoaded = true;
      resolve();
      return;
    }
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = () => {
      gsiLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('Google Identity Services konnte nicht geladen werden'));
    document.head.appendChild(script);
  });
}

export function getAccessToken(): string | null {
  return accessToken;
}

export function isSignedIn(): boolean {
  return accessToken !== null;
}

export function signOut() {
  if (accessToken) {
    google.accounts.oauth2.revoke(accessToken, () => {});
  }
  accessToken = null;
  sessionStorage.removeItem('gphoto_token');
}

export function requestAccess(): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!CLIENT_ID) {
      reject(new Error('VITE_GOOGLE_CLIENT_ID ist nicht konfiguriert. Bitte in .env setzen.'));
      return;
    }

    if (accessToken) {
      resolve(accessToken);
      return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: SCOPES,
      callback: (response) => {
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        accessToken = response.access_token;
        sessionStorage.setItem('gphoto_token', response.access_token);
        resolve(response.access_token);
      },
    });

    // Use '' instead of 'consent' to allow silent re-auth if already granted
    tokenClient.requestAccessToken({ prompt: '' });
  });
}

// Detect video by filename extension
function isVideoFilename(filename: string): boolean {
  const ext = filename.toLowerCase().split('.').pop() || '';
  return ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp', 'mts'].includes(ext);
}

function guessMimeType(filename: string): string {
  const ext = filename.toLowerCase().split('.').pop() || '';
  const mimeMap: Record<string, string> = {
    mp4: 'video/mp4', mov: 'video/quicktime', avi: 'video/x-msvideo',
    webm: 'video/webm', mkv: 'video/x-matroska', m4v: 'video/mp4',
    '3gp': 'video/3gpp', mts: 'video/mp2t',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    heif: 'image/heif', avif: 'image/avif', bmp: 'image/bmp',
  };
  return mimeMap[ext] || 'image/jpeg';
}

export interface GooglePhoto {
  id: string;
  baseUrl: string;
  thumbnailUrl?: string; // Blob URL for display (Picker API requires auth headers)
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  creationTime: string;
  productUrl: string;
}

// Create a picker session and open Google's photo picker
// Persists session ID so polling can resume if page reloads (tablet tab-kill)

export function hasPendingPickerSession(): boolean {
  return !!sessionStorage.getItem('gphoto_picker_session');
}

export async function resumePendingSession(): Promise<GooglePhoto[]> {
  const sessionId = sessionStorage.getItem('gphoto_picker_session');
  if (!sessionId) return [];

  // Ensure we have a token
  if (!accessToken) {
    accessToken = sessionStorage.getItem('gphoto_token');
    if (!accessToken) return [];
  }

  console.log('[GooglePhotos] Resuming pending session:', sessionId);

  try {
    const sessionData = await checkSession(sessionId);
    if (sessionData.mediaItemsSet) {
      sessionStorage.removeItem('gphoto_picker_session');
      return await getPickerMediaItems(sessionId);
    }
    // Not ready yet - poll for it
    return await pollPickerSession(sessionId, null);
  } catch (err) {
    console.warn('[GooglePhotos] Resume failed:', err);
    sessionStorage.removeItem('gphoto_picker_session');
    return [];
  }
}
export async function openPhotoPicker(): Promise<GooglePhoto[]> {
  if (!accessToken) throw new Error('Nicht angemeldet');

  // Verify token is still valid, refresh if needed
  try {
    const testRes = await fetch(`${PICKER_API_BASE}/sessions?pageSize=1`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (testRes.status === 401) {
      console.log('[GooglePhotos] Token expired, requesting new one');
      accessToken = null;
      sessionStorage.removeItem('gphoto_token');
      accessToken = await requestAccess();
    }
  } catch {
    // Ignore validation errors, try to proceed
  }

  // Step 1: Create a picker session
  const sessionRes = await fetch(`${PICKER_API_BASE}/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });

  if (!sessionRes.ok) {
    const errorBody = await sessionRes.text();
    console.error('[GooglePhotos] Session creation failed:', sessionRes.status, errorBody);
    // If 401, try to refresh token and retry once
    if (sessionRes.status === 401) {
      accessToken = null;
      sessionStorage.removeItem('gphoto_token');
      accessToken = await requestAccess();
      return openPhotoPicker();
    }
    throw new Error(`Picker Session Fehler: ${sessionRes.status} – ${errorBody}`);
  }

  const session = await sessionRes.json();
  const sessionId: string = session.id;
  const pickerUri: string = session.pickerUri;
  console.log('[GooglePhotos] Created session:', sessionId, 'pickerUri:', pickerUri);

  // Persist session ID so polling can resume after page reload (tablet tab-kill)
  sessionStorage.setItem('gphoto_picker_session', sessionId);

  // Step 2: Open picker in a popup/tab
  const popupName = `google-photos-picker-${Date.now()}`;
  const popup = window.open(pickerUri, popupName, 'width=800,height=600');

  // Step 3: Poll for completion
  const photos = await pollPickerSession(sessionId, popup);
  console.log('[GooglePhotos] Got', photos.length, 'photos from picker');
  return photos;
}

async function pollPickerSession(
  sessionId: string,
  popup: Window | null
): Promise<GooglePhoto[]> {
  const maxDurationMs = 10 * 60 * 1000; // 10 minutes max
  const startTime = Date.now();
  // On mobile/Android, do NOT use popup.closed detection - it's unreliable
  // (tab switches look like closes). Just poll until mediaItemsSet or timeout.
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  let popupClosedSince = 0;
  let pollCount = 0;

  // Use visibility change to immediately poll when user returns to the tab
  let visibilityChanged = false;
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible') {
      visibilityChanged = true;
      console.log('[GooglePhotos] Tab became visible, will poll immediately');
    }
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  try {
    while (Date.now() - startTime < maxDurationMs) {
      // Wait 1s normally, but if tab just became visible, poll immediately
      if (!visibilityChanged) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      visibilityChanged = false;
      pollCount++;

      try {
        const sessionData = await checkSession(sessionId);
        if (pollCount % 10 === 0 || pollCount <= 3) {
          console.log('[GooglePhotos] Poll #' + pollCount, 'mediaItemsSet:', sessionData.mediaItemsSet);
        }

        if (sessionData.mediaItemsSet) {
          sessionStorage.removeItem('gphoto_picker_session');
          try { if (popup && !popup.closed) popup.close(); } catch {}
          return await getPickerMediaItems(sessionId);
        }
      } catch (err) {
        console.warn('[GooglePhotos] Poll error, retrying:', err);
      }

      // Only use popup.closed detection on desktop
      if (!isMobile) {
        try {
          if (popup && popup.closed) {
            if (!popupClosedSince) {
              popupClosedSince = Date.now();
            } else if (Date.now() - popupClosedSince > 30000) {
              console.log('[GooglePhotos] Popup closed for 30s without mediaItemsSet, treating as cancelled');
              sessionStorage.removeItem('gphoto_picker_session');
              return [];
            }
          } else {
            popupClosedSince = 0;
          }
        } catch {
          // Cross-origin - ignore
        }
      }
    }
  } finally {
    document.removeEventListener('visibilitychange', onVisibilityChange);
  }

  sessionStorage.removeItem('gphoto_picker_session');
  try { if (popup && !popup.closed) popup.close(); } catch {}
  throw new Error('Zeitüberschreitung beim Warten auf Fotoauswahl');
}

async function checkSession(sessionId: string): Promise<{ mediaItemsSet: boolean; [key: string]: unknown }> {
  const res = await fetch(`${PICKER_API_BASE}/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Session-Abfrage Fehler: ${res.status} – ${errorBody}`);
  }

  const data = await res.json();
  // Log full session data to help debug
  console.log('[GooglePhotos] Session data:', JSON.stringify(data));
  return data;
}

async function getPickerMediaItems(sessionId: string): Promise<GooglePhoto[]> {
  console.log('[GooglePhotos] Fetching media items for session:', sessionId);
  const photos: GooglePhoto[] = [];
  let pageToken: string | undefined;
  let pageNum = 0;

  do {
    pageNum++;
    const params = new URLSearchParams({
      sessionId,
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);

    const res = await fetch(`${PICKER_API_BASE}/mediaItems?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Medien-Abfrage Fehler: ${res.status} – ${errorBody}`);
    }

    const data = await res.json();
    console.log(`[GooglePhotos] mediaItems page ${pageNum} response:`, JSON.stringify(data).substring(0, 500));

    // The Picker API may use "mediaItems" or "pickingMediaItems"
    const items = data.mediaItems || data.pickingMediaItems || [];

    for (const item of items) {
      // Handle both Picker API structures
      const mediaFile = item.mediaFile || item;
      const baseUrl = mediaFile.baseUrl || item.baseUrl || '';
      const filename = mediaFile.filename || item.filename || 'photo.jpg';
      // Detect mimeType: prefer API value, fall back to extension-based guess
      let mimeType = mediaFile.mimeType || item.mimeType || '';
      if (!mimeType || mimeType === 'application/octet-stream') {
        mimeType = guessMimeType(filename);
      }
      // Also check item.type field from Picker API (e.g. "PHOTO" or "VIDEO")
      if (item.type === 'VIDEO' || (item.mediaFile?.mediaFileMetadata?.videoMetadata)) {
        if (!mimeType.startsWith('video/')) {
          mimeType = isVideoFilename(filename) ? guessMimeType(filename) : 'video/mp4';
        }
      }
      const metadata = mediaFile.mediaFileMetadata || item.mediaMetadata || {};
      console.log('[GooglePhotos] Item:', filename, 'type:', item.type, 'mimeType:', mimeType);

      if (!baseUrl) {
        console.warn('[GooglePhotos] Skipping item without baseUrl:', JSON.stringify(item));
        continue;
      }

      photos.push({
        id: item.id || filename,
        baseUrl,
        filename,
        mimeType,
        width: parseInt(metadata.width || '0'),
        height: parseInt(metadata.height || '0'),
        creationTime: metadata.creationTime || '',
        productUrl: item.productUrl || '',
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return photos;
}

// Legacy function kept for compatibility - now uses picker
export async function listPhotos(
  _pageToken?: string,
  _pageSize = 50
): Promise<{ photos: GooglePhoto[]; nextPageToken?: string }> {
  const photos = await openPhotoPicker();
  return { photos, nextPageToken: undefined };
}

export async function downloadPhoto(photo: GooglePhoto): Promise<File> {
  if (!accessToken) throw new Error('Nicht angemeldet');

  const isVideo = photo.mimeType.startsWith('video/') || isVideoFilename(photo.filename);
  console.log('[GooglePhotos] Downloading:', photo.filename, 'mimeType:', photo.mimeType, 'isVideo:', isVideo, 'id:', photo.id);

  // For videos: use server-side proxy to bypass CORS restrictions on =dv downloads
  if (isVideo) {
    try {
      const videoUrl = `${photo.baseUrl}=dv`;
      console.log('[GooglePhotos] Downloading video via proxy:', photo.filename);

      const proxyRes = await fetch('/api/proxy-video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: videoUrl, token: accessToken }),
      });

      console.log('[GooglePhotos] Proxy response:', proxyRes.status, 'type:', proxyRes.headers.get('content-type'));

      if (proxyRes.ok) {
        const blob = await proxyRes.blob();
        console.log('[GooglePhotos] Proxy video blob:', blob.size, blob.type);

        if (blob.size > 100 * 1024) { // > 100KB = real video
          const actualType = blob.type?.startsWith('video/') ? blob.type : guessMimeType(photo.filename);
          return new File([blob], photo.filename || 'video.mp4', { type: actualType });
        }
        console.warn('[GooglePhotos] Proxy returned small blob, probably thumbnail. size:', blob.size);
      } else {
        const errText = await proxyRes.text();
        console.warn('[GooglePhotos] Proxy error:', proxyRes.status, errText);
      }
    } catch (err) {
      console.warn('[GooglePhotos] Proxy video download failed:', err);
    }

    // Fall through to image fallback below
  }

  // For images (or video fallback): use Picker API baseUrl
  const urlsToTry = [
    `${photo.baseUrl}=d`,
    photo.baseUrl,
    `${photo.baseUrl}=w0-h0`,
  ];

  for (const url of urlsToTry) {
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (res.ok) {
        const blob = await res.blob();
        if (blob.size === 0) continue;

        let actualType = blob.type;
        if (!actualType || actualType === 'application/octet-stream') {
          actualType = isVideo ? 'image/jpeg' : (photo.mimeType || guessMimeType(photo.filename));
        }
        const filename = isVideo
          ? (photo.filename.replace(/\.\w+$/, '.jpg') || 'video_thumbnail.jpg')
          : (photo.filename || 'photo.jpg');
        if (isVideo) {
          actualType = 'image/jpeg';
        }
        return new File([blob], filename, { type: actualType });
      }
    } catch (err) {
      console.warn('[GooglePhotos] Fetch error:', err);
    }
  }

  throw new Error(`Download fehlgeschlagen: ${photo.filename}`);
}

// Type declarations for Google Identity Services
declare global {
  namespace google.accounts.oauth2 {
    interface TokenClient {
      requestAccessToken(config?: { prompt?: string }): void;
    }
    interface TokenResponse {
      access_token: string;
      error?: string;
      error_description?: string;
    }
    function initTokenClient(config: {
      client_id: string;
      scope: string;
      callback: (response: TokenResponse) => void;
    }): TokenClient;
    function revoke(token: string, callback: () => void): void;
  }
}

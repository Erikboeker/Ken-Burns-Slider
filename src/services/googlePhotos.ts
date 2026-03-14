// Google Photos Picker API integration
// Uses the new Picker API instead of the deprecated Library API

let CLIENT_ID = '';
try {
  CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
} catch {
  // fallback
}

// Photos Picker API uses a different, less restricted scope
const SCOPES = 'https://www.googleapis.com/auth/photospicker.mediaitems.readonly';
const PICKER_API_BASE = 'https://photospicker.googleapis.com/v1';

let tokenClient: google.accounts.oauth2.TokenClient | null = null;
let accessToken: string | null = null;

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
        resolve(response.access_token);
      },
    });

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
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
      accessToken = await requestAccess();
      return openPhotoPicker();
    }
    throw new Error(`Picker Session Fehler: ${sessionRes.status} – ${errorBody}`);
  }

  const session = await sessionRes.json();
  const sessionId: string = session.id;
  const pickerUri: string = session.pickerUri;
  console.log('[GooglePhotos] Created session:', sessionId, 'pickerUri:', pickerUri);

  // Step 2: Open picker in a popup window (unique name per session to avoid reuse)
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
  const maxAttempts = 600; // 10 minutes max (600 * 1s)

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1000));

    try {
      const sessionData = await checkSession(sessionId);
      if (i % 5 === 0) {
        console.log('[GooglePhotos] Poll #' + i, JSON.stringify(sessionData));
      }

      if (sessionData.mediaItemsSet) {
        try { if (popup && !popup.closed) popup.close(); } catch {}
        return await getPickerMediaItems(sessionId);
      }
    } catch (err) {
      // Network error during poll - just retry
      console.warn('[GooglePhotos] Poll error, retrying:', err);
    }
  }

  try { if (popup && !popup.closed) popup.close(); } catch {}
  throw new Error('Zeitüberschreitung beim Warten auf Fotoauswahl');
}

async function checkSession(sessionId: string): Promise<{ mediaItemsSet: boolean }> {
  const res = await fetch(`${PICKER_API_BASE}/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Session-Abfrage Fehler: ${res.status} – ${errorBody}`);
  }

  return await res.json();
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
      const mimeType = mediaFile.mimeType || item.mimeType || 'image/jpeg';
      const metadata = mediaFile.mediaFileMetadata || item.mediaMetadata || {};

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

  const isVideo = photo.mimeType.startsWith('video/');
  const downloadUrl = isVideo
    ? `${photo.baseUrl}=dv`
    : `${photo.baseUrl}=d`;

  // Picker API requires Authorization header for download
  const res = await fetch(downloadUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    // Fallback: try without size suffix
    const fallbackRes = await fetch(photo.baseUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!fallbackRes.ok) {
      throw new Error(`Download fehlgeschlagen: ${photo.filename}`);
    }
    const blob = await fallbackRes.blob();
    return new File([blob], photo.filename, { type: photo.mimeType });
  }

  const blob = await res.blob();
  return new File([blob], photo.filename, { type: photo.mimeType });
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

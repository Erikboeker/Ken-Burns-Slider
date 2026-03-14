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
    throw new Error(`Picker Session Fehler: ${sessionRes.status} – ${errorBody}`);
  }

  const session = await sessionRes.json();
  const sessionId: string = session.id;
  const pickerUri: string = session.pickerUri;

  // Step 2: Open picker in a popup window
  const popup = window.open(pickerUri, 'google-photos-picker', 'width=800,height=600');

  // Step 3: Poll for completion
  const photos = await pollPickerSession(sessionId, popup);
  return photos;
}

async function pollPickerSession(
  sessionId: string,
  popup: Window | null
): Promise<GooglePhoto[]> {
  const maxAttempts = 300; // 5 minutes max (300 * 1s)
  let popupClosedCount = 0;

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, 1500));

    // Always check session first - don't rely on popup.closed (unreliable on mobile)
    const sessionData = await checkSession(sessionId);
    console.log('[GooglePhotos] Poll #' + i, JSON.stringify(sessionData));

    if (sessionData.mediaItemsSet) {
      try { if (popup && !popup.closed) popup.close(); } catch {}
      return await getPickerMediaItems(sessionId);
    }

    // On mobile, popup.closed can be unreliable (cross-origin, new tab)
    // Only treat as cancelled after popup has been closed for multiple polls
    try {
      if (popup && popup.closed) {
        popupClosedCount++;
        // Wait for 5 consecutive polls with popup closed before giving up
        if (popupClosedCount >= 5) {
          console.log('[GooglePhotos] Popup closed for 5 polls, treating as cancelled');
          return [];
        }
      } else {
        popupClosedCount = 0;
      }
    } catch {
      // Cross-origin error accessing popup.closed - ignore
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
  const photos: GooglePhoto[] = [];
  let pageToken: string | undefined;

  do {
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
    console.log('[GooglePhotos] mediaItems response:', JSON.stringify(data));

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

      // Fetch thumbnail with auth header and create blob URL for display
      let thumbnailUrl: string | undefined;
      try {
        const thumbRes = await fetch(`${baseUrl}=w300-h300-c`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
        if (thumbRes.ok) {
          const blob = await thumbRes.blob();
          thumbnailUrl = URL.createObjectURL(blob);
        } else {
          console.warn('[GooglePhotos] Thumbnail fetch failed:', thumbRes.status);
        }
      } catch (e) {
        console.warn('[GooglePhotos] Thumbnail fetch error:', e);
      }

      photos.push({
        id: item.id || filename,
        baseUrl,
        thumbnailUrl,
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

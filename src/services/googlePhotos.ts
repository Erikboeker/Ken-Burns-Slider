declare const __VITE_GOOGLE_CLIENT_ID__: string | undefined;

// Client ID can be set via env or vite define
let CLIENT_ID = '';
try {
  CLIENT_ID = (import.meta as any).env?.VITE_GOOGLE_CLIENT_ID || '';
} catch {
  // fallback
}
const SCOPES = 'https://www.googleapis.com/auth/photoslibrary.readonly';

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
      include_granted_scopes: true,
      callback: (response: any) => {
        const grantedScopes = response.scope || 'keine';
        const hasPhotosScope = grantedScopes.includes('photoslibrary');
        if (!hasPhotosScope) {
          alert(`Scope-Problem!\n\nAngefordert: ${SCOPES}\nGewährt: ${grantedScopes}\n\nDer Photos-Scope wurde nicht gewährt.`);
        }
        if (response.error) {
          reject(new Error(response.error_description || response.error));
          return;
        }
        accessToken = response.access_token;
        resolve(response.access_token);
      },
    } as any);

    tokenClient.requestAccessToken({ prompt: 'consent' });
  });
}

export interface GooglePhoto {
  id: string;
  baseUrl: string;
  filename: string;
  mimeType: string;
  width: number;
  height: number;
  creationTime: string;
  productUrl: string;
}

interface MediaItemsResponse {
  mediaItems?: {
    id: string;
    baseUrl: string;
    filename: string;
    mimeType: string;
    mediaMetadata: {
      width: string;
      height: string;
      creationTime: string;
      photo?: Record<string, unknown>;
      video?: { status: string };
    };
    productUrl: string;
  }[];
  nextPageToken?: string;
}

export async function listPhotos(
  pageToken?: string,
  pageSize = 50
): Promise<{ photos: GooglePhoto[]; nextPageToken?: string }> {
  if (!accessToken) throw new Error('Nicht angemeldet');

  const params = new URLSearchParams({
    pageSize: String(pageSize),
  });
  if (pageToken) params.set('pageToken', pageToken);

  const res = await fetch(
    `https://photoslibrary.googleapis.com/v1/mediaItems?${params}`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    }
  );

  if (res.status === 401) {
    accessToken = null;
    throw new Error('Sitzung abgelaufen. Bitte erneut anmelden.');
  }

  if (!res.ok) {
    const errorBody = await res.text();
    console.error('Google Photos API error:', res.status, errorBody);
    throw new Error(`Google Photos API Fehler: ${res.status} – ${errorBody}`);
  }

  const data: MediaItemsResponse = await res.json();

  const photos: GooglePhoto[] = (data.mediaItems || [])
    .filter((item) => {
      // Only include photos and ready videos
      if (item.mediaMetadata.video) {
        return item.mediaMetadata.video.status === 'READY';
      }
      return item.mimeType.startsWith('image/');
    })
    .map((item) => ({
      id: item.id,
      baseUrl: item.baseUrl,
      filename: item.filename,
      mimeType: item.mimeType,
      width: parseInt(item.mediaMetadata.width),
      height: parseInt(item.mediaMetadata.height),
      creationTime: item.mediaMetadata.creationTime,
      productUrl: item.productUrl,
    }));

  return { photos, nextPageToken: data.nextPageToken };
}

export async function downloadPhoto(photo: GooglePhoto): Promise<File> {
  // Append =d to baseUrl for download, =w{width}-h{height} for sized
  const isVideo = photo.mimeType.startsWith('video/');
  const downloadUrl = isVideo
    ? `${photo.baseUrl}=dv`
    : `${photo.baseUrl}=d`;

  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Download fehlgeschlagen: ${photo.filename}`);

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

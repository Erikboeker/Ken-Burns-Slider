// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, token, debug } = req.body as { url?: string; token?: string; debug?: boolean };

  if (!url || !token) {
    return res.status(400).json({ error: 'Missing url or token' });
  }

  // Only allow Google Photos URLs
  if (!url.startsWith('https://lh3.googleusercontent.com/') && !url.startsWith('https://video.googleusercontent.com/')) {
    return res.status(400).json({ error: 'Invalid URL domain' });
  }

  // Debug/probe mode: try multiple URL variants with only first 1KB to check content-type
  if (debug) {
    const baseUrl = url.replace(/=[^/]*$/, ''); // strip any existing params
    const variants = [
      { label: '=dv', url: `${baseUrl}=dv`, auth: true },
      { label: '=dv-noauth', url: `${baseUrl}=dv`, auth: false },
      { label: '=m18', url: `${baseUrl}=m18`, auth: true },
      { label: '=m37', url: `${baseUrl}=m37`, auth: true },
    ];

    // Run all probes in parallel with Range header to only fetch first 1KB
    const results = await Promise.all(variants.map(async (v) => {
      try {
        const headers: Record<string, string> = { Range: 'bytes=0-1023' };
        if (v.auth) headers['Authorization'] = `Bearer ${token}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const r = await fetch(v.url, {
          headers,
          redirect: 'follow',
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const contentType = r.headers.get('content-type') || '?';
        const contentLength = r.headers.get('content-length') || '?';
        // Content-Range tells us total size for 206 responses
        const contentRange = r.headers.get('content-range') || '';
        const totalSize = contentRange.match(/\/(\d+)/)?.[1] || contentLength;

        // Read the small probe chunk
        const buf = await r.arrayBuffer();

        return {
          label: v.label,
          status: r.status,
          contentType,
          totalSize,
          probeSize: buf.byteLength,
          isVideo: contentType.startsWith('video/') || parseInt(String(totalSize)) > 500000,
          url: v.url,
          auth: v.auth,
        };
      } catch (err: any) {
        return { label: v.label, error: err.message, isVideo: false, url: v.url, auth: v.auth };
      }
    }));

    return res.status(200).json({ results, baseUrl });
  }

  // Normal download mode
  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream error: ${response.status}`,
      });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await response.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', arrayBuffer.byteLength.toString());
    return res.send(Buffer.from(arrayBuffer));
  } catch (err: any) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy fetch failed: ' + err.message });
  }
}

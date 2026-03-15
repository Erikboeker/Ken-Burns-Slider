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

  // Debug mode: try multiple URL variants and return info about each
  if (debug) {
    const baseUrl = url.replace(/=[^/]*$/, ''); // strip any existing params
    const variants = [
      { label: '=dv (with auth)', url: `${baseUrl}=dv`, auth: true },
      { label: '=dv (no auth)', url: `${baseUrl}=dv`, auth: false },
      { label: '=m18 (with auth)', url: `${baseUrl}=m18`, auth: true },
      { label: '=m37 (with auth)', url: `${baseUrl}=m37`, auth: true },
      { label: '=d (with auth)', url: `${baseUrl}=d`, auth: true },
      { label: 'raw (with auth)', url: baseUrl, auth: true },
      { label: 'raw (no auth)', url: baseUrl, auth: false },
    ];

    const results = [];
    for (const v of variants) {
      try {
        const headers: Record<string, string> = {};
        if (v.auth) headers['Authorization'] = `Bearer ${token}`;
        const r = await fetch(v.url, { headers, redirect: 'follow' });
        const contentType = r.headers.get('content-type') || '?';
        const contentLength = r.headers.get('content-length') || '?';
        // Read just first few bytes to check
        const buf = await r.arrayBuffer();
        results.push({
          label: v.label,
          status: r.status,
          contentType,
          contentLength,
          actualSize: buf.byteLength,
          isVideo: contentType.startsWith('video/') || buf.byteLength > 500000,
          finalUrl: r.url?.substring(0, 100),
        });
      } catch (err: any) {
        results.push({ label: v.label, error: err.message });
      }
    }
    return res.status(200).json({ results, baseUrl });
  }

  // Normal mode: fetch and return
  try {
    // Try with auth first
    let response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'follow',
    });

    // If auth fails, try without (Picker URLs can be self-authenticated)
    if (!response.ok) {
      response = await fetch(url, { redirect: 'follow' });
    }

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

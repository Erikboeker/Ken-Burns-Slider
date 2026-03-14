// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default async function handler(req: any, res: any) {
  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { url, token } = req.body as { url?: string; token?: string };

  if (!url || !token) {
    return res.status(400).json({ error: 'Missing url or token' });
  }

  // Only allow Google Photos URLs
  if (!url.startsWith('https://lh3.googleusercontent.com/')) {
    return res.status(400).json({ error: 'Invalid URL domain' });
  }

  try {
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Upstream error: ${response.status}`,
      });
    }

    const contentType = response.headers.get('content-type') || 'application/octet-stream';
    const contentLength = response.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }

    // Stream the response
    const arrayBuffer = await response.arrayBuffer();
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('Proxy error:', err);
    return res.status(500).json({ error: 'Proxy fetch failed' });
  }
}

// Edge Runtime for streaming support (up to 300s instead of 10s serverless timeout)
export const config = {
  runtime: 'edge',
};

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const { url, token } = (await req.json()) as { url?: string; token?: string };

  if (!url || !token) {
    return new Response(JSON.stringify({ error: 'Missing url or token' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Only allow Google Photos URLs
  if (
    !url.startsWith('https://lh3.googleusercontent.com/') &&
    !url.startsWith('https://video.googleusercontent.com/')
  ) {
    return new Response(JSON.stringify({ error: 'Invalid URL domain' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const upstream = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!upstream.ok) {
      return new Response(
        JSON.stringify({ error: `Upstream error: ${upstream.status}` }),
        { status: upstream.status, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const contentLength = upstream.headers.get('content-length');

    const headers: Record<string, string> = {
      'Content-Type': contentType,
    };
    if (contentLength) {
      headers['Content-Length'] = contentLength;
    }

    // Stream the response body directly - no buffering
    return new Response(upstream.body, { status: 200, headers });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(
      JSON.stringify({ error: 'Proxy fetch failed: ' + message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

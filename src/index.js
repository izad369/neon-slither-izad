const ORIGIN = "https://neon-slither-izad.onrender.com";

export default {
  async fetch(request) {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, ORIGIN);

    const headers = new Headers(request.headers);
    headers.set("X-Neon-Slither-Cloudflare", "1");

    const proxyRequest = new Request(target.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      redirect: "manual",
    });

    // Cloudflare Workers can proxy WebSocket upgrade requests with fetch().
    // The browser continues to use the same /ws endpoint.
    return fetch(proxyRequest);
  },
};
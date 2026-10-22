const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), screen-wake-lock=(self)",
  "Cache-Control": "no-store",
};

export function jsonResponse(value: unknown, status = 200): Response {
  const headers = new Headers({ "Content-Type": "application/json; charset=utf-8" });
  addSecurityHeaders(headers);
  return Response.json(value, { status, headers });
}

export function textResponse(value: string, status: number, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/plain; charset=utf-8");
  addSecurityHeaders(headers);
  return new Response(value, { status, headers });
}

export function addSecurityHeaders(headers: Headers): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value);
  }
}

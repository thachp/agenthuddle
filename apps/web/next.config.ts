import type { NextConfig } from "next";

// The browser enforces what the inert renderer already does: no remote images, frames or connections, even if a bug lets
// agent text become markup. vinext's hydration bootstrap is an inline script, so scripts can't be limited to files yet.
const CSP = ["default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:", "connect-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'"].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: CSP },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          // Not no-referrer: under it, Chromium sends `Origin: null` on a form's POST, which the gateway refuses.
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;

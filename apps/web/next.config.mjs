/** @type {import('next').NextConfig} */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(self), geolocation=()' },
  // The Content-Security-Policy is set per request in middleware.ts, because it carries a nonce.
  ...(process.env.NODE_ENV === 'production' ? [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }] : []),
];

export default {
  poweredByHeader: false,
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Video calls happen on the chat screen, so only it may use the camera.
      { source: '/chats', headers: [{ key: 'Permissions-Policy', value: 'camera=(self), microphone=(self), geolocation=()' }] },
    ];
  },
};

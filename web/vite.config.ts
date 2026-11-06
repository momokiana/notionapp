import { defineConfig } from 'vite';

export function backendOrigin(raw: string): string {
  const u = new URL(raw);
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
      !['http:', 'https:'].includes(u.protocol) ||
      (u.protocol === 'http:' && !['127.0.0.1', '[::1]', 'localhost'].includes(u.hostname))) {
    throw new Error('WEB_BACKEND must be an HTTPS origin, or loopback HTTP origin');
  }
  return u.origin;
}
const target = backendOrigin(process.env.WEB_BACKEND ?? 'http://127.0.0.1:4318');
const instance = process.env.WEB_INSTANCE ?? 'local-development';
if (!/^[A-Za-z0-9_-]{1,80}$/.test(instance)) throw new Error('Invalid WEB_INSTANCE');
const headers = {
  'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};
const proxy = {
  '^/api/v1(?:/|\\?|$)': {
    target, changeOrigin: true, secure: true, followRedirects: false,
    rewrite: (path: string) => path.slice(4),
    configure: (p: { on: (event: string, callback: (response: { headers: Record<string, unknown> }) => void) => void }) => {
      p.on('proxyRes', response => { response.headers['cache-control'] = 'no-store'; });
    },
  },
};
export default defineConfig({
  define: { __DEPLOYMENT__: JSON.stringify({ instance, target }) },
  server: { host: '127.0.0.1', port: 4317, strictPort: true, headers, proxy,
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/.local/**'] },
  },
  preview: { host: '127.0.0.1', port: 4317, strictPort: true, headers, proxy },
  build: { sourcemap: false, target: 'es2022' },
});

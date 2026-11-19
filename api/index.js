// Vercel entry point: every request that isn't a static file comes here.
import { requestHandler } from '../src/server.js';

export default function handler(req, res) {
  // vercel.json rewrites "/anything" to "/api/index?__path=/anything"; restore the original path.
  const url = new URL(req.url, 'http://localhost');
  const original = url.searchParams.get('__path');
  if (original !== null) {
    url.searchParams.delete('__path');
    const qs = url.searchParams.toString();
    req.url = (original.startsWith('/') ? original : `/${original}`) + (qs ? `?${qs}` : '');
  }
  return requestHandler(req, res);
}

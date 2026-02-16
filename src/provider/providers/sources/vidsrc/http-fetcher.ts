/* eslint-disable no-console */
import { CookieJar } from 'tough-cookie';
import { fetch } from 'undici';

/**
 * Lightweight HTTP-based fetcher to bypass basic Cloudflare protection
 * Uses proper headers, cookies, and delays to appear as a real browser
 */

// Shared cookie jar for maintaining session
const cookieJar = new CookieJar();

interface FetchOptions {
  referer?: string;
  origin?: string;
  retries?: number;
  delay?: number;
}

/**
 * Fetch with proper browser-like headers and cookie handling
 */
export async function fetchWithHeaders(url: string, options: FetchOptions = {}): Promise<string> {
  const { referer, origin, retries = 3, delay = 2000 } = options;

  const headers: Record<string, string> = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    DNT: '1',
    Connection: 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0',
  };

  if (referer) headers.Referer = referer;
  if (origin) headers.Origin = origin;

  // Get cookies for this domain
  const cookies = await cookieJar.getCookies(url);
  if (cookies.length > 0) {
    headers.Cookie = cookies.map((c) => `${c.key}=${c.value}`).join('; ');
  }

  let lastError: Error | null = null;

  for (let i = 0; i < retries; i++) {
    try {
      // Random delay to appear human-like
      if (i > 0) {
        const randomDelay = Math.floor(Math.random() * 1000) + delay;
        await new Promise<void>((resolve) => {
          setTimeout(resolve, randomDelay);
        });
      }
      const response = await fetch(url, {
        headers,
        redirect: 'follow',
      });

      // Save cookies from response
      const setCookieHeaders = response.headers.get('set-cookie');
      if (setCookieHeaders) {
        const cookieStrings = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        for (const cookieStr of cookieStrings) {
          await cookieJar.setCookie(cookieStr, url);
        }
      }

      if (!response.ok) {
        // Handle common Cloudflare status codes
        if (response.status === 403) {
          lastError = new Error(`Cloudflare blocked (403)`);
          continue;
        }
        if (response.status === 503) {
          lastError = new Error(`Service unavailable (503)`);
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const html = await response.text();

      // Check if we got a Cloudflare challenge page
      if (html.includes('cf-turnstile') || html.includes('Checking your browser') || html.includes('cf-challenge')) {
        lastError = new Error('Cloudflare challenge cannot be bypassed without browser');
        continue;
      }
      return html;
    } catch (error: any) {
      lastError = error;
    }
  }

  throw lastError || new Error('Failed to fetch after multiple retries');
}

/**
 * Extract data from page without executing JavaScript
 * Parses HTML to find script contents and extract values
 */
export function extractFromHTML(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match ? match[1] : null;
}

/**
 * Extract all script tags content from HTML
 */
export function extractScripts(html: string): string[] {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts: string[] = [];
  const matches = html.matchAll(scriptRegex);
  for (const match of matches) {
    scripts.push(match[1]);
  }

  return scripts;
}

/**
 * Clear cookie jar (useful for testing)
 */
export function clearCookies(): void {
  cookieJar.removeAllCookiesSync();
}

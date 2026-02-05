/* eslint-disable no-console */
import { serializeBody } from '@/fetchers/body';
import { makeFullUrl } from '@/fetchers/common';
import { FetchLike, FetchReply } from '@/fetchers/fetch';
import { Fetcher } from '@/fetchers/types';

function getHeaders(list: string[], res: FetchReply): Headers {
  const output = new Headers();
  list.forEach((header) => {
    const realHeader = header.toLowerCase();
    const realValue = res.headers.get(realHeader);
    const extraValue = res.extraHeaders?.get(realHeader);
    const value = extraValue ?? realValue;
    if (!value) return;
    output.set(realHeader, value);
  });
  return output;
}

export function makeStandardFetcher(_f: FetchLike): Fetcher {
  const normalFetch: Fetcher = async (url, ops) => {
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);

    // AbortController
    const controller = new AbortController();
    const timeout = 15000; // 15s timeout
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Direct fetch - proxy handling now done by Cloudflare Worker
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...seralizedBody.headers,
        ...ops.headers,
      };

      const res = await fetch(fullUrl, {
        method: ops.method,
        headers,
        body: seralizedBody.body as RequestInit['body'],
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let body: any;
      const isJson = res.headers.get('content-type')?.includes('application/json');
      if (isJson) body = await res.json();
      else body = await res.text();

      return {
        body,
        finalUrl: res.url,
        headers: getHeaders(ops.readHeaders, {
          headers: res.headers,
          status: res.status,
          url: res.url,
        } as unknown as FetchReply),
        statusCode: res.status,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Fetch request to ${fullUrl} timed out after ${timeout}ms`);
      }
      throw error;
    }
  };

  return normalFetch;
}

export function makeProxiedFetcher(_f: FetchLike): Fetcher {
  const SCRAPER_PROXY = process.env.SCRAPER_PROXY;

  // If no proxy configured, fall back to normal fetch
  if (!SCRAPER_PROXY) {
    return makeStandardFetcher(_f);
  }

  const proxiedFetch: Fetcher = async (url, ops) => {
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);

    // Build proxy URL with target as query param
    const proxyUrl = new URL(SCRAPER_PROXY);
    proxyUrl.searchParams.set('url', fullUrl);

    // AbortController
    const controller = new AbortController();
    const timeout = 15000; // 15s timeout
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      // Fetch through proxy
      const headers = {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        ...seralizedBody.headers,
        ...ops.headers,
      };

      const res = await fetch(proxyUrl.toString(), {
        method: ops.method,
        headers,
        body: seralizedBody.body as RequestInit['body'],
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      let body: any;
      const isJson = res.headers.get('content-type')?.includes('application/json');
      if (isJson) body = await res.json();
      else body = await res.text();

      return {
        body,
        finalUrl: res.url,
        headers: getHeaders(ops.readHeaders, {
          headers: res.headers,
          status: res.status,
          url: res.url,
        } as unknown as FetchReply),
        statusCode: res.status,
      };
    } catch (error: any) {
      if (error.name === 'AbortError') {
        throw new Error(`Proxied fetch request to ${fullUrl} timed out after ${timeout}ms`);
      }
      throw error;
    }
  };

  return proxiedFetch;
}

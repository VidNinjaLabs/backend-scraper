/* eslint-disable no-useless-concat */
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';

// TMDB Proxy (required - no direct access)
function getTMDBProxy(): string {
  const proxy = process.env.TMDB_PROXY;
  if (!proxy) {
    throw new Error(
      'Missing TMDB_PROXY environment variable. Deploy tmdb-proxy worker first.\n' + 'See: tmdb-proxy/README.md',
    );
  }
  return proxy;
}

// TMDB Response Interfaces
interface TMDBMovieResponse {
  id: number;
  title: string;
  original_title: string;
  name?: string; // For TV shows
}

interface TMDBErrorResponse {
  success: false;
  status_code: number;
  status_message: string;
}

/**
 * Fetch TMDB data with automatic retry via proxy
 * @param url - TMDB API endpoint (will be routed through proxy)
 * @param retries - Number of retry attempts (default: 3)
 * @returns Response object
 */
async function tmdbFetch(url: string, retries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      // Direct fetch - proxy handled by Cloudflare Worker
      const response = await fetch(url, {
        headers: {
          Accept: 'application/json',
        },
      });

      if (response.ok) {
        return response;
      }

      // Don't retry 4xx errors (client errors)
      if (response.status >= 400 && response.status < 500) {
        throw new Error(`TMDB API error: ${response.status} ${response.statusText}`);
      }

      // Retry 5xx errors (server errors)
      if (attempt < retries) {
        await new Promise((resolve) => {
          setTimeout(resolve, 1000 * attempt);
        }); // Exponential backoff
        continue;
      }

      throw new Error(`TMDB API error after ${retries} attempts: ${response.status}`);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 1000 * attempt);
      });
    }
  }

  throw new Error('TMDB fetch failed after all retries');
}

/**
 * Fetch TMDB title/name for a media item
 * @param ctx - Movie or show scrape context
 * @param lang - Language code (default: 'en-US')
 * @returns The title (movie) or name (TV show)
 */
export async function fetchTMDBName(
  ctx: ShowScrapeContext | MovieScrapeContext,
  lang: string = 'en-US',
): Promise<string> {
  const type = ctx.media.type === 'movie' ? 'movie' : 'tv';
  // Build proxy URL path
  const proxyUrl = new URL(`/${type}/${ctx.media.tmdbId}`, getTMDBProxy());
  proxyUrl.searchParams.set('language', lang);

  const response = await tmdbFetch(proxyUrl.toString());
  const data: TMDBMovieResponse | TMDBErrorResponse = await response.json();

  if ('success' in data && data.success === false) {
    throw new Error(`TMDB API error: ${data.status_message}`);
  }

  const name = ctx.media.type === 'movie' ? (data as TMDBMovieResponse).title : (data as TMDBMovieResponse).name;

  if (!name) {
    throw new Error(`TMDB response missing ${ctx.media.type === 'movie' ? 'title' : 'name'}`);
  }

  return name;
}

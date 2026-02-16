/* eslint-disable no-empty */
/* eslint-disable no-promise-executor-return */
/* eslint-disable no-console */
import { MovieMedia, ShowMedia } from '@/entrypoint/utils/media';
import { compareMedia } from '@/utils/compare';
import { ScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

import { Result, ResultItem, ShowDataResult, episodeObj } from './type';
import { getVideo } from './video';

export const baseUrl = 'https://lmscript.xyz';

export async function searchAndFindMedia(
  ctx: ScrapeContext,
  media: MovieMedia | ShowMedia,
): Promise<ResultItem | undefined> {
  if (media.type === 'show') {
    const searchRes = await ctx.proxiedFetcher<Result>(`/v1/shows`, {
      baseUrl,
      query: { 'filters[q]': media.title },
    });

    const results = searchRes.items;

    const result = results.find((res: ResultItem) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
  if (media.type === 'movie') {
    const searchRes = await ctx.proxiedFetcher<Result>(`/v1/movies`, {
      baseUrl,
      query: { 'filters[q]': media.title },
    });

    const results = searchRes.items;
    const result = results.find((res: ResultItem) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
}

export async function scrape(ctx: ScrapeContext, media: MovieMedia | ShowMedia, result: ResultItem) {
  // Find the relevant id
  let id = null;
  if (media.type === 'movie') {
    id = result.id_movie;
  } else if (media.type === 'show') {
    const data = await ctx.proxiedFetcher<ShowDataResult>(`/v1/shows`, {
      baseUrl,
      query: { expand: 'episodes', id: result.id_show },
    });

    const episode = data.episodes?.find((v: episodeObj) => {
      return Number(v.season) === Number(media.season.number) && Number(v.episode) === Number(media.episode.number);
    });

    if (episode) id = episode.id;
  }

  // Check ID
  if (id === null) throw new NotFoundError('Not found');

  let hash = null;
  let expires = null;

  // For TV Shows, try to scrape specific security tokens from the official site
  // because the public API often fails with 401 for TV shows.
  if (media.type === 'show' && ctx.browserFetcher) {
    const maxRetries = 2;
    let retryCount = 0;

    while (retryCount <= maxRetries && !hash) {
      try {
        const officialUrl = `https://www.lookmovie2.to/shows/play/${result.slug}`;

        const pageHtml = await ctx.browserFetcher(officialUrl);

        const patterns = [
          // Pattern 1: JSON-like assignment (hash: "value", expires: 123)
          {
            name: 'JSON assignment',
            hashRegex: /hash\s*[:=]\s*["']([^"']+)["']/,
            expiresRegex: /expires\s*[:=]\s*(\d+)/,
          },
          // Pattern 2: URL query params (hash=value&expires=123)
          {
            name: 'URL params',
            hashRegex: /hash=([^&"'\s]+)/,
            expiresRegex: /expires=(\d+)/,
          },
          // Pattern 3: data-hash and data-expires attributes
          {
            name: 'data attributes',
            hashRegex: /data-hash=["']([^"']+)["']/,
            expiresRegex: /data-expires=["']?(\d+)["']?/,
          },
          // Pattern 4: Variable assignments (var hash = "...", var expires = ...)
          {
            name: 'variable assignment',
            hashRegex: /(?:var|let|const)\s+hash\s*=\s*["']([^"']+)["']/,
            expiresRegex: /(?:var|let|const)\s+expires\s*=\s*(\d+)/,
          },
        ];

        for (const pattern of patterns) {
          if (hash) break; // Already found tokens

          const hashMatch = pageHtml.match(pattern.hashRegex);
          const expiresMatch = pageHtml.match(pattern.expiresRegex);

          if (hashMatch && expiresMatch) {
            const foundHash = hashMatch[1];
            const foundExpires = expiresMatch[1];

            // Validate tokens before using them
            const expiryTime = parseInt(foundExpires, 10);
            const now = Math.floor(Date.now() / 1000);

            if (expiryTime > now) {
              hash = foundHash;
              expires = foundExpires;
              break;
            }
          }
        }

        if (!hash) {
          retryCount++;
          if (retryCount <= maxRetries) {
            // Wait a bit before retrying
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        }
      } catch (e: any) {
        retryCount++;
        if (retryCount <= maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  }

  const video = await getVideo(ctx, id, media, hash, expires);
  return video;
}

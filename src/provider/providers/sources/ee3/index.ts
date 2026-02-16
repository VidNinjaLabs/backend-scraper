/* eslint-disable no-console */
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { generateCodename } from '@/utils/codenames';
import { MovieScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

import { apiBaseUrl, password, username } from './common';

async function fetchMovie(ctx: MovieScrapeContext, ee3Auth: string): Promise<string | null> {
  // Authenticate and get token
  const authResp = await ctx.proxiedFetcher.full<{ token?: string }>(
    `${apiBaseUrl}/api/collections/users/auth-with-password?expand=lists_liked`,
    {
      method: 'POST',
      headers: {
        Origin: 'https://ee3.me',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        identity: username,
        password: ee3Auth,
      }),
    },
  );
  if (authResp.statusCode !== 200) {
    throw new Error(`EE3: Auth failed (${authResp.statusCode})`);
  }

  const jsonResponse = authResp.body;
  if (!jsonResponse?.token) {
    throw new Error(`No token in auth response: ${JSON.stringify(jsonResponse)}`);
  }

  const token = jsonResponse.token;
  ctx.progress(20);

  // Find movie by TMDB ID - use exact match (=) instead of fuzzy match (~)
  const movieUrl = `${apiBaseUrl}/api/collections/movies/records?page=1&perPage=48&filter=tmdb_data.id=${ctx.media.tmdbId}`;
  const movieResp = await ctx.proxiedFetcher.full<{
    items?: Array<{ video?: string; video_link?: string; id?: string; tmdb_id?: number }>;
  }>(movieUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'https://ee3.me',
    },
  });

  if (movieResp.statusCode === 404) {
    throw new NotFoundError(`EE3: Movie search endpoint returned 404`);
  }

  if (movieResp.statusCode !== 200) {
    throw new Error(`EE3: Movie search failed (${movieResp.statusCode})`);
  }

  const movieJsonResponse = movieResp.body;
  if (!movieJsonResponse?.items || movieJsonResponse.items.length === 0) {
    throw new NotFoundError(`No movie found for TMDB ID ${ctx.media.tmdbId}`);
  }

  const movieItem = movieJsonResponse.items[0];

  // Validate that the returned movie actually matches the requested TMDB ID
  if (movieItem.tmdb_id && movieItem.tmdb_id !== Number(ctx.media.tmdbId)) {
    throw new NotFoundError(`Movie mismatch: requested TMDB ${ctx.media.tmdbId} but got TMDB ${movieItem.tmdb_id}`);
  }

  // Check both video and video_link fields, and also check the id field
  const videoId = movieItem.video || movieItem.video_link || movieItem.id;

  if (!videoId || videoId.trim() === '') {
    throw new NotFoundError(
      `EE3: Movie found but no video ID available for "${ctx.media.title}" (TMDB: ${ctx.media.tmdbId})`,
    );
  }

  ctx.progress(40);

  // Get video key
  const keyResp = await ctx.proxiedFetcher.full<{ key?: string }>(`${apiBaseUrl}/video/${videoId}/key`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: 'https://ee3.me',
    },
  });

  if (keyResp.statusCode !== 200) {
    throw new Error(`EE3: Key fetch failed (${keyResp.statusCode})`);
  }

  const keyJsonResponse = keyResp.body;
  if (!keyJsonResponse?.key) {
    throw new Error(`No key in response: ${JSON.stringify(keyJsonResponse)}`);
  }

  ctx.progress(60);
  return `${videoId}?k=${keyJsonResponse.key}`;
}

async function comboScraper(ctx: MovieScrapeContext): Promise<SourcererOutput> {
  const movData = await fetchMovie(ctx, password);
  if (!movData) {
    throw new NotFoundError('No watchable item found');
  }

  ctx.progress(80);

  const videoUrl = `${apiBaseUrl}/video/${movData}`;

  return {
    embeds: [],
    stream: [
      {
        id: 'borg',
        displayName: generateCodename(0),
        type: 'file',
        qualities: {
          unknown: {
            type: 'mp4',
            url: videoUrl,
          },
        },
        headers: {
          Origin: 'https://ee3.me',
        },
        flags: [],
        captions: [],
      },
    ],
  };
}

export const ee3Scraper = makeSourcerer({
  id: 'ee3',
  name: 'Vector',
  rank: 188,
  disabled: false, // Re-enabled (was disabled due to .mp4 and cloudflare compatibility)
  flags: [],
  scrapeMovie: comboScraper,
});

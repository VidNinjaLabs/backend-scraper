/* eslint-disable no-promise-executor-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-console */
import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { generateCodename } from '@/utils/codenames';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const SHOWBOX_API_BASE = 'https://feb-api.vidninja.pro/api/media';
const API_KEY = '6c0a40d6-bde5-4eaa-a18a-b56220cdbb2c';

// Working headers for ShowBox API
const WORKING_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'en-GB,en-US;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br, zstd',
  'Content-Type': 'application/json',
};

function processLink(link: any, streams: any[]) {
  if (!link.url) return;

  const qualityStr = link.quality || 'Unknown';
  const streamId = `showbox-${Math.random().toString(36).substring(2, 9)}`;

  // Use the raw quality string in the display name
  // generateCodename(0) returns 'Node' (or similar based on seed)
  const displayName = `${generateCodename(0)} ${qualityStr}`;

  streams.push({
    id: streamId,
    type: 'file',
    url: link.url, // For backup
    flags: [flags.CORS_ALLOWED],
    qualities: {
      unknown: {
        type: 'mp4',
        url: link.url,
      },
    },
    headers: {
      Referer: 'https://feb-api.vidninja.pro/',
      Origin: 'https://feb-api.vidninja.pro',
    },
    displayName,
  });

  console.log(`[ShowBox] Added stream: ${displayName}`);
}

// Process ShowBox API response
function processShowBoxResponse(data: any, _ctx: MovieScrapeContext | ShowScrapeContext): any[] {
  const streams: any[] = [];

  try {
    if (!data || !data.success) {
      console.log('[ShowBox] API returned unsuccessful response');
      return streams;
    }

    // Handle standard movie structure with versions
    if (data.versions && Array.isArray(data.versions)) {
      console.log(`[ShowBox] Processing ${data.versions.length} version(s)`);
      data.versions.forEach((version: any) => {
        if (version.links && Array.isArray(version.links)) {
          version.links.forEach((link: any) => processLink(link, streams));
        }
      });
    }
    // Handle TV show structure with file object
    else if (data.file && data.file.links && Array.isArray(data.file.links)) {
      console.log(`[ShowBox] Processing file links`);
      data.file.links.forEach((link: any) => processLink(link, streams));
    } else {
      console.log('[ShowBox] No versions or file links found in API response');
    }
  } catch (error: any) {
    console.error(`[ShowBox] Error processing response: ${error.message}`);
  }

  return streams;
}

// Main scraping function with retry logic
async function scrapeShowbox(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const { media } = ctx;

  // Build API URL based on media type
  let apiUrl: string;
  if (media.type === 'show') {
    apiUrl = `${SHOWBOX_API_BASE}/tv/${media.tmdbId}/${media.season.number}/${media.episode.number}?apiKey=${API_KEY}`;
  } else {
    apiUrl = `${SHOWBOX_API_BASE}/movie/${media.tmdbId}?apiKey=${API_KEY}`;
  }

  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ctx.fetcher<any>(apiUrl, {
        headers: WORKING_HEADERS,
      });

      // Process the response
      const streams = processShowBoxResponse(response, ctx);

      if (streams.length === 0) {
        throw new NotFoundError('No streams found');
      }

      streams.sort((a, b) => (b.displayName || '').localeCompare(a.displayName || ''));

      return {
        embeds: [],
        stream: streams,
      };
    } catch (error: any) {
      lastError = error;
      if (attempt < maxRetries) {
        // Wait 500ms before retrying (reduced for speed)
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }

  throw new NotFoundError(`ShowBox API failed: ${lastError?.message || 'Unknown error'}`);
}

export const showboxScraper = makeSourcerer({
  id: 'showbox',
  name: 'Box',
  rank: 190,
  flags: [flags.CORS_ALLOWED],
  disabled: true,
  scrapeMovie: scrapeShowbox,
  scrapeShow: scrapeShowbox,
});

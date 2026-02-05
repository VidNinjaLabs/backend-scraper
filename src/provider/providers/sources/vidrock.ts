import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

import { SourcererOutput, makeSourcerer } from '../base';

import CryptoJS from 'crypto-js';

const VIDROCK_BASE_URL = 'https://vidrock.net';
const PASSPHRASE = 'x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9';

// ... (retain headers)

const WORKING_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://vidrock.net/',
  Origin: 'https://vidrock.net',
};

const PLAYBACK_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  Referer: 'https://vidrock.net/',
  Origin: 'https://vidrock.net',
};

// AES-CBC Encryption using crypto-js
async function encryptAesCbc(text: string, passphrase: string): Promise<string> {
  try {
    const key = CryptoJS.enc.Utf8.parse(passphrase);
    const iv = CryptoJS.enc.Utf8.parse(passphrase.slice(0, 16));

    const encrypted = CryptoJS.AES.encrypt(text, key, {
      iv: iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7,
    });

    return encrypted.toString();
  } catch (error) {
    throw new NotFoundError(`Encryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

// Extract quality from URL
function extractQuality(url: string): string {
  if (!url) return 'Unknown';

  const qualityPatterns = [/(\d{3,4})p/i, /(\d{3,4})x\d{3,4}/i];

  for (const pattern of qualityPatterns) {
    const match = url.match(pattern);
    if (match) {
      const qualityNum = parseInt(match[1], 10);
      if (qualityNum >= 240 && qualityNum <= 4320) {
        return `${qualityNum}p`;
      }
    }
  }

  if (url.includes('1080') || url.includes('1920')) return '1080p';
  if (url.includes('720') || url.includes('1280')) return '720p';
  if (url.includes('480')) return '480p';
  if (url.includes('360')) return '360p';

  return 'Unknown';
}

// Process Vidrock API response
async function processVidrockResponse(
  data: any,
  fetcher: any,
): Promise<Array<{ id: string; url: string; quality: string; headers?: any }>> {
  const streams: Array<{ id: string; url: string; quality: string; headers?: any }> = [];

  if (!data || typeof data !== 'object') {
    return streams;
  }

  // Process each server
  for (const serverName of Object.keys(data)) {
    const source = data[serverName];

    // Skip if source is null or doesn't have a URL
    if (!source || !source.url || source.url === null) {
      continue;
    }

    const videoUrl = source.url;

    // Skip Atlas/Astra playlist processing - the MP4 URLs cause segment downloading issues
    // These URLs download segments instead of playing properly
    if ((serverName === 'Atlas' || serverName === 'Astra') && videoUrl.includes('cdn.vidrock.store/playlist/')) {
      continue; // Skip this server entirely
    }
    // Check if this is Atlas server (returns JSON playlist)
    // Note: API changed - Atlas now has the playlist URLs that Astra used to have
    if ((serverName === 'Atlas' || serverName === 'Astra') && videoUrl.includes('cdn.vidrock.store/playlist/')) {
      try {
        const playlistResponse = await fetcher.full(videoUrl, {
          headers: PLAYBACK_HEADERS,
        });

        const playlistData =
          typeof playlistResponse.body === 'string' ? JSON.parse(playlistResponse.body) : playlistResponse.body;

        if (Array.isArray(playlistData)) {
          const qualities: Record<string, { type: 'mp4'; url: string }> = {};

          playlistData.forEach((item: any) => {
            if (item.url && item.resolution) {
              const quality = `${item.resolution}p`;
              qualities[quality] = {
                type: 'mp4',
                url: item.url,
              };
            }
          });

          // Push single stream with all qualities
          if (Object.keys(qualities).length > 0) {
            streams.push({
              id: serverName.toLowerCase(),
              url: '', // Not used for file type
              quality: 'multi', // Multiple qualities
              qualities, // TypeScript: this field exists in final output
              headers: PLAYBACK_HEADERS,
            } as any);
          }
        }
      } catch (error: any) {
        // Silent fail for Astra parsing errors
      }

      continue; // Skip normal processing for Astra
    }

    // Normal processing for all other servers
    let quality = extractQuality(videoUrl);

    // Validate URL has a valid stream format
    const hasValidExtension =
      videoUrl.includes('.m3u8') ||
      videoUrl.includes('.mp4') ||
      videoUrl.includes('.mkv') ||
      videoUrl.includes('.mpd') ||
      videoUrl.includes('workers.dev'); // Worker URLs are valid (but will be filtered below)

    // Skip URLs without valid stream formats
    if (!hasValidExtension) {
      continue;
    }

    // Skip worker URLs and proxy.vidrock.store URLs - they cause timeout issues
    const isWorkerUrl = videoUrl.includes('workers.dev') || videoUrl.includes('storm.gemlelispe');
    const isProxyUrl = videoUrl.includes('proxy.vidrock.store');
    if (isWorkerUrl || isProxyUrl) {
      continue;
    }

    // Detect HLS streams
    const isHLS = source.type === 'hls' || videoUrl.includes('.m3u8');

    // Set quality to Adaptive for HLS streams if unknown
    if (quality === 'Unknown' && isHLS) {
      quality = 'Adaptive';
    }

    // All non-worker streams need headers
    streams.push({
      id: serverName.toLowerCase(),
      url: videoUrl,
      quality,
      headers: PLAYBACK_HEADERS,
    });
  }

  return streams;
}

async function comboScraper(ctx: ShowScrapeContext | MovieScrapeContext): Promise<SourcererOutput> {
  const mediaType = ctx.media.type === 'movie' ? 'movie' : 'tv';

  // Build item ID
  let itemId: string;
  if (ctx.media.type === 'show') {
    itemId = `${ctx.media.tmdbId}_${ctx.media.season.number}_${ctx.media.episode.number}`;
  } else {
    itemId = ctx.media.tmdbId;
  }

  ctx.progress(25);

  // Encrypt the item ID
  const encryptedId = await encryptAesCbc(itemId, PASSPHRASE);

  // Convert to URL-safe base64 (replace + with -, / with _, remove =)
  const urlSafeId = encryptedId.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  ctx.progress(50);

  // Build API URL (no need to URL-encode, it's already URL-safe)
  const apiUrl = `${VIDROCK_BASE_URL}/api/${mediaType}/${urlSafeId}`;

  // Fetch from Vidrock API
  // Use regular fetcher instead of proxied - the proxy might be causing issues
  const response = await ctx.fetcher(apiUrl, { headers: WORKING_HEADERS });

  // If response is a string, try to parse as JSON
  let parsedResponse = response;
  if (typeof response === 'string') {
    // Check if it's an HTML error page
    if (response.includes('<!DOCTYPE') || response.includes('<html')) {
      throw new NotFoundError('Vidrock API returned HTML error page');
    }

    // Try to parse as JSON
    try {
      parsedResponse = JSON.parse(response);
    } catch (e) {
      throw new NotFoundError(`Invalid JSON response from Vidrock: ${response.substring(0, 100)}`);
    }
  }

  if (!parsedResponse) {
    throw new NotFoundError('No response from Vidrock API');
  }

  ctx.progress(75);

  // Process response
  const streamData = await processVidrockResponse(parsedResponse, ctx.fetcher);

  if (streamData.length === 0) {
    throw new NotFoundError('No streams found');
  }

  ctx.progress(100);

  // Convert to output format
  const streams = streamData.map((stream: any) => {
    // Check if stream already has qualities (Astra multi-quality)
    if (stream.qualities) {
      return {
        id: stream.id,
        type: 'file' as const,
        qualities: stream.qualities,
        headers: stream.headers,
        flags: [],
        captions: [],
      };
    }

    // Worker URLs and .m3u8 files are HLS
    const isWorkerUrl = stream.url.includes('workers.dev') || stream.url.includes('storm.gemlelispe');
    const isHLS = stream.url.includes('.m3u8') || isWorkerUrl;

    if (isHLS) {
      return {
        id: stream.id,
        type: 'hls' as const,
        playlist: stream.url,
        headers: stream.headers,
        flags: [],
        captions: [],
      };
    }

    // Single MP4/MKV file
    return {
      id: stream.id,
      type: 'file' as const,
      qualities: {
        [stream.quality]: {
          type: 'mp4' as const,
          url: stream.url,
        },
      },
      headers: stream.headers,
      flags: [],
      captions: [],
    };
  });

  return {
    embeds: [],
    stream: streams,
  };
}

export const vidrockScraper = makeSourcerer({
  id: 'vidrock',
  name: 'Helix',
  rank: 250,
  disabled: true,
  flags: [],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});

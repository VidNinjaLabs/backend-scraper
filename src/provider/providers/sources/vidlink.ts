import { flags } from '@/entrypoint/utils/targets';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { HlsBasedStream, Qualities, StreamFile } from '@/providers/streams';
import { generateCodename } from '@/utils/codenames';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

// Vidlink API configuration
const ENC_DEC_API = 'https://enc-dec.app/api';
const VIDLINK_API = 'https://vidlink.pro/api/b';

// Required headers for Vidlink requests
const VIDLINK_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
  Referer: 'https://vidlink.pro/',
  Origin: 'https://vidlink.pro',
};

// Quality mapping to provider format
function mapQuality(qualityStr: string): Qualities {
  if (!qualityStr) return 'unknown';

  const quality = qualityStr.toLowerCase();

  if (quality.includes('2160') || quality.includes('4k')) return '4k';
  if (quality.includes('1080') || quality.includes('fhd')) return '1080';
  if (quality.includes('720') || quality.includes('hd')) return '720';
  if (quality.includes('480') || quality.includes('sd')) return '480';
  if (quality.includes('360')) return '360';

  // Try to extract number from string
  const match = qualityStr.match(/(\d{3,4})[pP]?/);
  if (match) {
    const resolution = parseInt(match[1], 10);
    if (resolution >= 2160) return '4k';
    if (resolution >= 1080) return '1080';
    if (resolution >= 720) return '720';
    if (resolution >= 480) return '480';
    if (resolution >= 360) return '360';
  }

  return 'unknown';
}

// Encrypt TMDB ID using enc-dec.app API
async function encryptTmdbId(tmdbId: string): Promise<string> {
  try {
    const response = await fetch(`${ENC_DEC_API}/enc-vidlink?text=${tmdbId}`);

    if (!response.ok) {
      throw new NotFoundError('Vidlink encryption service unavailable');
    }

    const data = (await response.json()) as { result?: string; error?: string };

    if (data.error) {
      throw new NotFoundError('Vidlink encryption failed');
    }

    if (data && data.result) {
      return data.result;
    }

    throw new NotFoundError('Invalid encryption response');
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError('Failed to encrypt TMDB ID for Vidlink');
  }
}

// Parse M3U8 content to extract quality streams
function parseM3U8(content: string, baseUrl: string): Array<{ resolution: string | null; url: string }> {
  const lines = content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line);
  const streams: Array<{ resolution: string | null; url: string }> = [];
  let currentStream: { resolution: string | null; url: string } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      currentStream = { resolution: null, url: '' };
      const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resolutionMatch) {
        currentStream.resolution = resolutionMatch[1];
      }
    } else if (currentStream && !line.startsWith('#')) {
      // Resolve relative URL
      if (line.startsWith('http')) {
        currentStream.url = line;
      } else {
        try {
          currentStream.url = new URL(line, baseUrl).toString();
        } catch {
          currentStream.url = line;
        }
      }
      streams.push(currentStream);
      currentStream = null;
    }
  }

  return streams;
}

// Get quality from resolution string (e.g., "1920x1080")
function getQualityFromResolution(resolution: string | null): Qualities {
  if (!resolution) return 'unknown';

  const [, height] = resolution.split('x').map(Number);

  if (height >= 2160) return '4k';
  if (height >= 1080) return '1080';
  if (height >= 720) return '720';
  if (height >= 480) return '480';
  if (height >= 360) return '360';
  return 'unknown';
}

// Vidlink API response types
interface VidlinkStreamData {
  id?: string;
  type?: string;
  playlist?: string;
  qualities?: Record<string, { url: string }>;
  flags?: string[];
  TTL?: number;
}

interface VidlinkResponse {
  sourceId?: string;
  stream?: VidlinkStreamData;
  url?: string;
  streams?: Array<{ url: string; quality?: string }>;
  links?: Array<{ url: string; quality?: string }>;
  error?: string;
}

// Fix incorrect domains in Vidlink URLs
function fixVidlinkUrl(url: string): string {
  if (!url) return url;
  return url.replace('stormvv.vodvidl.site', 'storm.vodvidl.site');
}

async function processVidlinkResponse(
  data: VidlinkResponse,
  ctx: MovieScrapeContext | ShowScrapeContext,
): Promise<SourcererOutput> {
  // Check for API error response
  if (data.error) {
    throw new NotFoundError(`Vidlink API error: ${data.error}`);
  }

  const hlsStreams: HlsBasedStream[] = [];
  const fileQualities: Partial<Record<Qualities, StreamFile>> = {};

  // Handle when stream.type is 'hls' - parse M3U8 for quality variants
  if (data.stream && data.stream.type === 'hls' && data.stream.playlist) {
    const playlistUrl = fixVidlinkUrl(data.stream.playlist);
    try {
      // Fetch and parse M3U8 to get individual quality streams
      const m3u8Response = await ctx.proxiedFetcher<string>(playlistUrl, {
        headers: VIDLINK_HEADERS,
      });

      const parsedStreams = parseM3U8(m3u8Response, playlistUrl);

      if (parsedStreams.length > 0) {
        // Add each quality as a separate HLS stream with proper codenames
        parsedStreams.forEach((stream, index) => {
          const quality = getQualityFromResolution(stream.resolution);
          hlsStreams.push({
            id: `vidlink-${quality}-${index}`,
            displayName: generateCodename(index),
            type: 'hls',
            playlist: fixVidlinkUrl(stream.url),
            flags: [flags.CORS_ALLOWED],
            captions: [],
            headers: VIDLINK_HEADERS,
          });
        });
      } else {
        // No variants found, return master playlist
        hlsStreams.push({
          id: 'vidlink-primary',
          displayName: generateCodename(0),
          type: 'hls',
          playlist: playlistUrl,
          flags: [flags.CORS_ALLOWED],
          captions: [],
          headers: VIDLINK_HEADERS,
        });
      }
    } catch {
      // Fallback: return master playlist directly on parsing failure
      hlsStreams.push({
        id: 'vidlink-primary',
        displayName: generateCodename(0),
        type: 'hls',
        playlist: playlistUrl,
        flags: [flags.CORS_ALLOWED],
        captions: [],
        headers: VIDLINK_HEADERS,
      });
    }
  }
  // Handle Vidlink's response format with stream.qualities
  else if (data.stream && data.stream.qualities) {
    Object.entries(data.stream.qualities).forEach(([qualityKey, qualityData]) => {
      if (qualityData.url) {
        const quality = mapQuality(qualityKey);
        fileQualities[quality] = {
          type: 'mp4',
          url: fixVidlinkUrl(qualityData.url),
        };
      }
    });
  }
  // Handle single URL response
  else if (data.url) {
    fileQualities.unknown = {
      type: 'mp4',
      url: fixVidlinkUrl(data.url),
    };
  }
  // Handle streams array
  else if (data.streams && Array.isArray(data.streams)) {
    data.streams.forEach((stream) => {
      if (stream.url) {
        const quality = mapQuality(stream.quality || 'unknown');
        fileQualities[quality] = {
          type: 'mp4',
          url: fixVidlinkUrl(stream.url),
        };
      }
    });
  }
  // Handle links array
  else if (data.links && Array.isArray(data.links)) {
    data.links.forEach((link) => {
      if (link.url) {
        const quality = mapQuality(link.quality || 'unknown');
        fileQualities[quality] = {
          type: 'mp4',
          url: fixVidlinkUrl(link.url),
        };
      }
    });
  }

  // Build output
  const streams: SourcererOutput['stream'] = [];

  // Add file-based stream if we have qualities
  if (Object.keys(fileQualities).length > 0) {
    streams.push({
      id: 'vidlink-file',
      displayName: generateCodename(0),
      type: 'file',
      flags: [flags.CORS_ALLOWED],
      captions: [],
      qualities: fileQualities,
      headers: VIDLINK_HEADERS,
    });
  }

  // Add HLS streams
  streams.push(...hlsStreams);

  if (streams.length === 0) {
    throw new NotFoundError('No streams found');
  }

  return {
    embeds: [],
    stream: streams,
  };
}

// Main scraping function
async function scrapeVidlink(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const { media } = ctx;
  const mediaType = media.type;

  // Encrypt TMDB ID
  const encryptedId = await encryptTmdbId(media.tmdbId);

  // Build Vidlink API URL
  let vidlinkUrl: string;
  if (mediaType === 'show') {
    vidlinkUrl = `${VIDLINK_API}/tv/${encryptedId}/${media.season.number}/${media.episode.number}`;
  } else {
    vidlinkUrl = `${VIDLINK_API}/movie/${encryptedId}`;
  }

  // Fetch stream data from Vidlink
  let rawResponse: string | VidlinkResponse;
  try {
    rawResponse = await ctx.proxiedFetcher<string | VidlinkResponse>(vidlinkUrl, {
      headers: VIDLINK_HEADERS,
    });
  } catch (error: any) {
    console.error(`[Vidlink] Request failed: ${error.message}`);
    throw new NotFoundError('Vidlink API request failed');
  }

  // Parse response if it's a string (API returns stringified JSON)
  let response: VidlinkResponse;
  if (typeof rawResponse === 'string') {
    try {
      response = JSON.parse(rawResponse) as VidlinkResponse;
    } catch {
      throw new NotFoundError('Invalid Vidlink API response');
    }
  } else {
    response = rawResponse;
  }

  // Validate response has stream data
  if (!response || (!response.stream && !response.url && !response.streams && !response.links)) {
    throw new NotFoundError('No stream data in Vidlink response');
  }

  // Process the response
  return processVidlinkResponse(response, ctx);
}

export const vidlinkScraper = makeSourcerer({
  id: 'vidlink',
  name: 'Storm',
  rank: 100,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: scrapeVidlink,
  scrapeShow: scrapeVidlink,
});

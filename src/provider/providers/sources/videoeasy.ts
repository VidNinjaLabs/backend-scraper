/* eslint-disable @typescript-eslint/no-shadow */
/* eslint-disable no-promise-executor-return */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable no-console */
/* eslint-disable radix */
import { flags } from '@/entrypoint/utils/targets';
import { UseableFetcher } from '@/fetchers/types';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { Qualities } from '@/providers/streams';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const VIDEASY_API = 'https://enc-dec.app/api';

interface VideoEasyServer {
  url: string;
  language: string;
  moviesOnly?: boolean;
  params?: Record<string, string>;
}

// VideoEasy server configurations
const SERVERS: Record<string, VideoEasyServer> = {
  Neon: {
    url: 'https://api.videasy.net/myflixerzupcloud/sources-with-title',
    language: 'Original',
  },
  Sage: {
    url: 'https://api.videasy.net/1movies/sources-with-title',
    language: 'Original',
  },
  Cypher: {
    url: 'https://api.videasy.net/moviebox/sources-with-title',
    language: 'Original',
  },
  Yoru: {
    url: 'https://api.videasy.net/cdn/sources-with-title',
    language: 'Original',
    moviesOnly: true,
  },
  Reyna: {
    url: 'https://api2.videasy.net/primewire/sources-with-title',
    language: 'Original',
  },
  Omen: {
    url: 'https://api.videasy.net/onionplay/sources-with-title',
    language: 'Original',
  },
  Breach: {
    url: 'https://api.videasy.net/m4uhd/sources-with-title',
    language: 'Original',
  },
  Vyse: {
    url: 'https://api.videasy.net/hdmovie/sources-with-title',
    language: 'Original',
  },
};
interface VideoEasySource {
  url: string;
  quality?: string;
  language?: string;
}

interface VideoEasyResult {
  sources?: VideoEasySource[];
  subtitles?: any[];
}

function buildVideoEasyUrl(
  serverConfig: VideoEasyServer,
  mediaType: string,
  title: string,
  year: string,
  tmdbId: string,
  imdbId: string,
  seasonId?: number,
  episodeId?: number,
): string {
  const params: Record<string, string> = {
    title,
    mediaType,
    year,
    tmdbId,
    imdbId,
  };

  // Add server-specific parameters
  if (serverConfig.params) {
    Object.assign(params, serverConfig.params);
  }

  // Add TV show specific parameters
  if (mediaType === 'tv' && seasonId && episodeId) {
    params.seasonId = seasonId.toString();
    params.episodeId = episodeId.toString();
  }

  const queryString = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');

  return `${serverConfig.url}?${queryString}`;
}

async function decryptVideoEasy(
  encryptedText: string,
  tmdbId: string,
  fetcher: UseableFetcher,
): Promise<VideoEasyResult> {
  try {
    // Use direct fetch with timeout to avoid hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

    const response = await fetch(`${VIDEASY_API}/dec-videasy`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text: encryptedText, id: tmdbId }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return { sources: [] };
    }

    const data = await response.json();

    // Check for error response
    if (data && typeof data === 'object' && 'error' in data) {
      return { sources: [] };
    }

    if (data && typeof data === 'object') {
      if ('result' in data && data.result) {
        return data.result;
      }
      if ('sources' in data) {
        return data as VideoEasyResult;
      }
    }

    return { sources: [] };
  } catch (error: any) {
    return { sources: [] };
  }
}

function extractQualityFromUrl(url: string): string {
  const qualityPatterns = [/(\d{3,4})p/i, /(\d{3,4})k/i, /quality[_-]?(\d{3,4})/i, /res[_-]?(\d{3,4})/i];

  for (const pattern of qualityPatterns) {
    const match = url.match(pattern);
    if (match) {
      const qualityNum = parseInt(match[1], 10);
      if (qualityNum >= 240 && qualityNum <= 4320) {
        return `${qualityNum}p`;
      }
    }
  }

  // Check for base64 encoded qualities (common in Neon/VideoEasy)
  if (url.includes('MTA4MA')) return '1080p';
  if (url.includes('NzIw')) return '720p';
  if (url.includes('NDgw')) return '480p';
  if (url.includes('MzYw')) return '360p';
  if (url.includes('MjE2MA')) return '4k';

  // Additional quality detection
  if (url.includes('1080') || url.includes('1920')) return '1080p';
  if (url.includes('720') || url.includes('1280')) return '720p';
  if (url.includes('480') || url.includes('854')) return '480p';
  if (url.includes('360') || url.includes('640')) return '360p';

  return 'unknown';
}

async function fetchFromServer(
  serverName: string,
  serverConfig: VideoEasyServer,
  title: string,
  year: string,
  mediaType: 'movie' | 'tv',
  tmdbId: string,
  imdbId: string,
  fetcher: UseableFetcher,
  seasonId?: number,
  episodeId?: number,
): Promise<SourcererOutput> {
  // Skip movie-only servers for TV shows
  if (mediaType === 'tv' && serverConfig.moviesOnly) {
    return { embeds: [], stream: [] };
  }

  const url = buildVideoEasyUrl(serverConfig, mediaType, title, year, tmdbId, imdbId, seasonId, episodeId);

  try {
    const encryptedData = await fetcher(url, {
      method: 'GET',
    });

    if (!encryptedData || typeof encryptedData !== 'string' || encryptedData.trim() === '') {
      return { embeds: [], stream: [] };
    }

    const decryptedData = await decryptVideoEasy(encryptedData, tmdbId, fetcher);

    if (!decryptedData || !decryptedData.sources || decryptedData.sources.length === 0) {
      return { embeds: [], stream: [] };
    }

    const streams = decryptedData.sources
      .filter((source) => source.url)
      // Filter: Only keep Cloudflare Worker URLs that can stream through our proxy
      // These URLs are already proxied and will work correctly
      .filter((source) => {
        const sourceUrl = source.url.toLowerCase();
        const isWorkerUrl = sourceUrl.includes('.workers.dev');

        // Skip "Direct" quality URLs from main-mp4.ronaldburker.workers.dev
        const isDirectUrl = sourceUrl.includes('main-mp4.ronaldburker.workers.dev');
        if (isDirectUrl) {
          return false;
        }

        // Keep other worker URLs
        if (isWorkerUrl) {
          return true;
        }

        // Skip non-worker URLs

        return false;
      })
      .map((source) => {
        let quality = source.quality || extractQualityFromUrl(source.url);

        // Clean up quality values
        if (quality === 'unknown' && source.url.includes('.m3u8')) {
          quality = 'auto';
        }

        // Determine stream type
        const isHLS = source.url.includes('.m3u8');

        // Map quality string to Qualities type
        const mapQuality = (q: string): Qualities => {
          if (q === '360' || q === '360p') return '360';
          if (q === '480' || q === '480p') return '480';
          if (q === '720' || q === '720p') return '720';
          if (q === '1080' || q === '1080p') return '1080';
          if (q === '4k' || q === '2160' || q === '2160p') return '4k';
          return 'unknown';
        };

        if (isHLS) {
          return {
            id: `Blade-${serverName}-${quality !== 'unknown' && quality !== 'auto' ? quality : 'Auto'}`,
            type: 'hls' as const,
            playlist: source.url,
            flags: [],
            captions: [],
            headers: {
              Referer: 'https://videasy.net/',
            },
          };
        }

        // File-based stream
        const qualityKey = mapQuality(quality);
        return {
          id: `Blade-${serverName}-${quality}`,
          type: 'file' as const,
          flags: [],
          captions: [],
          qualities: {
            [qualityKey]: {
              type: 'mp4' as const,
              url: source.url,
            },
          },
          headers: {
            Referer: 'https://videasy.net/',
          },
        };
      });

    return {
      embeds: [],
      stream: streams,
    };
  } catch (error: any) {
    // Silently skip servers that return errors (they might be down)
    return { embeds: [], stream: [] };
  }
}

async function comboScraper(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const { media, fetcher } = ctx;
  const tmdbId = media.tmdbId;
  const mediaType = media.type === 'show' ? 'tv' : 'movie';
  const title = media.title;
  const year = media.releaseYear.toString();
  const imdbId = media.imdbId || `tt${tmdbId}`;

  // Determine season and episode for TV shows
  const seasonId = media.type === 'show' ? media.season.number : undefined;
  const episodeId = media.type === 'show' ? media.episode.number : undefined;

  // Timeout wrapper for each server fetch
  const fetchWithTimeout = async (serverName: string, serverConfig: VideoEasyServer): Promise<SourcererOutput> => {
    return Promise.race([
      (async () => {
        const result = await fetchFromServer(
          serverName,
          serverConfig,
          title,
          year,
          mediaType,
          tmdbId,
          imdbId,
          fetcher,
          seasonId,
          episodeId,
        );
        return result;
      })(),
      new Promise<SourcererOutput>((_, reject) => setTimeout(() => reject(new Error(`${serverName} timeout`)), 15000)),
    ]).catch((err) => {
      return { embeds: [], stream: [] };
    });
  };

  // Fetch from all servers in parallel with timeout
  const serverPromises = Object.entries(SERVERS).map(([serverName, serverConfig]) =>
    fetchWithTimeout(serverName, serverConfig),
  );

  const results = await Promise.all(serverPromises);

  // Combine all streams
  const allStreams = results.flatMap((result) => result.stream || []);

  if (allStreams.length === 0) {
    throw new NotFoundError('No streams found');
  }

  // Remove duplicates by playlist/qualities
  const uniqueStreams = allStreams.filter((stream, index, self) => {
    return (
      index ===
      self.findIndex((s) => {
        if (s.type === 'hls' && stream.type === 'hls') {
          return s.playlist === stream.playlist;
        }
        if (s.type === 'file' && stream.type === 'file') {
          // Compare first quality URL
          const sUrl = Object.values(s.qualities)[0]?.url;
          const streamUrl = Object.values(stream.qualities)[0]?.url;
          return sUrl === streamUrl;
        }
        return false;
      })
    );
  });

  return {
    embeds: [],
    stream: uniqueStreams,
  };
}

export const videoeasyScraper = makeSourcerer({
  id: 'videoeasy',
  name: 'Blade',
  rank: 200,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper,
});

import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

// ShowBox API Configuration
const SHOWBOX_API_BASE = 'https://febapi.nuvioapp.space/api/media';

// TODO: This should come from user settings/environment
// For now, users need to set this environment variable
const UI_TOKEN = process.env.SHOWBOX_UI_TOKEN || '';

function getQualityFromName(qualityStr: string): string {
  if (!qualityStr) return 'Unknown';

  const quality = qualityStr.toUpperCase();

  // Map API quality values to normalized format
  if (quality === 'ORG' || quality === 'ORIGINAL') return 'Original';
  if (quality === '4K' || quality === '2160P') return '4K';
  if (quality === '1440P' || quality === '2K') return '1440p';
  if (quality === '1080P' || quality === 'FHD') return '1080p';
  if (quality === '720P' || quality === 'HD') return '720p';
  if (quality === '480P' || quality === 'SD') return '480p';
  if (quality === '360P') return '360p';
  if (quality === '240P') return '240p';

  // Try to extract number from string
  const match = qualityStr.match(/(\d{3,4})[pP]?/);
  if (match) {
    const resolution = parseInt(match[1], 10);
    if (resolution >= 2160) return '4K';
    if (resolution >= 1440) return '1440p';
    if (resolution >= 1080) return '1080p';
    if (resolution >= 720) return '720p';
    if (resolution >= 480) return '480p';
    if (resolution >= 360) return '360p';
    return '240p';
  }

  return 'Unknown';
}

function formatFileSize(sizeStr: string | number): string {
  if (!sizeStr) return 'Unknown';

  // If already formatted
  if (typeof sizeStr === 'string' && (sizeStr.includes('GB') || sizeStr.includes('MB') || sizeStr.includes('KB'))) {
    return sizeStr;
  }

  // If it's a number, convert to GB/MB
  if (typeof sizeStr === 'number') {
    const gb = sizeStr / (1024 * 1024 * 1024);
    if (gb >= 1) {
      return `${gb.toFixed(2)} GB`;
    }
    const mb = sizeStr / (1024 * 1024);
    return `${mb.toFixed(2)} MB`;
  }

  return String(sizeStr);
}

interface ShowBoxVersion {
  name?: string;
  size?: string | number;
  links?: Array<{
    url: string;
    quality?: string;
    size?: string | number;
    name?: string;
    speed?: string;
  }>;
}

interface ShowBoxResponse {
  success: boolean;
  versions?: ShowBoxVersion[];
}

async function showboxScrape(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  // Check if UI token is configured
  if (!UI_TOKEN) {
    throw new NotFoundError('ShowBox UI token not configured. Please set SHOWBOX_UI_TOKEN environment variable.');
  }

  const { tmdbId } = ctx.media;
  if (!tmdbId) {
    throw new NotFoundError('TMDB ID is required for ShowBox');
  }

  ctx.progress(10);

  // Build API URL based on media type
  let apiUrl: string;
  const isShow = ctx.media.type === 'show';

  if (isShow) {
    const showCtx = ctx as ShowScrapeContext;
    const season = showCtx.media.season?.number;
    const episode = showCtx.media.episode?.number;

    if (!season || !episode) {
      throw new NotFoundError('Season and episode required for TV shows');
    }

    // TV format: /api/media/tv/:tmdbId/:season/:episode?cookie=:cookie
    apiUrl = `${SHOWBOX_API_BASE}/tv/${tmdbId}/${season}/${episode}?cookie=${encodeURIComponent(UI_TOKEN)}`;
  } else {
    // Movie format: /api/media/movie/:tmdbId?cookie=:cookie
    apiUrl = `${SHOWBOX_API_BASE}/movie/${tmdbId}?cookie=${encodeURIComponent(UI_TOKEN)}`;
  }

  // console.log(`[ShowBox] Requesting: ${apiUrl}`);
  ctx.progress(30);

  // Make request to ShowBox API
  const response = await ctx.proxiedFetcher<ShowBoxResponse>(apiUrl, {
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
  });

  ctx.progress(60);

  if (!response || !response.success) {
    throw new NotFoundError('ShowBox API returned unsuccessful response');
  }

  if (!response.versions || !Array.isArray(response.versions) || response.versions.length === 0) {
    throw new NotFoundError('No versions found in ShowBox API response');
  }

  // console.log(`[ShowBox] Processing ${response.versions.length} version(s)`);

  // Build title for streams (unused for now but kept for future use)
  // const title = ctx.media.title;
  // const year = ctx.media.releaseYear;

  // Process all versions and links
  const allStreams: Array<{
    quality: string;
    url: string;
    size: string;
    versionIndex: number;
  }> = [];

  response.versions.forEach((version, versionIndex) => {
    const versionSize = version.size || 'Unknown';

    if (version.links && Array.isArray(version.links)) {
      version.links.forEach((link) => {
        if (!link.url) return;

        const normalizedQuality = getQualityFromName(link.quality || 'Unknown');
        const linkSize = link.size || versionSize;

        allStreams.push({
          quality: normalizedQuality,
          url: link.url,
          size: formatFileSize(linkSize),
          versionIndex: versionIndex + 1,
        });
      });
    }
  });

  if (allStreams.length === 0) {
    throw new NotFoundError('No streams found in ShowBox response');
  }

  ctx.progress(90);

  // Sort by quality (highest first)
  const qualityOrder: Record<string, number> = {
    Original: 6,
    '4K': 5,
    '1440p': 4,
    '1080p': 3,
    '720p': 2,
    '480p': 1,
    '360p': 0,
    '240p': -1,
    Unknown: -2,
  };

  allStreams.sort((a, b) => (qualityOrder[b.quality] || -2) - (qualityOrder[a.quality] || -2));

  // console.log(`[ShowBox] Found ${allStreams.length} streams`);

  // Return streams
  return {
    embeds: [],
    stream: allStreams.map((stream, index) => {
      // Build stream name
      let streamName = '📦 ShowBox';
      if (response.versions!.length > 1) {
        streamName += ` V${stream.versionIndex}`;
      }
      streamName += ` ${stream.quality}`;
      if (stream.size !== 'Unknown') {
        streamName += ` [${stream.size}]`;
      }

      return {
        id: `showbox-${index}`,
        name: streamName,
        type: 'hls' as const,
        playlist: stream.url,
        captions: [],
        flags: [],
      };
    }),
  };
}

export const showboxScraper = makeSourcerer({
  id: 'showbox',
  name: 'ShowBox',
  rank: 350,
  flags: [],
  disabled: false,
  scrapeMovie: showboxScrape,
  scrapeShow: showboxScrape,
});

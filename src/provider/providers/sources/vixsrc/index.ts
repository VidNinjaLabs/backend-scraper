/* eslint-disable no-console */
import type { ShowMedia } from '@/entrypoint/utils/media';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { generateCodename } from '@/utils/codenames';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

const BASE_URL = 'https://vixsrc.to';

async function vixsrcScrape(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const tmdbId = ctx.media.tmdbId;
  if (!tmdbId) throw new NotFoundError('TMDB ID not found');

  const isShow = ctx.media.type === 'show';
  let season: number | undefined;
  let episode: number | undefined;

  if (isShow) {
    const show = ctx.media as ShowMedia;
    season = show.season?.number;
    episode = show.episode?.number;
  }

  const vixsrcUrl = isShow ? `${BASE_URL}/tv/${tmdbId}/${season}/${episode}` : `${BASE_URL}/movie/${tmdbId}`;

  ctx.progress(10);

  // Fetch the Vixsrc page
  const html = await ctx.proxiedFetcher<string>(vixsrcUrl, {
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Referer: BASE_URL,
    },
  });

  ctx.progress(30);

  let masterPlaylistUrl: string | null = null;

  // Method 1: Look for window.masterPlaylist
  if (html.includes('window.masterPlaylist')) {
    const urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
    const tokenMatch = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
    const expiresMatch = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);

    if (urlMatch && tokenMatch && expiresMatch) {
      const baseUrl = urlMatch[1];
      const token = tokenMatch[1];
      const expires = expiresMatch[1];

      // Construct the master playlist URL
      if (baseUrl.includes('?b=1')) {
        masterPlaylistUrl = `${baseUrl}&token=${token}&expires=${expires}&h=1&lang=en`;
      } else {
        masterPlaylistUrl = `${baseUrl}?token=${token}&expires=${expires}&h=1&lang=en`;
      }
    }
  }

  // Method 2: Look for direct .m3u8 URLs
  if (!masterPlaylistUrl) {
    const m3u8Match = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
    if (m3u8Match) {
      masterPlaylistUrl = m3u8Match[1];
    }
  }

  // Method 3: Look for stream URLs in script tags
  if (!masterPlaylistUrl) {
    const scriptMatches = html.match(/<script[^>]*>(.*?)<\/script>/gs);
    if (scriptMatches) {
      for (const script of scriptMatches) {
        const streamMatch = script.match(/['"]?(https?:\/\/[^'"\s]+(?:\.m3u8|playlist)[^'"\s]*)/);
        if (streamMatch) {
          masterPlaylistUrl = streamMatch[1];
          break;
        }
      }
    }
  }

  if (!masterPlaylistUrl) {
    throw new NotFoundError('No master playlist URL found');
  }

  ctx.progress(70);

  // Parse Master Playlist to extract Subtitles (VTTs)
  const captions: any[] = [];
  try {
    const masterResponse = await ctx.proxiedFetcher<string>(masterPlaylistUrl, {
      headers: {
        Referer: BASE_URL,
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      },
    });

    // Helper to resolve relative URLs
    const resolveUrl = (relative: string, base: string) => {
      if (relative.startsWith('http')) return relative;
      const parent = base.substring(0, base.lastIndexOf('/') + 1);
      return new URL(relative, parent).toString();
    };

    // Regex for subtitles
    // #EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English",...,URI="..."
    const subtitleRegex = /#EXT-X-MEDIA:TYPE=SUBTITLES.*?NAME="([^"]+)".*?LANGUAGE="([^"]+)".*?URI="([^"]+)"/g;
    let match;

    const subtitleTasks = [];

    // Identify unique subtitles
    while ((match = subtitleRegex.exec(masterResponse)) !== null) {
      const name = match[1];
      const lang = match[2];
      const uri = resolveUrl(match[3], masterPlaylistUrl);

      subtitleTasks.push(
        (async () => {
          try {
            // Fetch the sub-playlist (Variant)
            const subManifest = await ctx.proxiedFetcher<string>(uri, {
              headers: { Referer: BASE_URL },
            });
            // Extract the .vtt URL (usually inside #EXTINF or just a line)
            // Look for .vtt
            const vttMatch =
              subManifest.match(/(https?:\/\/[^'"\s]+\.vtt[^'"\s]*)/) || subManifest.match(/([^\s]+\.vtt[^\s]*)/);
            if (vttMatch) {
              const vttUrl = resolveUrl(vttMatch[1], uri);
              captions.push({
                id: `vixsrc-${lang}-${name}`,
                language: lang,
                url: vttUrl,
                label: name,
                hasCorsRestrictions: false,
                type: 'vtt',
              });
            }
          } catch (e) {
            // console.warn(`Failed to resolve subtitle ${name}:`, e);
          }
        })(),
      );
    }

    // Limit concurrency if needed, but for ~25 items Promise.all is usually fine
    await Promise.all(subtitleTasks);

    console.log(`[VixSRC] Resolved ${captions.length} subtitles`);
  } catch (e) {
    console.error('[VixSRC] Error parsing master playlist:', e);
  }

  return {
    stream: [
      {
        id: 'vixsrc-0',
        displayName: generateCodename(0, 'Server'),
        type: 'hls',
        playlist: masterPlaylistUrl,
        headers: {
          Referer: BASE_URL,
          Origin: BASE_URL,
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        },
        proxyDepth: 2,
        flags: [],
        captions,
      },
    ],
    embeds: [],
  };
}

export const vixsrcScraper = makeSourcerer({
  id: 'vixsrc',
  name: 'Halo',
  rank: 350,
  disabled: false,
  flags: [],
  scrapeMovie: vixsrcScrape,
  scrapeShow: vixsrcScrape,
});

import { parse, stringify } from 'hls-parser';
import { MasterPlaylist, MediaPlaylist, Segment } from 'hls-parser/types';

import { UseableFetcher } from '@/fetchers/types';

/**
 * Resolve a relative URL against a base URL
 */
function resolveUrl(relativeUrl: string, baseUrl: string): string {
  if (relativeUrl.startsWith('http://') || relativeUrl.startsWith('https://')) {
    return relativeUrl;
  }

  // Use URL constructor to properly resolve relative paths
  return new URL(relativeUrl, baseUrl).toString();
}

/**
 * Fetch and process M3U8 playlist, converting all URLs to absolute
 * Returns the raw M3U8 text content (not a data URL)
 */
export async function fetchAndProcessM3U8(
  fetcher: UseableFetcher,
  playlistUrl: string,
  headers?: Record<string, string>,
): Promise<string> {
  const playlistData = await fetcher(playlistUrl, { headers });
  const playlist = parse(playlistData);

  if (playlist.isMasterPlaylist) {
    // Process master playlist: resolve variant URLs to absolute
    for (const variant of (playlist as MasterPlaylist).variants) {
      variant.uri = resolveUrl(variant.uri, playlistUrl);
    }
  } else {
    // Process media playlist: resolve segment URLs to absolute
    const mediaPlaylist = playlist as MediaPlaylist;
    if (mediaPlaylist.segments) {
      for (const segment of mediaPlaylist.segments as Segment[]) {
        segment.uri = resolveUrl(segment.uri, playlistUrl);
      }
    }
  }

  // Return the M3U8 text content with absolute URLs
  return stringify(playlist);
}

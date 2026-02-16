/* eslint-disable no-console */
import { MovieMedia, ShowMedia } from '@/entrypoint/utils/media';
import { Caption, labelToLanguageCode, removeDuplicatedLanguages } from '@/providers/captions';
import { ScrapeContext } from '@/utils/context';

import { StreamsDataResult } from './type';
import { baseUrl } from './util';

export async function getVideoSources(
  ctx: ScrapeContext,
  id: string,
  media: MovieMedia | ShowMedia,
  hash?: string | null,
  expires?: string | null,
): Promise<StreamsDataResult> {
  // Fetch video sources

  let path = '';
  let query: any = { expand: 'streams,subtitles', id };
  let fetcher = ctx.proxiedFetcher;
  let customBaseUrl = baseUrl;

  // Use official API if we have security tokens (TV Shows primarily)
  if (media.type === 'show' && hash && expires) {
    path = `/api/v1/security/episode-access`;
    query = { id_episode: id, hash, expires };
    customBaseUrl = 'https://www.lookmovie2.to';
    // Use browser fetcher if available to avoid CF blocks on official domain
    if (ctx.browserFetcher) fetcher = ctx.browserFetcher;
  } else if (media.type === 'show') {
    path = `/v1/episodes/view`;
  } else if (media.type === 'movie') {
    path = `/v1/movies/view`;
  }

  const data = await fetcher<StreamsDataResult>(path, {
    baseUrl: customBaseUrl,
    query,
  });

  return data;
}

export async function getVideo(
  ctx: ScrapeContext,
  id: string,
  media: MovieMedia | ShowMedia,
  hash?: string | null,
  expires?: string | null,
): Promise<{ playlist: string | null; captions: Caption[] }> {
  // Get sources
  const data = await getVideoSources(ctx, id, media, hash, expires);
  const videoSources = data.streams;

  // Check if streams exist
  if (!videoSources || typeof videoSources !== 'object') {
    return {
      playlist: null,
      captions: [],
    };
  }

  // Find video URL and return it
  const opts = ['auto', '1080p', '1080', '720p', '720', '480p', '480', '240p', '240', '360p', '360', '144', '144p'];

  let videoUrl: string | null = null;
  for (const res of opts) {
    if (videoSources[res] && !videoUrl) {
      videoUrl = videoSources[res];
    }
  }

  let captions: Caption[] = [];

  // Check if subtitles exist and is an array
  if (data.subtitles && Array.isArray(data.subtitles)) {
    for (const sub of data.subtitles) {
      const language = labelToLanguageCode(sub.language);
      if (!language) continue;
      captions.push({
        id: sub.url,
        type: 'vtt',
        url: `${baseUrl}${sub.url}`,
        hasCorsRestrictions: false,
        language,
      });
    }

    captions = removeDuplicatedLanguages(captions);
  }

  return {
    playlist: videoUrl,
    captions,
  };
}

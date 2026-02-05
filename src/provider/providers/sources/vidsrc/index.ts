/* eslint-disable no-console */
import type { ShowMedia } from '@/entrypoint/utils/media';
import { SourcererOutput, makeSourcerer } from '@/providers/base';
import { generateCodename } from '@/utils/codenames';
import { MovieScrapeContext, ShowScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';

import { decodeStreamUrl, extractDecoderParams } from './decoders';
import { extractScripts, fetchWithHeaders } from './http-fetcher';

async function vidsrcScrape(ctx: MovieScrapeContext | ShowScrapeContext): Promise<SourcererOutput> {
  const { imdbId, tmdbId } = ctx.media;

  if (!imdbId && !tmdbId) throw new NotFoundError('No ID found');

  const isShow = ctx.media.type === 'show';
  let season: number | undefined;
  let episode: number | undefined;

  if (isShow) {
    const show = ctx.media as ShowMedia;
    season = show.season?.number;
    episode = show.episode?.number;
  }

  let embedUrl = '';

  if (isShow) {
    embedUrl = imdbId
      ? `https://vidsrc-embed.ru/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}`
      : `https://vidsrc-embed.ru/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
  } else {
    embedUrl = imdbId
      ? `https://vidsrc-embed.ru/embed/${imdbId}`
      : `https://vidsrc-embed.ru/embed/movie?tmdb=${tmdbId}`;
  }

  ctx.progress(10);

  const embedHtml = await ctx.proxiedFetcher<string>(embedUrl, {
    headers: {
      Referer: 'https://vidsrc-embed.ru/',
      'User-Agent': 'Mozilla/5.0',
    },
  });

  ctx.progress(30);

  // Extract the iframe source using regex
  const iframeMatch = embedHtml.match(/<iframe[^>]*id="player_iframe"[^>]*src="([^"]*)"[^>]*>/);
  if (!iframeMatch) throw new NotFoundError('Initial iframe not found');

  const rcpUrl = iframeMatch[1].startsWith('//') ? `https:${iframeMatch[1]}` : iframeMatch[1];

  ctx.progress(50);

  // Use lightweight HTTP fetcher
  const rcpHtml = await fetchWithHeaders(rcpUrl, {
    referer: embedUrl,
    retries: 3,
    delay: 3000,
  });

  // Find the /prorcp/ URL from the JavaScript function
  const scriptMatch = rcpHtml.match(/src:\s+'(\/prorcp\/[^']+)'/);

  if (!scriptMatch) {
    // Try to extract m3u8 URL directly from the rcp page
    const directM3u8Match = rcpHtml.match(/file\s*:\s*['"]([^'"]*\.m3u8[^'"]*)['"]/);
    if (!directM3u8Match) {
      throw new NotFoundError('Could not find prorcp iframe or direct m3u8 URL - Cloudflare may be blocking');
    }

    const streamUrl = directM3u8Match[1];

    // Stream URL should be usable as-is

    return {
      stream: [
        {
          id: 'vidsrc-cloudnestra-0',
          displayName: generateCodename(0, 'Server'),
          type: 'hls',
          playlist: streamUrl,
          headers: {
            Referer: 'https://cloudnestra.com/',
            Origin: 'https://cloudnestra.com',
          },
          proxyDepth: 2,
          flags: [],
          captions: [],
        },
      ],
      embeds: [],
    };
  }

  // Found prorcp URL, fetch it to get the final player page
  const prorcpUrl = `https://cloudnestra.com${scriptMatch[1]}`;

  ctx.progress(70);

  const finalHtml = await fetchWithHeaders(prorcpUrl, {
    referer: rcpUrl,
    retries: 3,
    delay: 2000,
  });

  // Find script containing Playerjs
  const scripts = extractScripts(finalHtml);
  let scriptWithPlayer = '';

  for (const script of scripts) {
    if (script.includes('Playerjs')) {
      scriptWithPlayer = script;
      break;
    }
  }

  if (!scriptWithPlayer) {
    throw new NotFoundError('No Playerjs config found');
  }

  let streamUrl = '';

  // Try to find file: "url" pattern first (old format)
  const m3u8Match = scriptWithPlayer.match(/file\s*:\s*['"]([^'"]+)['"]/);

  if (!m3u8Match) {
    // New format: file: variableName (references a hidden div)
    const fileVarMatch = scriptWithPlayer.match(/file\s*:\s*([a-zA-Z0-9_]+)\s*[,}]/);

    if (fileVarMatch) {
      const varName = fileVarMatch[1];

      // Find the div with this ID that contains the encoded data
      const divMatch = finalHtml.match(new RegExp(`<div id="${varName}"[^>]*>\\s*([^<]+)\\s*</div>`, 's'));

      if (divMatch) {
        // Extract and decode the value
        // Since we can't execute JS, try to decode it manually
        const encodedData = divMatch[1].trim();

        // Try to decode - this is a simple base64 check
        try {
          streamUrl = Buffer.from(encodedData, 'base64').toString('utf-8');
        } catch (e) {
          streamUrl = encodedData; // Use as-is if decode fails
        }
      } else {
        throw new NotFoundError('No file data found in referenced div');
      }
    } else {
      throw new NotFoundError('No file field in Playerjs');
    }
  } else {
    streamUrl = m3u8Match[1];
  }

  // Extract decoder params from HTML
  const decoderParams = extractDecoderParams(finalHtml);

  if (decoderParams) {
    // Found decoder params, use the proper decoder
    const decoded = decodeStreamUrl(decoderParams.id, decoderParams.content);

    if (decoded && (decoded.includes('http') || decoded.includes('.m3u8'))) {
      streamUrl = decoded;
    }
  }

  // If streamUrl still doesn't look like a URL, it needs decoding but we couldn't decode it
  if (!streamUrl.includes('.m3u8') && !streamUrl.startsWith('http')) {
    throw new NotFoundError('Could not decode stream URL - decoder params not found or invalid');
  }

  // Post-processing for specific placeholders
  const rawUrls = streamUrl.split(' or ');
  const streams: any[] = [];

  // Extract domain values from HTML (since we can't execute JS)
  const domainMap: Record<string, string> = {};

  // Look for v1, v2, v3, v4 variable assignments in scripts
  for (const script of scripts) {
    const v1Match = script.match(/v1\s*=\s*['"]([^'"]+)['"]/);
    const v2Match = script.match(/v2\s*=\s*['"]([^'"]+)['"]/);
    const v3Match = script.match(/v3\s*=\s*['"]([^'"]+)['"]/);
    const v4Match = script.match(/v4\s*=\s*['"]([^'"]+)['"]/);

    if (v1Match) domainMap.v1 = v1Match[1];
    if (v2Match) domainMap.v2 = v2Match[1];
    if (v3Match) domainMap.v3 = v3Match[1];
    if (v4Match) domainMap.v4 = v4Match[1];
  }

  // Hardcoded fallback for v1 if not found
  if (!domainMap.v1) domainMap.v1 = 'shadowlandschronicles.com';

  const headers = {
    referer: 'https://cloudnestra.com/',
    origin: 'https://cloudnestra.com',
  };

  for (let url of rawUrls) {
    url = url.trim();

    // Replace placeholders
    for (const [key, value] of Object.entries(domainMap)) {
      if (url.includes(`{${key}}`)) {
        url = url.replace(new RegExp(`{${key}}`, 'g'), value);
      }
    }

    // Fix subdomain if needed (tmstr5 -> tmstr2)
    if (url.includes('tmstr5')) {
      url = url.replace(/tmstr5/g, 'tmstr2');
    }

    // If URL still has placeholders, skip it
    if (url.match(/{v\d+}/)) {
      continue;
    }

    // Validate URL is accessible (quick HEAD check)
    try {
      const response = await fetch(url, {
        method: 'HEAD',
        headers: {
          referer: 'https://cloudnestra.com/',
          origin: 'https://cloudnestra.com',
        },
      });
      if (!response.ok) {
        continue;
      }
    } catch {
      continue;
    }

    streams.push({
      id: `vidsrc-cloudnestra-${streams.length}`,
      displayName: generateCodename(streams.length, 'Server'),
      type: 'hls',
      playlist: url,
      headers,
      proxyDepth: 2,
      flags: [],
      captions: [],
    });
  }

  ctx.progress(90);

  if (streams.length === 0) {
    throw new NotFoundError('No valid streams found');
  }

  return {
    stream: streams,
    embeds: [],
  };
}

export const vidsrcScraper = makeSourcerer({
  id: 'cloudnestra',
  name: 'Shadow',
  rank: 400,
  disabled: false,
  flags: [],
  scrapeMovie: vidsrcScrape,
  scrapeShow: vidsrcScrape,
});

// thanks Mirzya for this scraper - refactored by @rev9

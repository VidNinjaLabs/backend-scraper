/* eslint-disable import/no-extraneous-dependencies */
/**
 * Subtitle fetching using wyzie-lib
 * Automatically fetches subtitles for movies and TV shows
 */

import { type SubtitleData, parseToVTT, searchSubtitles } from 'wyzie-lib';

import { getNativeLanguageName } from './languageNames';

export interface SubtitleOptions {
  tmdbId?: string;
  imdbId?: string;
  season?: number;
  episode?: number;
  language?: string;
  format?: 'srt' | 'txt' | 'sub' | 'ssa' | 'ass';
  encoding?: string;
  hearingImpaired?: boolean;
  source?: string;
}

export interface Subtitle {
  id: string;
  language: string;
  languageName: string; // Human-readable name (e.g., "English", "Spanish")
  url: string;
  format: string;
  source?: string | string[]; // Can be string or array
  hearingImpaired: boolean;
  vttUrl?: string; // Will be added if converting to VTT
}

/**
 * Fetch subtitles for media using wyzie-lib
 */
export async function fetchSubtitles(options: SubtitleOptions): Promise<Subtitle[]> {
  try {
    const {
      tmdbId,
      imdbId,
      season,
      episode,
      language, // Don't use as filter, just for fallback
      format = 'srt',
      encoding,
      hearingImpaired,
      source,
    } = options;

    // Build search params (proper typing for wyzie-lib)
    const searchParams: any = {
      format,
    };

    // Add TMDB or IMDB ID
    if (tmdbId) {
      searchParams.tmdb_id = parseInt(tmdbId, 10);
    } else if (imdbId) {
      searchParams.imdb_id = imdbId;
    } else {
      console.warn('[Subtitles] No TMDB or IMDB ID provided');
      return [];
    }

    // Add optional params (but NOT language - we want ALL languages!)
    if (season !== undefined) searchParams.season = season;
    if (episode !== undefined) searchParams.episode = episode;
    // DON'T add language filter - we want all languages
    if (encoding) searchParams.encoding = encoding;
    if (hearingImpaired !== undefined) searchParams.hi = hearingImpaired;
    if (source) searchParams.source = source;

    // Fetch subtitles
    const data: SubtitleData[] = await searchSubtitles(searchParams);

    // Map to our Subtitle format
    const allSubtitles: Subtitle[] = data.map((sub) => {
      const langCode = sub.language || language || 'en';
      // Always use our native language mapper (wyzie returns English names)
      const langName = getNativeLanguageName(langCode);

      return {
        id: sub.id,
        language: langCode,
        languageName: langName,
        url: sub.url,
        format: sub.format || format,
        source: sub.source, // Can be string or array
        hearingImpaired: sub.isHearingImpaired || false,
      };
    });

    // Deduplicate by language - keep only ONE subtitle per language
    // Prefer non-hearing-impaired, then by source preference
    const uniqueByLanguage = new Map<string, Subtitle>();

    allSubtitles.forEach((sub) => {
      const existing = uniqueByLanguage.get(sub.language);

      if (!existing) {
        // No subtitle for this language yet, add it
        uniqueByLanguage.set(sub.language, sub);
      } else if (existing.hearingImpaired && !sub.hearingImpaired) {
        // Prefer non-hearing-impaired
        uniqueByLanguage.set(sub.language, sub);
      } else if (existing.hearingImpaired === sub.hearingImpaired) {
        // If both are same HI status, prefer opensubtitles source
        const subSource = Array.isArray(sub.source) ? sub.source[0] : sub.source;
        if (subSource === 'opensubtitles') {
          uniqueByLanguage.set(sub.language, sub);
        }
      }
    });

    // Convert map to array and sort alphabetically by language name
    const uniqueSubtitles = Array.from(uniqueByLanguage.values()).sort((a, b) =>
      a.languageName.localeCompare(b.languageName),
    );

    return uniqueSubtitles;
  } catch (error) {
    console.warn('[Subtitles] Failed to fetch:', error instanceof Error ? error.message : error);
    return []; // Return empty array on error (non-blocking)
  }
}

/**
 * Convert subtitle to VTT format
 */
export async function convertToVTT(subtitleUrl: string): Promise<string> {
  try {
    const vttContent = await parseToVTT(subtitleUrl);
    return vttContent;
  } catch (error) {
    console.warn('[Subtitles] Failed to convert to VTT:', error instanceof Error ? error.message : error);
    throw error;
  }
}

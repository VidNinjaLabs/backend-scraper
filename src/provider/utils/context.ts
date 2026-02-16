import { MovieMedia, ShowMedia } from '@/entrypoint/utils/media';
import { UseableFetcher } from '@/fetchers/types';

export type ScrapeContext = {
  proxiedFetcher: UseableFetcher;
  fetcher: UseableFetcher;
  browserFetcher?: UseableFetcher; // Optional browser-based fetcher for Cloudflare bypass
  progress(val: number): void;
};

export type EmbedInput = {
  url: string;
};

export type EmbedScrapeContext = EmbedInput & ScrapeContext;

export type MovieScrapeContext = ScrapeContext & {
  media: MovieMedia;
};

export type ShowScrapeContext = ScrapeContext & {
  media: ShowMedia;
};

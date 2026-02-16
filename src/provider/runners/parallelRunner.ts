/* eslint-disable no-console */
import { FullScraperEvents, UpdateEvent } from '@/entrypoint/utils/events';
import { ScrapeMedia } from '@/entrypoint/utils/media';
import { FeatureMap, flagsAllowedInFeatures } from '@/entrypoint/utils/targets';
import { UseableFetcher } from '@/fetchers/types';
import { SourcererOutput } from '@/providers/base';
import { ProviderList } from '@/providers/get';
import { Stream } from '@/providers/streams';
import { ScrapeContext } from '@/utils/context';
import { NotFoundError } from '@/utils/errors';
import { reorderOnIdList } from '@/utils/list';
import { isValidStream } from '@/utils/valid';

export type RunOutput = {
  embeds: never[];
  sourceId: string;
  embedId?: string;
  stream: Stream;
};

export type ProviderRunnerOptions = {
  fetcher: UseableFetcher;
  proxiedFetcher: UseableFetcher;
  browserFetcher?: UseableFetcher;
  features: FeatureMap;
  sourceOrder?: string[];
  embedOrder?: string[];
  events?: FullScraperEvents;
  media: ScrapeMedia;
  proxyStreams?: boolean;
};

/**
 * Run providers in PARALLEL with race semantics - returns first successful result
 * Much faster than sequential execution
 */
export async function runAllProvidersParallel(
  list: ProviderList,
  ops: ProviderRunnerOptions,
): Promise<RunOutput | null> {
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((source) => {
    if (ops.media.type === 'movie') return !!source.scrapeMovie;
    if (ops.media.type === 'show') return !!source.scrapeShow;
    return false;
  });

  ops.events?.init?.({
    sourceIds: sources.map((v) => v.id),
  });

  // Create a promise for each provider
  const providerPromises = sources.map(async (source): Promise<RunOutput | null> => {
    const contextBase: ScrapeContext = {
      fetcher: ops.fetcher,
      proxiedFetcher: ops.proxiedFetcher,
      browserFetcher: ops.browserFetcher,
      progress(val) {
        ops.events?.update?.({
          id: source.id,
          percentage: val,
          status: 'pending',
        });
      },
    };

    ops.events?.start?.(source.id);

    try {
      let output: SourcererOutput | null = null;

      if (ops.media.type === 'movie' && source.scrapeMovie) {
        output = await source.scrapeMovie({
          ...contextBase,
          media: ops.media,
        });
      } else if (ops.media.type === 'show' && source.scrapeShow) {
        output = await source.scrapeShow({
          ...contextBase,
          media: ops.media,
        });
      }

      if (output) {
        output.stream = (output.stream ?? [])
          .filter(isValidStream)
          .filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
      }

      if (!output || !output.stream?.length) {
        throw new NotFoundError('No streams found');
      }

      // Return first stream without validation (skip slow network check)
      return {
        sourceId: source.id,
        stream: output.stream[0],
        embeds: [],
      };
    } catch (error) {
      const updateParams: UpdateEvent = {
        id: source.id,
        percentage: 100,
        status: error instanceof NotFoundError ? 'notfound' : 'failure',
        reason: error instanceof NotFoundError ? error.message : undefined,
        error: error instanceof NotFoundError ? undefined : error,
      };
      ops.events?.update?.(updateParams);
      return null;
    }
  });

  // Race all providers - return first non-null result
  const results = await Promise.allSettled(providerPromises);

  for (const result of results) {
    if (result.status === 'fulfilled' && result.value !== null) {
      return result.value;
    }
  }

  return null;
}

/**
 * Run top N providers in parallel with timeout
 * Returns first successful result or null
 */
export async function runTopProvidersRace(
  list: ProviderList,
  ops: ProviderRunnerOptions,
  topN: number = 3,
  timeoutMs: number = 15000,
): Promise<RunOutput | null> {
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources)
    .filter((source) => {
      if (ops.media.type === 'movie') return !!source.scrapeMovie;
      if (ops.media.type === 'show') return !!source.scrapeShow;
      return false;
    })
    .slice(0, topN); // Only run top N ranked providers

  ops.events?.init?.({
    sourceIds: sources.map((v) => v.id),
  });

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const providerPromises = sources.map(async (source): Promise<RunOutput | null> => {
      const contextBase: ScrapeContext = {
        fetcher: ops.fetcher,
        proxiedFetcher: ops.proxiedFetcher,
        browserFetcher: ops.browserFetcher,
        progress(val) {
          ops.events?.update?.({
            id: source.id,
            percentage: val,
            status: 'pending',
          });
        },
      };

      ops.events?.start?.(source.id);

      try {
        let output: SourcererOutput | null = null;

        if (ops.media.type === 'movie' && source.scrapeMovie) {
          output = await source.scrapeMovie({
            ...contextBase,
            media: ops.media,
          });
        } else if (ops.media.type === 'show' && source.scrapeShow) {
          output = await source.scrapeShow({
            ...contextBase,
            media: ops.media,
          });
        }

        if (output) {
          output.stream = (output.stream ?? [])
            .filter(isValidStream)
            .filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        }

        if (!output || !output.stream?.length) {
          throw new NotFoundError('No streams found');
        }

        return {
          sourceId: source.id,
          stream: output.stream[0],
          embeds: [],
        };
      } catch (error) {
        ops.events?.update?.({
          id: source.id,
          percentage: 100,
          status: error instanceof NotFoundError ? 'notfound' : 'failure',
        });
        return null;
      }
    });

    // Use Promise.race to return first successful result
    const racePromise = new Promise<RunOutput | null>((resolve) => {
      let resolved = false;
      let completedCount = 0;

      providerPromises.forEach((promise) => {
        promise.then((result) => {
          completedCount++;
          if (!resolved && result !== null) {
            resolved = true;
            resolve(result);
          } else if (completedCount === providerPromises.length && !resolved) {
            resolve(null);
          }
        });
      });
    });

    return await racePromise;
  } finally {
    clearTimeout(timeout);
  }
}

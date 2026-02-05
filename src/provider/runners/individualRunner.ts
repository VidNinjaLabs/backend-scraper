import { IndividualScraperEvents } from "@/entrypoint/utils/events";
import { ScrapeMedia } from "@/entrypoint/utils/media";
import { FeatureMap, flagsAllowedInFeatures } from "@/entrypoint/utils/targets";
import { UseableFetcher } from "@/fetchers/types";
import { EmbedOutput, SourcererOutput } from "@/providers/base";
import { ProviderList } from "@/providers/get";
import { ScrapeContext } from "@/utils/context";
import { NotFoundError } from "@/utils/errors";
import { isValidStream, validatePlayableStreams } from "@/utils/valid";

export type IndividualSourceRunnerOptions = {
  features: FeatureMap;
  fetcher: UseableFetcher;
  proxiedFetcher: UseableFetcher;
  browserFetcher?: UseableFetcher;
  media: ScrapeMedia;
  id: string;
  events?: IndividualScraperEvents;
  proxyStreams?: boolean; // temporary
};

export async function scrapeInvidualSource(
  list: ProviderList,
  ops: IndividualSourceRunnerOptions,
): Promise<SourcererOutput> {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper) throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie)
    throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow)
    throw new Error("Source is not compatible with shows");

  const contextBase: ScrapeContext = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    browserFetcher: ops.browserFetcher,
    progress(val) {
      ops.events?.update?.({
        id: sourceScraper.id,
        percentage: val,
        status: "pending",
      });
    },
  };
  let output: SourcererOutput | null = null;
  console.log(
    `[SourceRunner] Running ${sourceScraper.id} for ${ops.media.type}`,
  );

  if (ops.media.type === "movie" && sourceScraper.scrapeMovie) {
    try {
      output = await sourceScraper.scrapeMovie({
        ...contextBase,
        media: ops.media,
      });
      console.log(
        `[SourceRunner] ${sourceScraper.id} return output:`,
        output ? "Yes" : "No",
      );
      if (output?.stream)
        console.log(
          `[SourceRunner] ${sourceScraper.id} streams found:`,
          output.stream.length,
        );
    } catch (err) {
      console.error(`[SourceRunner] ${sourceScraper.id} failed:`, err);
    }
  } else if (ops.media.type === "show" && sourceScraper.scrapeShow) {
    try {
      output = await sourceScraper.scrapeShow({
        ...contextBase,
        media: ops.media,
      });
      console.log(
        `[SourceRunner] ${sourceScraper.id} return output:`,
        output ? "Yes" : "No",
      );
      if (output?.stream)
        console.log(
          `[SourceRunner] ${sourceScraper.id} streams found:`,
          output.stream.length,
        );
    } catch (err) {
      console.error(`[SourceRunner] ${sourceScraper.id} failed:`, err);
    }
  }

  // filter output with only valid streams
  if (output?.stream) {
    const originalCount = output.stream.length;
    output.stream = output.stream
      .filter((stream) => isValidStream(stream))
      .filter((stream) => {
        const allowed = flagsAllowedInFeatures(ops.features, stream.flags);
        if (!allowed)
          console.log(`[SourceRunner] Stream filtered by flags:`, stream.flags);
        return allowed;
      });
    console.log(
      `[SourceRunner] ${sourceScraper.id} filtered streams: ${originalCount} -> ${output.stream.length}`,
    );

    // Filter to HLS-only if enabled (removes MP4/file streams for faster loading)
    if (process.env.PREFER_HLS_ONLY === "true") {
      output.stream = output.stream.filter((stream) => stream.type === "hls");
    }

    // Proxy handling now done by CloudFlare Worker
  }

  if (!output) throw new Error("output is null");

  // filter output with only valid embeds that are not disabled
  output.embeds = output.embeds.filter((embed) => {
    const e = list.embeds.find((v) => v.id === embed.embedId);
    if (!e || e.disabled) return false;
    return true;
  });

  if (
    (!output.stream || output.stream.length === 0) &&
    output.embeds.length === 0
  )
    throw new NotFoundError("No streams found");

  // only check for playable streams if there are streams, and if there are no embeds
  if (output.stream && output.stream.length > 0 && output.embeds.length === 0) {
    const playableStreams = await validatePlayableStreams(
      output.stream,
      ops,
      sourceScraper.id,
    );
    if (playableStreams.length === 0)
      throw new NotFoundError("No playable streams found");

    output.stream = playableStreams;
  }
  return output;
}

export type IndividualEmbedRunnerOptions = {
  features: FeatureMap;
  fetcher: UseableFetcher;
  proxiedFetcher: UseableFetcher;
  browserFetcher?: UseableFetcher;
  url: string;
  id: string;
  events?: IndividualScraperEvents;
  proxyStreams?: boolean; // temporary
};

export async function scrapeIndividualEmbed(
  list: ProviderList,
  ops: IndividualEmbedRunnerOptions,
): Promise<EmbedOutput> {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper) throw new Error("Embed with ID not found");

  const url = ops.url;

  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    browserFetcher: ops.browserFetcher,
    url,
    progress(val) {
      ops.events?.update?.({
        id: embedScraper.id,
        percentage: val,
        status: "pending",
      });
    },
  });

  output.stream = output.stream
    .filter((stream) => isValidStream(stream))
    .filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));

  // Filter to HLS-only if enabled (removes MP4/file streams for faster loading)
  if (process.env.PREFER_HLS_ONLY === "true") {
    output.stream = output.stream.filter((stream) => stream.type === "hls");
  }

  if (output.stream.length === 0) throw new NotFoundError("No streams found");

  // Proxy handling now done by Cloudflare Worker

  const playableStreams = await validatePlayableStreams(
    output.stream,
    ops,
    embedScraper.id,
  );
  if (playableStreams.length === 0)
    throw new NotFoundError("No playable streams found");

  output.stream = playableStreams;

  return output;
}

import CryptoJS from "crypto-js";
import ISO6391 from "iso-639-1";
import { load } from "cheerio";
import { unpack } from "unpacker";
import { CookieJar } from "tough-cookie";
import { fetch as fetch$1 } from "undici";
import FormData from "form-data";
import { searchSubtitles } from "wyzie-lib";
class NotFoundError extends Error {
  constructor(reason) {
    super(`Couldn't find a stream: ${reason ?? "not found"}`);
    this.name = "NotFoundError";
  }
}
function formatSourceMeta(v) {
  const types = [];
  if (v.scrapeMovie) types.push("movie");
  if (v.scrapeShow) types.push("show");
  return {
    type: "source",
    id: v.id,
    rank: v.rank,
    name: v.name,
    mediaTypes: types
  };
}
function formatEmbedMeta(v) {
  return {
    type: "embed",
    id: v.id,
    rank: v.rank,
    name: v.name
  };
}
function getAllSourceMetaSorted(list) {
  return list.sources.sort((a, b) => b.rank - a.rank).map(formatSourceMeta);
}
function getAllEmbedMetaSorted(list) {
  return list.embeds.sort((a, b) => b.rank - a.rank).map(formatEmbedMeta);
}
function getSpecificId(list, id) {
  const foundSource = list.sources.find((v) => v.id === id);
  if (foundSource) {
    return formatSourceMeta(foundSource);
  }
  const foundEmbed = list.embeds.find((v) => v.id === id);
  if (foundEmbed) {
    return formatEmbedMeta(foundEmbed);
  }
  return null;
}
function makeFullUrl(url, ops) {
  let leftSide = (ops == null ? void 0 : ops.baseUrl) ?? "";
  let rightSide = url;
  if (leftSide.length > 0 && !leftSide.endsWith("/")) leftSide += "/";
  if (rightSide.startsWith("/")) rightSide = rightSide.slice(1);
  const fullUrl = leftSide + rightSide;
  if (!fullUrl.startsWith("http://") && !fullUrl.startsWith("https://") && !fullUrl.startsWith("data:"))
    throw new Error(`Invald URL -- URL doesn't start with a http scheme: '${fullUrl}'`);
  const parsedUrl = new URL(fullUrl);
  Object.entries((ops == null ? void 0 : ops.query) ?? {}).forEach(([k, v]) => {
    parsedUrl.searchParams.set(k, v);
  });
  return parsedUrl.toString();
}
function makeFetcher(fetcher) {
  const newFetcher = (url, ops) => {
    return fetcher(url, {
      headers: (ops == null ? void 0 : ops.headers) ?? {},
      method: (ops == null ? void 0 : ops.method) ?? "GET",
      query: (ops == null ? void 0 : ops.query) ?? {},
      baseUrl: (ops == null ? void 0 : ops.baseUrl) ?? "",
      readHeaders: (ops == null ? void 0 : ops.readHeaders) ?? [],
      body: ops == null ? void 0 : ops.body,
      credentials: ops == null ? void 0 : ops.credentials
    });
  };
  const output = async (url, ops) => (await newFetcher(url, ops)).body;
  output.full = newFetcher;
  return output;
}
const flags = {
  // CORS are set to allow any origin
  CORS_ALLOWED: "cors-allowed",
  // the stream is locked on IP, so only works if
  // request maker is same as player (not compatible with proxies)
  IP_LOCKED: "ip-locked",
  // The source/embed is blocking cloudflare ip's
  // This flag is not compatible with a proxy hosted on cloudflare
  CF_BLOCKED: "cf-blocked",
  // Streams and sources with this flag wont be proxied
  // And will be exclusive to the extension
  PROXY_BLOCKED: "proxy-blocked"
};
const targets = {
  // browser with CORS restrictions
  BROWSER: "browser",
  // browser, but no CORS restrictions through a browser extension
  BROWSER_EXTENSION: "browser-extension",
  // native app, so no restrictions in what can be played
  NATIVE: "native",
  // any target, no target restrictions
  ANY: "any"
};
const targetToFeatures = {
  browser: {
    requires: [flags.CORS_ALLOWED],
    disallowed: []
  },
  "browser-extension": {
    requires: [],
    disallowed: []
  },
  native: {
    requires: [],
    disallowed: []
  },
  any: {
    requires: [],
    disallowed: []
  }
};
function getTargetFeatures(target, consistentIpForRequests, proxyStreams) {
  const features = targetToFeatures[target];
  if (!consistentIpForRequests) features.disallowed.push(flags.IP_LOCKED);
  if (proxyStreams) features.disallowed.push(flags.PROXY_BLOCKED);
  return features;
}
function flagsAllowedInFeatures(features, inputFlags) {
  const hasAllFlags = features.requires.every((v) => inputFlags.includes(v));
  if (!hasAllFlags) return false;
  const hasDisallowedFlag = features.disallowed.some((v) => inputFlags.includes(v));
  if (hasDisallowedFlag) return false;
  return true;
}
const SKIP_VALIDATION_CHECK_IDS = ["cloudnestra", "vidrock", "showbox", "vidlink", "lookmovie"];
function isValidStream(stream) {
  if (!stream) return false;
  if (stream.type === "hls") {
    if (!stream.playlist) return false;
    return true;
  }
  if (stream.type === "file") {
    const validQualities = Object.values(stream.qualities).filter((v) => v.url.length > 0);
    if (validQualities.length === 0) return false;
    return true;
  }
  return false;
}
function isAlreadyProxyUrl(url) {
  return url.includes("/m3u8-proxy?url=");
}
async function validatePlayableStream(stream, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return stream;
  if (stream.type === "hls") {
    if (stream.playlist.startsWith("data:")) return stream;
    const useNormalFetch = isAlreadyProxyUrl(stream.playlist);
    let result;
    if (useNormalFetch) {
      try {
        const response = await fetch(stream.playlist, {
          method: "GET",
          headers: {
            ...stream.preferredHeaders,
            ...stream.headers
          }
        });
        result = {
          statusCode: response.status,
          body: await response.text(),
          finalUrl: response.url
        };
      } catch (error) {
        return null;
      }
    } else {
      result = await ops.proxiedFetcher.full(stream.playlist, {
        method: "GET",
        headers: {
          ...stream.preferredHeaders,
          ...stream.headers
        }
      });
    }
    if (result.statusCode < 200 || result.statusCode >= 400) return null;
    return stream;
  }
  if (stream.type === "file") {
    const validQualitiesResults = await Promise.all(
      Object.values(stream.qualities).map(async (quality) => {
        const useNormalFetch = isAlreadyProxyUrl(quality.url);
        if (useNormalFetch) {
          try {
            const response = await fetch(quality.url, {
              method: "GET",
              headers: {
                ...stream.preferredHeaders,
                ...stream.headers,
                Range: "bytes=0-1"
              }
            });
            return {
              statusCode: response.status,
              body: await response.text(),
              finalUrl: response.url
            };
          } catch (error) {
            return { statusCode: 500, body: "", finalUrl: quality.url };
          }
        }
        return ops.proxiedFetcher.full(quality.url, {
          method: "GET",
          headers: {
            ...stream.preferredHeaders,
            ...stream.headers,
            Range: "bytes=0-1"
          }
        });
      })
    );
    const validQualities = stream.qualities;
    Object.keys(stream.qualities).forEach((quality, index) => {
      if (validQualitiesResults[index].statusCode < 200 || validQualitiesResults[index].statusCode >= 400) {
        delete validQualities[quality];
      }
    });
    if (Object.keys(validQualities).length === 0) return null;
    return { ...stream, qualities: validQualities };
  }
  return null;
}
async function validatePlayableStreams(streams, ops, sourcererId) {
  if (SKIP_VALIDATION_CHECK_IDS.includes(sourcererId)) return streams;
  return (await Promise.all(streams.map((stream) => validatePlayableStream(stream, ops, sourcererId)))).filter(
    (v) => v !== null
  );
}
async function scrapeInvidualSource(list, ops) {
  const sourceScraper = list.sources.find((v) => ops.id === v.id);
  if (!sourceScraper) throw new Error("Source with ID not found");
  if (ops.media.type === "movie" && !sourceScraper.scrapeMovie) throw new Error("Source is not compatible with movies");
  if (ops.media.type === "show" && !sourceScraper.scrapeShow) throw new Error("Source is not compatible with shows");
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    browserFetcher: ops.browserFetcher,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: sourceScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  };
  let output = null;
  if (ops.media.type === "movie" && sourceScraper.scrapeMovie)
    output = await sourceScraper.scrapeMovie({
      ...contextBase,
      media: ops.media
    });
  else if (ops.media.type === "show" && sourceScraper.scrapeShow)
    output = await sourceScraper.scrapeShow({
      ...contextBase,
      media: ops.media
    });
  if (output == null ? void 0 : output.stream) {
    output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
    if (process.env.PREFER_HLS_ONLY === "true") {
      output.stream = output.stream.filter((stream) => stream.type === "hls");
    }
  }
  if (!output) throw new Error("output is null");
  output.embeds = output.embeds.filter((embed) => {
    const e = list.embeds.find((v) => v.id === embed.embedId);
    if (!e || e.disabled) return false;
    return true;
  });
  if ((!output.stream || output.stream.length === 0) && output.embeds.length === 0)
    throw new NotFoundError("No streams found");
  if (output.stream && output.stream.length > 0 && output.embeds.length === 0) {
    const playableStreams = await validatePlayableStreams(output.stream, ops, sourceScraper.id);
    if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
    output.stream = playableStreams;
  }
  return output;
}
async function scrapeIndividualEmbed(list, ops) {
  const embedScraper = list.embeds.find((v) => ops.id === v.id);
  if (!embedScraper) throw new Error("Embed with ID not found");
  const url = ops.url;
  const output = await embedScraper.scrape({
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    browserFetcher: ops.browserFetcher,
    url,
    progress(val) {
      var _a, _b;
      (_b = (_a = ops.events) == null ? void 0 : _a.update) == null ? void 0 : _b.call(_a, {
        id: embedScraper.id,
        percentage: val,
        status: "pending"
      });
    }
  });
  output.stream = output.stream.filter((stream) => isValidStream(stream)).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
  if (process.env.PREFER_HLS_ONLY === "true") {
    output.stream = output.stream.filter((stream) => stream.type === "hls");
  }
  if (output.stream.length === 0) throw new NotFoundError("No streams found");
  const playableStreams = await validatePlayableStreams(output.stream, ops, embedScraper.id);
  if (playableStreams.length === 0) throw new NotFoundError("No playable streams found");
  output.stream = playableStreams;
  return output;
}
function reorderOnIdList(order, list) {
  const copy = [...list];
  copy.sort((a, b) => {
    const aIndex = order.indexOf(a.id);
    const bIndex = order.indexOf(b.id);
    if (aIndex >= 0 && bIndex >= 0) return aIndex - bIndex;
    if (bIndex >= 0) return 1;
    if (aIndex >= 0) return -1;
    return b.rank - a.rank;
  });
  return copy;
}
async function runTopProvidersRace(list, ops, topN = 3, timeoutMs = 15e3) {
  var _a, _b;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((source) => {
    if (ops.media.type === "movie") return !!source.scrapeMovie;
    if (ops.media.type === "show") return !!source.scrapeShow;
    return false;
  }).slice(0, topN);
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const providerPromises = sources.map(async (source) => {
      var _a2, _b2, _c, _d, _e;
      const contextBase = {
        fetcher: ops.fetcher,
        proxiedFetcher: ops.proxiedFetcher,
        browserFetcher: ops.browserFetcher,
        progress(val) {
          var _a3, _b3;
          (_b3 = (_a3 = ops.events) == null ? void 0 : _a3.update) == null ? void 0 : _b3.call(_a3, {
            id: source.id,
            percentage: val,
            status: "pending"
          });
        }
      };
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.start) == null ? void 0 : _b2.call(_a2, source.id);
      try {
        let output = null;
        if (ops.media.type === "movie" && source.scrapeMovie) {
          output = await source.scrapeMovie({
            ...contextBase,
            media: ops.media
          });
        } else if (ops.media.type === "show" && source.scrapeShow) {
          output = await source.scrapeShow({
            ...contextBase,
            media: ops.media
          });
        }
        if (output) {
          output.stream = (output.stream ?? []).filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        }
        if (!output || !((_c = output.stream) == null ? void 0 : _c.length)) {
          throw new NotFoundError("No streams found");
        }
        return {
          sourceId: source.id,
          stream: output.stream[0],
          embeds: []
        };
      } catch (error) {
        (_e = (_d = ops.events) == null ? void 0 : _d.update) == null ? void 0 : _e.call(_d, {
          id: source.id,
          percentage: 100,
          status: error instanceof NotFoundError ? "notfound" : "failure"
        });
        return null;
      }
    });
    const racePromise = new Promise((resolve) => {
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
async function runAllProviders(list, ops) {
  var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o;
  const sources = reorderOnIdList(ops.sourceOrder ?? [], list.sources).filter((source) => {
    if (ops.media.type === "movie") return !!source.scrapeMovie;
    if (ops.media.type === "show") return !!source.scrapeShow;
    return false;
  });
  const embeds = reorderOnIdList(ops.embedOrder ?? [], list.embeds);
  const embedIds = embeds.map((embed) => embed.id);
  let lastId = "";
  const contextBase = {
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    browserFetcher: ops.browserFetcher,
    progress(val) {
      var _a2, _b2;
      (_b2 = (_a2 = ops.events) == null ? void 0 : _a2.update) == null ? void 0 : _b2.call(_a2, {
        id: lastId,
        percentage: val,
        status: "pending"
      });
    }
  };
  (_b = (_a = ops.events) == null ? void 0 : _a.init) == null ? void 0 : _b.call(_a, {
    sourceIds: sources.map((v) => v.id)
  });
  for (const source of sources) {
    if ((_c = ops.abortSignal) == null ? void 0 : _c.aborted) {
      throw new Error("Aborted");
    }
    (_e = (_d = ops.events) == null ? void 0 : _d.start) == null ? void 0 : _e.call(_d, source.id);
    lastId = source.id;
    let output = null;
    try {
      if (ops.media.type === "movie" && source.scrapeMovie)
        output = await source.scrapeMovie({
          ...contextBase,
          media: ops.media
        });
      else if (ops.media.type === "show" && source.scrapeShow)
        output = await source.scrapeShow({
          ...contextBase,
          media: ops.media
        });
      if (output) {
        output.stream = (output.stream ?? []).filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
      }
      if (!output || !((_f = output.stream) == null ? void 0 : _f.length) && !output.embeds.length) {
        throw new NotFoundError("No streams found");
      }
    } catch (error) {
      const updateParams = {
        id: source.id,
        percentage: 100,
        status: error instanceof NotFoundError ? "notfound" : "failure",
        reason: error instanceof NotFoundError ? error.message : void 0,
        error: error instanceof NotFoundError ? void 0 : error
      };
      (_h = (_g = ops.events) == null ? void 0 : _g.update) == null ? void 0 : _h.call(_g, updateParams);
      continue;
    }
    if (!output) throw new Error("Invalid media type");
    if ((_i = output.stream) == null ? void 0 : _i[0]) {
      const playableStream = await validatePlayableStream(output.stream[0], ops, source.id);
      if (!playableStream) throw new NotFoundError("No streams found");
      return {
        sourceId: source.id,
        stream: playableStream,
        embeds: []
      };
    }
    const sortedEmbeds = output.embeds.filter((embed) => {
      const e = list.embeds.find((v) => v.id === embed.embedId);
      return e && !e.disabled;
    }).sort((a, b) => embedIds.indexOf(a.embedId) - embedIds.indexOf(b.embedId));
    if (sortedEmbeds.length > 0) {
      (_k = (_j = ops.events) == null ? void 0 : _j.discoverEmbeds) == null ? void 0 : _k.call(_j, {
        embeds: sortedEmbeds.map((embed, i) => ({
          id: [source.id, i].join("-"),
          embedScraperId: embed.embedId
        })),
        sourceId: source.id
      });
    }
    for (const [ind, embed] of sortedEmbeds.entries()) {
      const scraper = embeds.find((v) => v.id === embed.embedId);
      if (!scraper) throw new Error("Invalid embed returned");
      const id = [source.id, ind].join("-");
      (_m = (_l = ops.events) == null ? void 0 : _l.start) == null ? void 0 : _m.call(_l, id);
      lastId = id;
      let embedOutput;
      try {
        embedOutput = await scraper.scrape({
          ...contextBase,
          url: embed.url
        });
        embedOutput.stream = embedOutput.stream.filter(isValidStream).filter((stream) => flagsAllowedInFeatures(ops.features, stream.flags));
        if (embedOutput.stream.length === 0) {
          throw new NotFoundError("No streams found");
        }
        const playableStream = await validatePlayableStream(embedOutput.stream[0], ops, embed.embedId);
        if (!playableStream) throw new NotFoundError("No streams found");
        embedOutput.stream = [playableStream];
      } catch (error) {
        const updateParams = {
          id,
          percentage: 100,
          status: error instanceof NotFoundError ? "notfound" : "failure",
          reason: error instanceof NotFoundError ? error.message : void 0,
          error: error instanceof NotFoundError ? void 0 : error
        };
        (_o = (_n = ops.events) == null ? void 0 : _n.update) == null ? void 0 : _o.call(_n, updateParams);
        continue;
      }
      return {
        sourceId: source.id,
        embedId: scraper.id,
        stream: embedOutput.stream[0],
        embeds: []
      };
    }
  }
  return null;
}
function makeControls(ops) {
  const list = {
    embeds: ops.embeds,
    sources: ops.sources
  };
  const providerRunnerOps = {
    features: ops.features,
    fetcher: makeFetcher(ops.fetcher),
    proxiedFetcher: makeFetcher(ops.proxiedFetcher ?? ops.fetcher),
    proxyStreams: ops.proxyStreams
  };
  return {
    runAll(runnerOps) {
      return runAllProviders(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runAllFast(runnerOps) {
      return runTopProvidersRace(
        list,
        {
          ...providerRunnerOps,
          ...runnerOps
        },
        5,
        2e4
      );
    },
    runSourceScraper(runnerOps) {
      return scrapeInvidualSource(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    runEmbedScraper(runnerOps) {
      return scrapeIndividualEmbed(list, {
        ...providerRunnerOps,
        ...runnerOps
      });
    },
    getMetadata(id) {
      return getSpecificId(list, id);
    },
    listSources() {
      return getAllSourceMetaSorted(list);
    },
    listEmbeds() {
      return getAllEmbedMetaSorted(list);
    }
  };
}
function makeSourcerer(state) {
  const mediaTypes = [];
  if (state.scrapeMovie) mediaTypes.push("movie");
  if (state.scrapeShow) mediaTypes.push("show");
  return {
    ...state,
    type: "source",
    disabled: state.disabled ?? false,
    externalSource: state.externalSource ?? false,
    mediaTypes
  };
}
function makeEmbed(state) {
  return {
    ...state,
    type: "embed",
    disabled: state.disabled ?? false,
    mediaTypes: void 0
  };
}
const captionTypes = {
  srt: "srt",
  vtt: "vtt"
};
function getCaptionTypeFromUrl(url) {
  const extensions = Object.keys(captionTypes);
  const type = extensions.find((v) => url.endsWith(`.${v}`));
  if (!type) return null;
  return type;
}
function labelToLanguageCode(label) {
  const languageMap = {
    "chinese - hong kong": "zh",
    "chinese - traditional": "zh",
    czech: "cs",
    danish: "da",
    dutch: "nl",
    english: "en",
    "english - sdh": "en",
    finnish: "fi",
    french: "fr",
    german: "de",
    greek: "el",
    hungarian: "hu",
    italian: "it",
    korean: "ko",
    norwegian: "no",
    polish: "pl",
    portuguese: "pt",
    "portuguese - brazilian": "pt",
    romanian: "ro",
    "spanish - european": "es",
    "spanish - latin american": "es",
    spanish: "es",
    swedish: "sv",
    turkish: "tr",
    اَلْعَرَبِيَّةُ: "ar",
    বাংলা: "bn",
    filipino: "tl",
    indonesia: "id",
    اردو: "ur",
    English: "en",
    Arabic: "ar",
    Bosnian: "bs",
    Bulgarian: "bg",
    Croatian: "hr",
    Czech: "cs",
    Danish: "da",
    Dutch: "nl",
    Estonian: "et",
    Finnish: "fi",
    French: "fr",
    German: "de",
    Greek: "el",
    Hebrew: "he",
    Hungarian: "hu",
    Indonesian: "id",
    Italian: "it",
    Norwegian: "no",
    Persian: "fa",
    Polish: "pl",
    Portuguese: "pt",
    "Protuguese (BR)": "pt-br",
    Romanian: "ro",
    Russian: "ru",
    russian: "ru",
    Serbian: "sr",
    Slovenian: "sl",
    Spanish: "es",
    Swedish: "sv",
    Thai: "th",
    Turkish: "tr",
    // Simple language codes
    ng: "en",
    re: "fr",
    pa: "es"
  };
  const mappedCode = languageMap[label.toLowerCase()];
  if (mappedCode) return mappedCode;
  const code = ISO6391.getCode(label);
  if (code.length === 0) return null;
  return code;
}
function removeDuplicatedLanguages(list) {
  const beenSeen = {};
  return list.filter((sub) => {
    if (beenSeen[sub.language]) return false;
    beenSeen[sub.language] = true;
    return true;
  });
}
const origin = "https://rabbitstream.net";
const referer$2 = "https://rabbitstream.net/";
const { AES, enc } = CryptoJS;
function isJSON(json) {
  try {
    JSON.parse(json);
    return true;
  } catch {
    return false;
  }
}
function extractKey(script) {
  const startOfSwitch = script.lastIndexOf("switch");
  const endOfCases = script.indexOf("partKeyStartPosition");
  const switchBody = script.slice(startOfSwitch, endOfCases);
  const nums = [];
  const matches = switchBody.matchAll(/:[a-zA-Z0-9]+=([a-zA-Z0-9]+),[a-zA-Z0-9]+=([a-zA-Z0-9]+);/g);
  for (const match of matches) {
    const innerNumbers = [];
    for (const varMatch of [match[1], match[2]]) {
      const regex = new RegExp(`${varMatch}=0x([a-zA-Z0-9]+)`, "g");
      const varMatches = [...script.matchAll(regex)];
      const lastMatch = varMatches[varMatches.length - 1];
      if (!lastMatch) return null;
      const number = parseInt(lastMatch[1], 16);
      innerNumbers.push(number);
    }
    nums.push([innerNumbers[0], innerNumbers[1]]);
  }
  return nums;
}
const upcloudScraper = makeEmbed({
  id: "upcloud",
  name: "UpCloud",
  rank: 200,
  disabled: true,
  flags: [],
  async scrape(ctx) {
    const parsedUrl = new URL(ctx.url.replace("embed-5", "embed-4"));
    const dataPath = parsedUrl.pathname.split("/");
    const dataId = dataPath[dataPath.length - 1];
    const streamRes = await ctx.proxiedFetcher(`${parsedUrl.origin}/ajax/embed-4/getSources?id=${dataId}`, {
      headers: {
        Referer: parsedUrl.origin,
        "X-Requested-With": "XMLHttpRequest"
      }
    });
    let sources = null;
    if (!isJSON(streamRes.sources)) {
      const scriptJs = await ctx.proxiedFetcher(`https://rabbitstream.net/js/player/prod/e4-player.min.js`, {
        query: {
          // browser side caching on this endpoint is quite extreme. Add version query paramter to circumvent any caching
          v: Date.now().toString()
        }
      });
      const decryptionKey = extractKey(scriptJs);
      if (!decryptionKey) throw new Error("Key extraction failed");
      let extractedKey = "";
      let strippedSources = streamRes.sources;
      let totalledOffset = 0;
      decryptionKey.forEach(([a, b]) => {
        const start = a + totalledOffset;
        const end = start + b;
        extractedKey += streamRes.sources.slice(start, end);
        strippedSources = strippedSources.replace(streamRes.sources.substring(start, end), "");
        totalledOffset += b;
      });
      const decryptedStream = AES.decrypt(strippedSources, extractedKey).toString(enc.Utf8);
      const parsedStream = JSON.parse(decryptedStream)[0];
      if (!parsedStream) throw new Error("No stream found");
      sources = parsedStream;
    }
    if (!sources) throw new Error("upcloud source not found");
    const captions = [];
    streamRes.tracks.forEach((track) => {
      if (track.kind !== "captions") return;
      const type = getCaptionTypeFromUrl(track.file);
      if (!type) return;
      const language = labelToLanguageCode(track.label.split(" ")[0]);
      if (!language) return;
      captions.push({
        id: track.file,
        language,
        hasCorsRestrictions: false,
        type,
        url: track.file
      });
    });
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: sources.file,
          flags: [flags.CORS_ALLOWED],
          captions,
          preferredHeaders: {
            Referer: referer$2,
            Origin: origin
          }
        }
      ]
    };
  }
});
const PROVIDER_CODENAMES = {
  cloudnestra: "Shadow",
  lookmovie: "Iron",
  vidrock: "Helix",
  videoeasy: "Blade",
  vidlink: "Storm",
  vixsrc: "Halo",
  hdhub4u: "Hub",
  ee3: "Vector",
  showbox: "Box",
  hdrezka: "Rezka"
};
const SERVER_LETTERS = [
  "Node",
  "Core",
  "Edge",
  "Flux",
  "Nexus",
  "Pulse",
  "Prism",
  "Relay",
  "Surge",
  "Vortex",
  "Spark",
  "Stream",
  "Circuit",
  "Cache",
  "Buffer",
  "Socket",
  "Portal",
  "Gateway",
  "Chain",
  "Mesh"
];
const CODENAME_TO_PROVIDER = Object.entries(PROVIDER_CODENAMES).reduce(
  (acc, [providerId, codename]) => {
    acc[codename] = providerId;
    return acc;
  },
  {}
);
function getProviderCodename(providerId) {
  return PROVIDER_CODENAMES[providerId] || "unknown";
}
function getProviderIdFromCodename(codename) {
  return CODENAME_TO_PROVIDER[codename] || null;
}
function resolveSourceId(input, sources) {
  var _a;
  if (!input) {
    return ((_a = sources[0]) == null ? void 0 : _a.id) || null;
  }
  const normalizedInput = input.trim();
  const codenameKey = Object.keys(PROVIDER_CODENAMES).find(
    (key) => PROVIDER_CODENAMES[key].toLowerCase() === normalizedInput.toLowerCase()
  );
  if (codenameKey) {
    return codenameKey;
  }
  if (sources.find((s) => s.id === normalizedInput)) {
    return normalizedInput;
  }
  return null;
}
function anonymizeSourceId(providerId) {
  return PROVIDER_CODENAMES[providerId] || "unknown";
}
function generateCodename(index, prefix) {
  const codename = SERVER_LETTERS[index % SERVER_LETTERS.length];
  const suffix = index >= SERVER_LETTERS.length ? ` ${Math.floor(index / SERVER_LETTERS.length) + 1}` : "";
  return prefix ? `${prefix} ${codename}${suffix}` : `${codename}${suffix}`;
}
const apiBaseUrl = "https://borg.rips.cc";
const username = "_sfgt_";
const password = "Sachu*1997";
async function fetchMovie(ctx, ee3Auth) {
  const authResp = await ctx.proxiedFetcher.full(
    `${apiBaseUrl}/api/collections/users/auth-with-password?expand=lists_liked`,
    {
      method: "POST",
      headers: {
        Origin: "https://ee3.me",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        identity: username,
        password: ee3Auth
      })
    }
  );
  if (authResp.statusCode !== 200) {
    throw new Error(`EE3: Auth failed (${authResp.statusCode})`);
  }
  const jsonResponse = authResp.body;
  if (!(jsonResponse == null ? void 0 : jsonResponse.token)) {
    throw new Error(`No token in auth response: ${JSON.stringify(jsonResponse)}`);
  }
  const token = jsonResponse.token;
  ctx.progress(20);
  const movieUrl = `${apiBaseUrl}/api/collections/movies/records?page=1&perPage=48&filter=tmdb_data.id=${ctx.media.tmdbId}`;
  const movieResp = await ctx.proxiedFetcher.full(movieUrl, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://ee3.me"
    }
  });
  if (movieResp.statusCode === 404) {
    throw new NotFoundError(`EE3: Movie search endpoint returned 404`);
  }
  if (movieResp.statusCode !== 200) {
    throw new Error(`EE3: Movie search failed (${movieResp.statusCode})`);
  }
  const movieJsonResponse = movieResp.body;
  if (!(movieJsonResponse == null ? void 0 : movieJsonResponse.items) || movieJsonResponse.items.length === 0) {
    throw new NotFoundError(`No movie found for TMDB ID ${ctx.media.tmdbId}`);
  }
  const movieItem = movieJsonResponse.items[0];
  if (movieItem.tmdb_id && movieItem.tmdb_id !== Number(ctx.media.tmdbId)) {
    throw new NotFoundError(`Movie mismatch: requested TMDB ${ctx.media.tmdbId} but got TMDB ${movieItem.tmdb_id}`);
  }
  const videoId = movieItem.video || movieItem.video_link || movieItem.id;
  if (!videoId || videoId.trim() === "") {
    throw new NotFoundError(
      `EE3: Movie found but no video ID available for "${ctx.media.title}" (TMDB: ${ctx.media.tmdbId})`
    );
  }
  ctx.progress(40);
  const keyResp = await ctx.proxiedFetcher.full(`${apiBaseUrl}/video/${videoId}/key`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Origin: "https://ee3.me"
    }
  });
  if (keyResp.statusCode !== 200) {
    throw new Error(`EE3: Key fetch failed (${keyResp.statusCode})`);
  }
  const keyJsonResponse = keyResp.body;
  if (!(keyJsonResponse == null ? void 0 : keyJsonResponse.key)) {
    throw new Error(`No key in response: ${JSON.stringify(keyJsonResponse)}`);
  }
  ctx.progress(60);
  return `${videoId}?k=${keyJsonResponse.key}`;
}
async function comboScraper$2(ctx) {
  const movData = await fetchMovie(ctx, password);
  if (!movData) {
    throw new NotFoundError("No watchable item found");
  }
  ctx.progress(80);
  const videoUrl = `${apiBaseUrl}/video/${movData}`;
  return {
    embeds: [],
    stream: [
      {
        id: "borg",
        displayName: generateCodename(0),
        type: "file",
        qualities: {
          unknown: {
            type: "mp4",
            url: videoUrl
          }
        },
        headers: {
          Origin: "https://ee3.me"
        },
        flags: [],
        captions: []
      }
    ]
  };
}
const ee3Scraper = makeSourcerer({
  id: "ee3",
  name: "Vector",
  rank: 188,
  disabled: false,
  // Re-enabled (was disabled due to .mp4 and cloudflare compatibility)
  flags: [],
  scrapeMovie: comboScraper$2
});
function customAtob(input) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=";
  const str = input.replace(/=+$/, "");
  let output = "";
  if (str.length % 4 === 1) {
    throw new Error("The string to be decoded is not correctly encoded.");
  }
  for (let bc = 0, bs = 0, i = 0; i < str.length; i++) {
    const buffer = str.charAt(i);
    const charIndex = chars.indexOf(buffer);
    if (charIndex === -1) continue;
    bs = bc % 4 ? bs * 64 + charIndex : charIndex;
    if (bc++ % 4) {
      output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
    }
  }
  return output;
}
function decodeCloseload(valueParts) {
  const value = valueParts.join("");
  let result = value;
  result = result.split("").reverse().join("");
  result = atob(result);
  result = result.replace(/[a-zA-Z]/g, function rot13Transform(c) {
    const charCode = c.charCodeAt(0);
    const newCharCode = charCode + 13;
    const maxCode = c <= "Z" ? 90 : 122;
    return String.fromCharCode(newCharCode <= maxCode ? newCharCode : newCharCode - 26);
  });
  let unmix = "";
  for (let i = 0; i < result.length; i++) {
    let charCode = result.charCodeAt(i);
    charCode = (charCode - 399756995 % (i + 5) + 256) % 256;
    unmix += String.fromCharCode(charCode);
  }
  return unmix;
}
const referer$1 = "https://ridomovies.tv/";
const closeLoadScraper = makeEmbed({
  id: "closeload",
  name: "CloseLoad",
  rank: 106,
  flags: [flags.IP_LOCKED],
  disabled: false,
  async scrape(ctx) {
    const baseUrl2 = new URL(ctx.url).origin;
    if (!ctx.browserFetcher) {
      throw new Error("Browser fetcher not available - required for Cloudflare bypass");
    }
    const iframeRes = await ctx.browserFetcher(ctx.url, {
      headers: { referer: referer$1 }
    });
    const iframeRes$ = load(iframeRes);
    const captions = iframeRes$("track").map((_, el) => {
      const track = iframeRes$(el);
      const url2 = `${baseUrl2}${track.attr("src")}`;
      const label = track.attr("label") ?? "";
      const language = labelToLanguageCode(label);
      const captionType = getCaptionTypeFromUrl(url2);
      if (!language || !captionType) return null;
      return {
        id: url2,
        language,
        hasCorsRestrictions: true,
        type: captionType,
        url: url2
      };
    }).get().filter((x) => x !== null);
    const evalCode = iframeRes$("script").filter((_, el) => {
      var _a;
      const script = iframeRes$(el);
      return (script.attr("type") === "text/javascript" && ((_a = script.html()) == null ? void 0 : _a.includes("p,a,c,k,e,d"))) ?? false;
    }).html();
    if (!evalCode) throw new Error("Couldn't find eval code");
    const decoded = unpack(evalCode);
    const m3u8Match = decoded.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
    if (m3u8Match) {
      return {
        stream: [
          {
            id: "primary",
            type: "hls",
            playlist: m3u8Match[1],
            captions,
            flags: [flags.IP_LOCKED],
            headers: {
              Referer: "https://closeload.top/",
              Origin: "https://closeload.top"
            }
          }
        ]
      };
    }
    const mp4Match = decoded.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
    if (mp4Match) {
      return {
        stream: [
          {
            id: "primary",
            type: "file",
            qualities: {
              unknown: {
                type: "mp4",
                url: mp4Match[1]
              }
            },
            captions,
            flags: [flags.IP_LOCKED],
            headers: {
              Referer: "https://closeload.top/",
              Origin: "https://closeload.top"
            }
          }
        ]
      };
    }
    let base64EncodedUrl;
    const functionCallMatch = decoded.match(/dc_\w+\(\[([^\]]+)\]\)/);
    if (functionCallMatch) {
      const arrayContent = functionCallMatch[1];
      const stringMatches = arrayContent.match(/"([^"]+)"/g);
      if (stringMatches) {
        const valueParts = stringMatches.map((s) => s.slice(1, -1));
        try {
          const decodedUrl = decodeCloseload(valueParts);
          if (decodedUrl.startsWith("http://") || decodedUrl.startsWith("https://")) {
            base64EncodedUrl = decodedUrl;
          }
        } catch (error) {
          console.log("[CloseLoad] Closeload decoding failed:", error);
        }
      }
    }
    if (!base64EncodedUrl) {
      console.log("[CloseLoad] Trying fallback patterns...");
      const patterns = [/var\s+(\w+)\s*=\s*"([^"]+)";/g, /(\w+)\s*=\s*"([^"]+)"/g, /"([A-Za-z0-9+/=]+)"/g];
      for (const pattern of patterns) {
        const match = pattern.exec(decoded);
        if (match) {
          const potentialUrl = match[2] || match[1];
          if (/^[A-Za-z0-9+/]*={0,2}$/.test(potentialUrl) && potentialUrl.length > 10) {
            base64EncodedUrl = potentialUrl;
            console.log("[CloseLoad] Found potential base64 URL via fallback");
            break;
          }
        }
      }
    }
    if (!base64EncodedUrl) throw new NotFoundError("Unable to find source url");
    let url;
    if (base64EncodedUrl.startsWith("http://") || base64EncodedUrl.startsWith("https://")) {
      url = base64EncodedUrl;
    } else {
      const isValidBase64 = /^[A-Za-z0-9+/]*={0,2}$/.test(base64EncodedUrl);
      if (!isValidBase64) {
        throw new NotFoundError("Invalid base64 encoding found in source url");
      }
      let decodedString;
      try {
        decodedString = atob(base64EncodedUrl);
      } catch (error) {
        try {
          decodedString = customAtob(base64EncodedUrl);
        } catch (customError) {
          throw new NotFoundError(`Failed to decode base64 source url: ${base64EncodedUrl.substring(0, 50)}...`);
        }
      }
      const urlMatch = decodedString.match(/(https?:\/\/[^\s"']+)/);
      if (urlMatch) {
        url = urlMatch[1];
      } else if (decodedString.startsWith("http://") || decodedString.startsWith("https://")) {
        url = decodedString;
      } else {
        throw new NotFoundError(`Decoded string is not a valid URL: ${decodedString.substring(0, 100)}...`);
      }
    }
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          captions,
          flags: [flags.IP_LOCKED],
          headers: {
            Referer: "https://closeload.top/",
            Origin: "https://closeload.top"
          }
        }
      ]
    };
  }
});
const referer = "https://ridomovies.tv/";
const playlistHeaders = {
  referer: "https://ridoo.net/",
  origin: "https://ridoo.net"
};
const ridooScraper = makeEmbed({
  id: "ridoo",
  name: "Ridoo",
  rank: 121,
  flags: [flags.CORS_ALLOWED],
  async scrape(ctx) {
    var _a;
    const res = await ctx.proxiedFetcher(ctx.url, {
      headers: {
        referer
      }
    });
    const regexPattern = /file:"([^"]+)"/g;
    const url = (_a = regexPattern.exec(res)) == null ? void 0 : _a[1];
    if (!url) throw new NotFoundError("Unable to find source url");
    return {
      stream: [
        {
          id: "primary",
          type: "hls",
          playlist: url,
          headers: playlistHeaders,
          captions: [],
          flags: [flags.CORS_ALLOWED]
        }
      ]
    };
  }
});
const vidCloudScraper = makeEmbed({
  id: "vidcloud",
  name: "VidCloud",
  rank: 201,
  disabled: true,
  flags: [],
  async scrape(ctx) {
    const result = await upcloudScraper.scrape(ctx);
    return {
      stream: result.stream.map((s) => ({
        ...s,
        flags: []
      }))
    };
  }
});
function getValidQualityFromString(quality) {
  switch (quality.toLowerCase().replace("p", "")) {
    case "360":
      return "360";
    case "480":
      return "480";
    case "720":
      return "720";
    case "1080":
      return "1080";
    case "2160":
      return "4k";
    case "4k":
      return "4k";
    default:
      return "unknown";
  }
}
function generateRandomFavs() {
  const randomHex = () => Math.floor(Math.random() * 16).toString(16);
  const generateSegment = (length) => Array.from({ length }, randomHex).join("");
  return `${generateSegment(8)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(
    12
  )}`;
}
function parseSubtitleLinks(inputString) {
  if (!inputString || typeof inputString === "boolean") return [];
  const linksArray = inputString.split(",");
  const captions = [];
  linksArray.forEach((link) => {
    const match = link.match(/\[([^\]]+)\](https?:\/\/\S+?)(?=,\[|$)/);
    if (match) {
      const type = getCaptionTypeFromUrl(match[2]);
      const language = labelToLanguageCode(match[1]);
      if (!type || !language) return;
      captions.push({
        id: match[2],
        language,
        hasCorsRestrictions: false,
        type,
        url: match[2]
      });
    }
  });
  return captions;
}
function parseVideoLinks(inputString) {
  if (!inputString) throw new NotFoundError("No video links found");
  try {
    const qualityMap = {};
    const links = inputString.split(",");
    links.forEach((link) => {
      const match = link.match(/\[([^\]]+)\](https?:\/\/[^\s,]+)/);
      if (match) {
        const [_, quality, url] = match;
        if (url === "null") return;
        const normalizedQuality = quality.replace(/<[^>]+>/g, "").toLowerCase().replace("p", "").trim();
        qualityMap[normalizedQuality] = {
          type: "mp4",
          url: url.trim()
        };
      }
    });
    const result = {};
    Object.entries(qualityMap).forEach(([quality, data]) => {
      const validQuality = getValidQualityFromString(quality);
      result[validQuality] = data;
    });
    return result;
  } catch (error) {
    console.error("Error parsing video links:", error);
    throw new NotFoundError("Failed to parse video links");
  }
}
const rezkaBase = "https://hdrezka.ag/";
const baseHeaders = {
  "X-Hdrezka-Android-App": "1",
  "X-Hdrezka-Android-App-Version": "2.2.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  "CF-IPCountry": "RU"
};
async function searchAndFindMediaId(ctx) {
  const searchData = await ctx.proxiedFetcher(`/engine/ajax/search.php`, {
    baseUrl: rezkaBase,
    headers: baseHeaders,
    query: { q: ctx.media.title }
  });
  const $ = load(searchData);
  const items = $("a").map((_, el) => {
    var _a;
    const $el = $(el);
    const url = $el.attr("href");
    const titleText = $el.find("span.enty").text();
    const yearMatch = titleText.match(/\((\d{4})\)/) || (url == null ? void 0 : url.match(/-(\d{4})(?:-|\.html)/)) || titleText.match(/(\d{4})/);
    const itemYear = yearMatch ? yearMatch[1] : null;
    const id = (_a = url == null ? void 0 : url.match(/\/(\d+)-[^/]+\.html$/)) == null ? void 0 : _a[1];
    if (id) {
      return {
        id,
        year: itemYear ? parseInt(itemYear, 10) : ctx.media.releaseYear,
        type: ctx.media.type,
        url: url || ""
      };
    }
    return null;
  }).get().filter(Boolean);
  items.sort((a, b) => {
    const diffA = Math.abs(a.year - ctx.media.releaseYear);
    const diffB = Math.abs(b.year - ctx.media.releaseYear);
    return diffA - diffB;
  });
  return items[0] || null;
}
async function getStream(id, translatorId, ctx) {
  const searchParams = new URLSearchParams();
  searchParams.append("id", id);
  searchParams.append("translator_id", translatorId);
  if (ctx.media.type === "show") {
    searchParams.append("season", ctx.media.season.number.toString());
    searchParams.append("episode", ctx.media.episode.number.toString());
  }
  searchParams.append("favs", generateRandomFavs());
  searchParams.append("action", ctx.media.type === "show" ? "get_stream" : "get_movie");
  searchParams.append("t", Date.now().toString());
  const response = await ctx.proxiedFetcher("/ajax/get_cdn_series/", {
    baseUrl: rezkaBase,
    method: "POST",
    body: searchParams,
    headers: {
      ...baseHeaders,
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Requested-With": "XMLHttpRequest",
      Referer: `${rezkaBase}films/action/${id}-novokain-2025-latest.html`
    }
  });
  try {
    const data = JSON.parse(response);
    if (!data.url && data.success) {
      throw new NotFoundError("Movie found but no stream available (might be premium or not yet released)");
    }
    if (!data.url) {
      throw new NotFoundError("No stream URL found in response");
    }
    return data;
  } catch (error) {
    console.error("Error parsing stream response:", error);
    throw new NotFoundError("Failed to parse stream response");
  }
}
async function getTranslatorId(url, id, ctx) {
  const response = await ctx.proxiedFetcher(url, {
    headers: baseHeaders
  });
  if (response.includes(`data-translator_id="238"`)) {
    return "238";
  }
  const functionName = ctx.media.type === "movie" ? "initCDNMoviesEvents" : "initCDNSeriesEvents";
  const regexPattern = new RegExp(`sof\\.tv\\.${functionName}\\(${id}, ([^,]+)`, "i");
  const match = response.match(regexPattern);
  const translatorId = match ? match[1] : null;
  return translatorId;
}
const universalScraper$1 = async (ctx) => {
  const result = await searchAndFindMediaId(ctx);
  if (!result || !result.id) throw new NotFoundError("No result found");
  const translatorId = await getTranslatorId(result.url, result.id, ctx);
  if (!translatorId) throw new NotFoundError("No translator id found");
  const { url: streamUrl, subtitle: streamSubtitle } = await getStream(result.id, translatorId, ctx);
  const parsedVideos = parseVideoLinks(streamUrl);
  const parsedSubtitles = parseSubtitleLinks(streamSubtitle);
  ctx.progress(90);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        type: "file",
        flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
        captions: parsedSubtitles,
        qualities: parsedVideos
      }
    ]
  };
};
const hdRezkaScraper = makeSourcerer({
  id: "hdrezka",
  name: "HDRezka",
  rank: 105,
  disabled: true,
  flags: [flags.CORS_ALLOWED, flags.IP_LOCKED],
  scrapeShow: universalScraper$1,
  scrapeMovie: universalScraper$1
});
function normalizeTitle(title) {
  let titleTrimmed = title.trim().toLowerCase();
  if (titleTrimmed !== "the movie" && titleTrimmed.endsWith("the movie")) {
    titleTrimmed = titleTrimmed.replace("the movie", "");
  }
  if (titleTrimmed !== "the series" && titleTrimmed.endsWith("the series")) {
    titleTrimmed = titleTrimmed.replace("the series", "");
  }
  return titleTrimmed.replace(/['":]/g, "").replace(/[^a-zA-Z0-9]+/g, "_");
}
function compareTitle(a, b) {
  return normalizeTitle(a) === normalizeTitle(b);
}
function compareMedia(media, title, releaseYear) {
  const isSameYear = releaseYear === void 0 ? true : media.releaseYear === releaseYear;
  return compareTitle(media.title, title) && isSameYear;
}
async function getVideoSources(ctx, id, media, hash, expires) {
  let path = "";
  let query = { expand: "streams,subtitles", id };
  let fetcher = ctx.proxiedFetcher;
  let customBaseUrl = baseUrl;
  if (media.type === "show" && hash && expires) {
    path = `/api/v1/security/episode-access`;
    query = { id_episode: id, hash, expires };
    customBaseUrl = "https://www.lookmovie2.to";
    if (ctx.browserFetcher) fetcher = ctx.browserFetcher;
  } else if (media.type === "show") {
    path = `/v1/episodes/view`;
  } else if (media.type === "movie") {
    path = `/v1/movies/view`;
  }
  const data = await fetcher(path, {
    baseUrl: customBaseUrl,
    query
  });
  return data;
}
async function getVideo(ctx, id, media, hash, expires) {
  const data = await getVideoSources(ctx, id, media, hash, expires);
  const videoSources = data.streams;
  if (!videoSources || typeof videoSources !== "object") {
    return {
      playlist: null,
      captions: []
    };
  }
  const opts = ["auto", "1080p", "1080", "720p", "720", "480p", "480", "240p", "240", "360p", "360", "144", "144p"];
  let videoUrl = null;
  for (const res of opts) {
    if (videoSources[res] && !videoUrl) {
      videoUrl = videoSources[res];
    }
  }
  let captions = [];
  if (data.subtitles && Array.isArray(data.subtitles)) {
    for (const sub of data.subtitles) {
      const language = labelToLanguageCode(sub.language);
      if (!language) continue;
      captions.push({
        id: sub.url,
        type: "vtt",
        url: `${baseUrl}${sub.url}`,
        hasCorsRestrictions: false,
        language
      });
    }
    captions = removeDuplicatedLanguages(captions);
  }
  return {
    playlist: videoUrl,
    captions
  };
}
const baseUrl = "https://lmscript.xyz";
async function searchAndFindMedia(ctx, media) {
  if (media.type === "show") {
    const searchRes = await ctx.proxiedFetcher(`/v1/shows`, {
      baseUrl,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
  if (media.type === "movie") {
    const searchRes = await ctx.proxiedFetcher(`/v1/movies`, {
      baseUrl,
      query: { "filters[q]": media.title }
    });
    const results = searchRes.items;
    const result = results.find((res) => compareMedia(media, res.title, Number(res.year)));
    return result;
  }
}
async function scrape(ctx, media, result) {
  var _a;
  let id = null;
  if (media.type === "movie") {
    id = result.id_movie;
  } else if (media.type === "show") {
    const data = await ctx.proxiedFetcher(`/v1/shows`, {
      baseUrl,
      query: { expand: "episodes", id: result.id_show }
    });
    const episode = (_a = data.episodes) == null ? void 0 : _a.find((v) => {
      return Number(v.season) === Number(media.season.number) && Number(v.episode) === Number(media.episode.number);
    });
    if (episode) id = episode.id;
  }
  if (id === null) throw new NotFoundError("Not found");
  let hash = null;
  let expires = null;
  if (media.type === "show" && ctx.browserFetcher) {
    const maxRetries = 2;
    let retryCount = 0;
    while (retryCount <= maxRetries && !hash) {
      try {
        const officialUrl = `https://www.lookmovie2.to/shows/play/${result.slug}`;
        const pageHtml = await ctx.browserFetcher(officialUrl);
        const patterns = [
          // Pattern 1: JSON-like assignment (hash: "value", expires: 123)
          {
            name: "JSON assignment",
            hashRegex: /hash\s*[:=]\s*["']([^"']+)["']/,
            expiresRegex: /expires\s*[:=]\s*(\d+)/
          },
          // Pattern 2: URL query params (hash=value&expires=123)
          {
            name: "URL params",
            hashRegex: /hash=([^&"'\s]+)/,
            expiresRegex: /expires=(\d+)/
          },
          // Pattern 3: data-hash and data-expires attributes
          {
            name: "data attributes",
            hashRegex: /data-hash=["']([^"']+)["']/,
            expiresRegex: /data-expires=["']?(\d+)["']?/
          },
          // Pattern 4: Variable assignments (var hash = "...", var expires = ...)
          {
            name: "variable assignment",
            hashRegex: /(?:var|let|const)\s+hash\s*=\s*["']([^"']+)["']/,
            expiresRegex: /(?:var|let|const)\s+expires\s*=\s*(\d+)/
          }
        ];
        for (const pattern of patterns) {
          if (hash) break;
          const hashMatch = pageHtml.match(pattern.hashRegex);
          const expiresMatch = pageHtml.match(pattern.expiresRegex);
          if (hashMatch && expiresMatch) {
            const foundHash = hashMatch[1];
            const foundExpires = expiresMatch[1];
            const expiryTime = parseInt(foundExpires, 10);
            const now = Math.floor(Date.now() / 1e3);
            if (expiryTime > now) {
              hash = foundHash;
              expires = foundExpires;
              break;
            }
          }
        }
        if (!hash) {
          retryCount++;
          if (retryCount <= maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, 1e3));
          }
        }
      } catch (e) {
        retryCount++;
        if (retryCount <= maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1e3));
        }
      }
    }
  }
  const video = await getVideo(ctx, id, media, hash, expires);
  return video;
}
async function universalScraper(ctx) {
  const lookmovieData = await searchAndFindMedia(ctx, ctx.media);
  if (!lookmovieData) throw new NotFoundError("Media not found");
  ctx.progress(30);
  const video = await scrape(ctx, ctx.media, lookmovieData);
  if (!video.playlist) throw new NotFoundError("No video found");
  ctx.progress(60);
  return {
    embeds: [],
    stream: [
      {
        id: "primary",
        playlist: video.playlist,
        type: "hls",
        flags: [flags.IP_LOCKED],
        captions: video.captions
      }
    ]
  };
}
const lookmovieScraper = makeSourcerer({
  id: "lookmovie",
  name: "Iron",
  disabled: false,
  rank: 300,
  flags: [flags.IP_LOCKED],
  scrapeShow: universalScraper,
  scrapeMovie: universalScraper
});
const SHOWBOX_API_BASE = "https://feb-api.vidninja.pro/api/media";
const API_KEY = "6c0a40d6-bde5-4eaa-a18a-b56220cdbb2c";
const WORKING_HEADERS$1 = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  Accept: "application/json",
  "Accept-Language": "en-GB,en-US;q=0.9,en;q=0.8",
  "Accept-Encoding": "gzip, deflate, br, zstd",
  "Content-Type": "application/json"
};
function processLink(link, streams) {
  if (!link.url) return;
  const qualityStr = link.quality || "Unknown";
  const streamId = `showbox-${Math.random().toString(36).substring(2, 9)}`;
  const displayName = `${generateCodename(0)} ${qualityStr}`;
  streams.push({
    id: streamId,
    type: "file",
    url: link.url,
    // For backup
    flags: [flags.CORS_ALLOWED],
    qualities: {
      unknown: {
        type: "mp4",
        url: link.url
      }
    },
    headers: {
      Referer: "https://feb-api.vidninja.pro/",
      Origin: "https://feb-api.vidninja.pro"
    },
    displayName
  });
  console.log(`[ShowBox] Added stream: ${displayName}`);
}
function processShowBoxResponse(data, _ctx) {
  const streams = [];
  try {
    if (!data || !data.success) {
      console.log("[ShowBox] API returned unsuccessful response");
      return streams;
    }
    if (data.versions && Array.isArray(data.versions)) {
      console.log(`[ShowBox] Processing ${data.versions.length} version(s)`);
      data.versions.forEach((version) => {
        if (version.links && Array.isArray(version.links)) {
          version.links.forEach((link) => processLink(link, streams));
        }
      });
    } else if (data.file && data.file.links && Array.isArray(data.file.links)) {
      console.log(`[ShowBox] Processing file links`);
      data.file.links.forEach((link) => processLink(link, streams));
    } else {
      console.log("[ShowBox] No versions or file links found in API response");
    }
  } catch (error) {
    console.error(`[ShowBox] Error processing response: ${error.message}`);
  }
  return streams;
}
async function scrapeShowbox(ctx) {
  const { media } = ctx;
  let apiUrl;
  if (media.type === "show") {
    apiUrl = `${SHOWBOX_API_BASE}/tv/${media.tmdbId}/${media.season.number}/${media.episode.number}?apiKey=${API_KEY}`;
  } else {
    apiUrl = `${SHOWBOX_API_BASE}/movie/${media.tmdbId}?apiKey=${API_KEY}`;
  }
  const maxRetries = 2;
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await ctx.fetcher(apiUrl, {
        headers: WORKING_HEADERS$1
      });
      const streams = processShowBoxResponse(response, ctx);
      if (streams.length === 0) {
        throw new NotFoundError("No streams found");
      }
      streams.sort((a, b) => (b.displayName || "").localeCompare(a.displayName || ""));
      return {
        embeds: [],
        stream: streams
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
  throw new NotFoundError(`ShowBox API failed: ${(lastError == null ? void 0 : lastError.message) || "Unknown error"}`);
}
const showboxScraper = makeSourcerer({
  id: "showbox",
  name: "Box",
  rank: 190,
  flags: [flags.CORS_ALLOWED],
  disabled: true,
  scrapeMovie: scrapeShowbox,
  scrapeShow: scrapeShowbox
});
const VIDEASY_API = "https://enc-dec.app/api";
const SERVERS = {
  Neon: {
    url: "https://api.videasy.net/myflixerzupcloud/sources-with-title",
    language: "Original"
  },
  Sage: {
    url: "https://api.videasy.net/1movies/sources-with-title",
    language: "Original"
  },
  Cypher: {
    url: "https://api.videasy.net/moviebox/sources-with-title",
    language: "Original"
  },
  Yoru: {
    url: "https://api.videasy.net/cdn/sources-with-title",
    language: "Original",
    moviesOnly: true
  },
  Reyna: {
    url: "https://api2.videasy.net/primewire/sources-with-title",
    language: "Original"
  },
  Omen: {
    url: "https://api.videasy.net/onionplay/sources-with-title",
    language: "Original"
  },
  Breach: {
    url: "https://api.videasy.net/m4uhd/sources-with-title",
    language: "Original"
  },
  Vyse: {
    url: "https://api.videasy.net/hdmovie/sources-with-title",
    language: "Original"
  }
};
function buildVideoEasyUrl(serverConfig, mediaType, title, year, tmdbId, imdbId, seasonId, episodeId) {
  const params = {
    title,
    mediaType,
    year,
    tmdbId,
    imdbId
  };
  if (serverConfig.params) {
    Object.assign(params, serverConfig.params);
  }
  if (mediaType === "tv" && seasonId && episodeId) {
    params.seasonId = seasonId.toString();
    params.episodeId = episodeId.toString();
  }
  const queryString = Object.entries(params).map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join("&");
  return `${serverConfig.url}?${queryString}`;
}
async function decryptVideoEasy(encryptedText, tmdbId, fetcher) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 1e4);
    const response = await fetch(`${VIDEASY_API}/dec-videasy`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ text: encryptedText, id: tmdbId }),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return { sources: [] };
    }
    const data = await response.json();
    if (data && typeof data === "object" && "error" in data) {
      return { sources: [] };
    }
    if (data && typeof data === "object") {
      if ("result" in data && data.result) {
        return data.result;
      }
      if ("sources" in data) {
        return data;
      }
    }
    return { sources: [] };
  } catch (error) {
    return { sources: [] };
  }
}
function extractQualityFromUrl(url) {
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
  if (url.includes("MTA4MA")) return "1080p";
  if (url.includes("NzIw")) return "720p";
  if (url.includes("NDgw")) return "480p";
  if (url.includes("MzYw")) return "360p";
  if (url.includes("MjE2MA")) return "4k";
  if (url.includes("1080") || url.includes("1920")) return "1080p";
  if (url.includes("720") || url.includes("1280")) return "720p";
  if (url.includes("480") || url.includes("854")) return "480p";
  if (url.includes("360") || url.includes("640")) return "360p";
  return "unknown";
}
async function fetchFromServer(serverName, serverConfig, title, year, mediaType, tmdbId, imdbId, fetcher, seasonId, episodeId) {
  if (mediaType === "tv" && serverConfig.moviesOnly) {
    return { embeds: [], stream: [] };
  }
  const url = buildVideoEasyUrl(serverConfig, mediaType, title, year, tmdbId, imdbId, seasonId, episodeId);
  try {
    const encryptedData = await fetcher(url, {
      method: "GET"
    });
    if (!encryptedData || typeof encryptedData !== "string" || encryptedData.trim() === "") {
      return { embeds: [], stream: [] };
    }
    const decryptedData = await decryptVideoEasy(encryptedData, tmdbId, fetcher);
    if (!decryptedData || !decryptedData.sources || decryptedData.sources.length === 0) {
      return { embeds: [], stream: [] };
    }
    const streams = decryptedData.sources.filter((source) => source.url).filter((source) => {
      const sourceUrl = source.url.toLowerCase();
      const isWorkerUrl = sourceUrl.includes(".workers.dev");
      const isDirectUrl = sourceUrl.includes("main-mp4.ronaldburker.workers.dev");
      if (isDirectUrl) {
        return false;
      }
      if (isWorkerUrl) {
        return true;
      }
      return false;
    }).map((source) => {
      let quality = source.quality || extractQualityFromUrl(source.url);
      if (quality === "unknown" && source.url.includes(".m3u8")) {
        quality = "auto";
      }
      const isHLS = source.url.includes(".m3u8");
      const mapQuality2 = (q) => {
        if (q === "360" || q === "360p") return "360";
        if (q === "480" || q === "480p") return "480";
        if (q === "720" || q === "720p") return "720";
        if (q === "1080" || q === "1080p") return "1080";
        if (q === "4k" || q === "2160" || q === "2160p") return "4k";
        return "unknown";
      };
      if (isHLS) {
        return {
          id: `Blade-${serverName}-${quality !== "unknown" && quality !== "auto" ? quality : "Auto"}`,
          type: "hls",
          playlist: source.url,
          flags: [],
          captions: [],
          headers: {
            Referer: "https://videasy.net/"
          }
        };
      }
      const qualityKey = mapQuality2(quality);
      return {
        id: `Blade-${serverName}-${quality}`,
        type: "file",
        flags: [],
        captions: [],
        qualities: {
          [qualityKey]: {
            type: "mp4",
            url: source.url
          }
        },
        headers: {
          Referer: "https://videasy.net/"
        }
      };
    });
    return {
      embeds: [],
      stream: streams
    };
  } catch (error) {
    return { embeds: [], stream: [] };
  }
}
async function comboScraper$1(ctx) {
  const { media, fetcher } = ctx;
  const tmdbId = media.tmdbId;
  const mediaType = media.type === "show" ? "tv" : "movie";
  const title = media.title;
  const year = media.releaseYear.toString();
  const imdbId = media.imdbId || `tt${tmdbId}`;
  const seasonId = media.type === "show" ? media.season.number : void 0;
  const episodeId = media.type === "show" ? media.episode.number : void 0;
  const fetchWithTimeout = async (serverName, serverConfig) => {
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
          episodeId
        );
        return result;
      })(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${serverName} timeout`)), 15e3))
    ]).catch((err) => {
      return { embeds: [], stream: [] };
    });
  };
  const serverPromises = Object.entries(SERVERS).map(
    ([serverName, serverConfig]) => fetchWithTimeout(serverName, serverConfig)
  );
  const results = await Promise.all(serverPromises);
  const allStreams = results.flatMap((result) => result.stream || []);
  if (allStreams.length === 0) {
    throw new NotFoundError("No streams found");
  }
  const uniqueStreams = allStreams.filter((stream, index, self) => {
    return index === self.findIndex((s) => {
      var _a, _b;
      if (s.type === "hls" && stream.type === "hls") {
        return s.playlist === stream.playlist;
      }
      if (s.type === "file" && stream.type === "file") {
        const sUrl = (_a = Object.values(s.qualities)[0]) == null ? void 0 : _a.url;
        const streamUrl = (_b = Object.values(stream.qualities)[0]) == null ? void 0 : _b.url;
        return sUrl === streamUrl;
      }
      return false;
    });
  });
  return {
    embeds: [],
    stream: uniqueStreams
  };
}
const videoeasyScraper = makeSourcerer({
  id: "videoeasy",
  name: "Blade",
  rank: 200,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: comboScraper$1,
  scrapeShow: comboScraper$1
});
const ENC_DEC_API = "https://enc-dec.app/api";
const VIDLINK_API = "https://vidlink.pro/api/b";
const VIDLINK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
  Referer: "https://vidlink.pro/",
  Origin: "https://vidlink.pro"
};
function mapQuality(qualityStr) {
  if (!qualityStr) return "unknown";
  const quality = qualityStr.toLowerCase();
  if (quality.includes("2160") || quality.includes("4k")) return "4k";
  if (quality.includes("1080") || quality.includes("fhd")) return "1080";
  if (quality.includes("720") || quality.includes("hd")) return "720";
  if (quality.includes("480") || quality.includes("sd")) return "480";
  if (quality.includes("360")) return "360";
  const match = qualityStr.match(/(\d{3,4})[pP]?/);
  if (match) {
    const resolution = parseInt(match[1], 10);
    if (resolution >= 2160) return "4k";
    if (resolution >= 1080) return "1080";
    if (resolution >= 720) return "720";
    if (resolution >= 480) return "480";
    if (resolution >= 360) return "360";
  }
  return "unknown";
}
async function encryptTmdbId(tmdbId) {
  try {
    const response = await fetch(`${ENC_DEC_API}/enc-vidlink?text=${tmdbId}`);
    if (!response.ok) {
      throw new NotFoundError("Vidlink encryption service unavailable");
    }
    const data = await response.json();
    if (data.error) {
      throw new NotFoundError("Vidlink encryption failed");
    }
    if (data && data.result) {
      return data.result;
    }
    throw new NotFoundError("Invalid encryption response");
  } catch (error) {
    if (error instanceof NotFoundError) throw error;
    throw new NotFoundError("Failed to encrypt TMDB ID for Vidlink");
  }
}
function parseM3U8(content, baseUrl2) {
  const lines = content.split("\n").map((line) => line.trim()).filter((line) => line);
  const streams = [];
  let currentStream = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      currentStream = { resolution: null, url: "" };
      const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
      if (resolutionMatch) {
        currentStream.resolution = resolutionMatch[1];
      }
    } else if (currentStream && !line.startsWith("#")) {
      if (line.startsWith("http")) {
        currentStream.url = line;
      } else {
        try {
          currentStream.url = new URL(line, baseUrl2).toString();
        } catch {
          currentStream.url = line;
        }
      }
      streams.push(currentStream);
      currentStream = null;
    }
  }
  return streams;
}
function getQualityFromResolution(resolution) {
  if (!resolution) return "unknown";
  const [, height] = resolution.split("x").map(Number);
  if (height >= 2160) return "4k";
  if (height >= 1080) return "1080";
  if (height >= 720) return "720";
  if (height >= 480) return "480";
  if (height >= 360) return "360";
  return "unknown";
}
function fixVidlinkUrl(url) {
  if (!url) return url;
  return url.replace("stormvv.vodvidl.site", "storm.vodvidl.site");
}
async function processVidlinkResponse(data, ctx) {
  if (data.error) {
    throw new NotFoundError(`Vidlink API error: ${data.error}`);
  }
  const hlsStreams = [];
  const fileQualities = {};
  if (data.stream && data.stream.type === "hls" && data.stream.playlist) {
    const playlistUrl = fixVidlinkUrl(data.stream.playlist);
    try {
      const m3u8Response = await ctx.proxiedFetcher(playlistUrl, {
        headers: VIDLINK_HEADERS
      });
      const parsedStreams = parseM3U8(m3u8Response, playlistUrl);
      if (parsedStreams.length > 0) {
        parsedStreams.forEach((stream, index) => {
          const quality = getQualityFromResolution(stream.resolution);
          hlsStreams.push({
            id: `vidlink-${quality}-${index}`,
            displayName: generateCodename(index),
            type: "hls",
            playlist: fixVidlinkUrl(stream.url),
            flags: [flags.CORS_ALLOWED],
            captions: [],
            headers: VIDLINK_HEADERS
          });
        });
      } else {
        hlsStreams.push({
          id: "vidlink-primary",
          displayName: generateCodename(0),
          type: "hls",
          playlist: playlistUrl,
          flags: [flags.CORS_ALLOWED],
          captions: [],
          headers: VIDLINK_HEADERS
        });
      }
    } catch {
      hlsStreams.push({
        id: "vidlink-primary",
        displayName: generateCodename(0),
        type: "hls",
        playlist: playlistUrl,
        flags: [flags.CORS_ALLOWED],
        captions: [],
        headers: VIDLINK_HEADERS
      });
    }
  } else if (data.stream && data.stream.qualities) {
    Object.entries(data.stream.qualities).forEach(([qualityKey, qualityData]) => {
      if (qualityData.url) {
        const quality = mapQuality(qualityKey);
        fileQualities[quality] = {
          type: "mp4",
          url: fixVidlinkUrl(qualityData.url)
        };
      }
    });
  } else if (data.url) {
    fileQualities.unknown = {
      type: "mp4",
      url: fixVidlinkUrl(data.url)
    };
  } else if (data.streams && Array.isArray(data.streams)) {
    data.streams.forEach((stream) => {
      if (stream.url) {
        const quality = mapQuality(stream.quality || "unknown");
        fileQualities[quality] = {
          type: "mp4",
          url: fixVidlinkUrl(stream.url)
        };
      }
    });
  } else if (data.links && Array.isArray(data.links)) {
    data.links.forEach((link) => {
      if (link.url) {
        const quality = mapQuality(link.quality || "unknown");
        fileQualities[quality] = {
          type: "mp4",
          url: fixVidlinkUrl(link.url)
        };
      }
    });
  }
  const streams = [];
  if (Object.keys(fileQualities).length > 0) {
    streams.push({
      id: "vidlink-file",
      displayName: generateCodename(0),
      type: "file",
      flags: [flags.CORS_ALLOWED],
      captions: [],
      qualities: fileQualities,
      headers: VIDLINK_HEADERS
    });
  }
  streams.push(...hlsStreams);
  if (streams.length === 0) {
    throw new NotFoundError("No streams found");
  }
  return {
    embeds: [],
    stream: streams
  };
}
async function scrapeVidlink(ctx) {
  const { media } = ctx;
  const mediaType = media.type;
  const encryptedId = await encryptTmdbId(media.tmdbId);
  let vidlinkUrl;
  if (mediaType === "show") {
    vidlinkUrl = `${VIDLINK_API}/tv/${encryptedId}/${media.season.number}/${media.episode.number}`;
  } else {
    vidlinkUrl = `${VIDLINK_API}/movie/${encryptedId}`;
  }
  let rawResponse;
  try {
    rawResponse = await ctx.proxiedFetcher(vidlinkUrl, {
      headers: VIDLINK_HEADERS
    });
  } catch (error) {
    console.error(`[Vidlink] Request failed: ${error.message}`);
    throw new NotFoundError("Vidlink API request failed");
  }
  let response;
  if (typeof rawResponse === "string") {
    try {
      response = JSON.parse(rawResponse);
    } catch {
      throw new NotFoundError("Invalid Vidlink API response");
    }
  } else {
    response = rawResponse;
  }
  if (!response || !response.stream && !response.url && !response.streams && !response.links) {
    throw new NotFoundError("No stream data in Vidlink response");
  }
  return processVidlinkResponse(response, ctx);
}
const vidlinkScraper = makeSourcerer({
  id: "vidlink",
  name: "Storm",
  rank: 100,
  disabled: false,
  flags: [flags.CORS_ALLOWED],
  scrapeMovie: scrapeVidlink,
  scrapeShow: scrapeVidlink
});
const VIDROCK_BASE_URL = "https://vidrock.net";
const PASSPHRASE = "x7k9mPqT2rWvY8zA5bC3nF6hJ2lK4mN9";
const WORKING_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://vidrock.net/",
  Origin: "https://vidrock.net"
};
const PLAYBACK_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
  Referer: "https://vidrock.net/",
  Origin: "https://vidrock.net"
};
async function encryptAesCbc(text, passphrase) {
  try {
    const key = CryptoJS.enc.Utf8.parse(passphrase);
    const iv = CryptoJS.enc.Utf8.parse(passphrase.slice(0, 16));
    const encrypted = CryptoJS.AES.encrypt(text, key, {
      iv,
      mode: CryptoJS.mode.CBC,
      padding: CryptoJS.pad.Pkcs7
    });
    return encrypted.toString();
  } catch (error) {
    throw new NotFoundError(`Encryption failed: ${error instanceof Error ? error.message : "Unknown error"}`);
  }
}
function extractQuality(url) {
  if (!url) return "Unknown";
  const qualityPatterns = [/(\d{3,4})p/i, /(\d{3,4})x\d{3,4}/i];
  for (const pattern of qualityPatterns) {
    const match = url.match(pattern);
    if (match) {
      const qualityNum = parseInt(match[1], 10);
      if (qualityNum >= 240 && qualityNum <= 4320) {
        return `${qualityNum}p`;
      }
    }
  }
  if (url.includes("1080") || url.includes("1920")) return "1080p";
  if (url.includes("720") || url.includes("1280")) return "720p";
  if (url.includes("480")) return "480p";
  if (url.includes("360")) return "360p";
  return "Unknown";
}
async function processVidrockResponse(data, fetcher) {
  const streams = [];
  if (!data || typeof data !== "object") {
    return streams;
  }
  for (const serverName of Object.keys(data)) {
    const source = data[serverName];
    if (!source || !source.url || source.url === null) {
      continue;
    }
    const videoUrl = source.url;
    if ((serverName === "Atlas" || serverName === "Astra") && videoUrl.includes("cdn.vidrock.store/playlist/")) {
      continue;
    }
    if ((serverName === "Atlas" || serverName === "Astra") && videoUrl.includes("cdn.vidrock.store/playlist/")) {
      try {
        const playlistResponse = await fetcher.full(videoUrl, {
          headers: PLAYBACK_HEADERS
        });
        const playlistData = typeof playlistResponse.body === "string" ? JSON.parse(playlistResponse.body) : playlistResponse.body;
        if (Array.isArray(playlistData)) {
          const qualities = {};
          playlistData.forEach((item) => {
            if (item.url && item.resolution) {
              const quality2 = `${item.resolution}p`;
              qualities[quality2] = {
                type: "mp4",
                url: item.url
              };
            }
          });
          if (Object.keys(qualities).length > 0) {
            streams.push({
              id: serverName.toLowerCase(),
              url: "",
              // Not used for file type
              quality: "multi",
              // Multiple qualities
              qualities,
              // TypeScript: this field exists in final output
              headers: PLAYBACK_HEADERS
            });
          }
        }
      } catch (error) {
      }
      continue;
    }
    let quality = extractQuality(videoUrl);
    const hasValidExtension = videoUrl.includes(".m3u8") || videoUrl.includes(".mp4") || videoUrl.includes(".mkv") || videoUrl.includes(".mpd") || videoUrl.includes("workers.dev");
    if (!hasValidExtension) {
      continue;
    }
    const isWorkerUrl = videoUrl.includes("workers.dev") || videoUrl.includes("storm.gemlelispe");
    const isProxyUrl = videoUrl.includes("proxy.vidrock.store");
    if (isWorkerUrl || isProxyUrl) {
      continue;
    }
    const isHLS = source.type === "hls" || videoUrl.includes(".m3u8");
    if (quality === "Unknown" && isHLS) {
      quality = "Adaptive";
    }
    streams.push({
      id: serverName.toLowerCase(),
      url: videoUrl,
      quality,
      headers: PLAYBACK_HEADERS
    });
  }
  return streams;
}
async function comboScraper(ctx) {
  const mediaType = ctx.media.type === "movie" ? "movie" : "tv";
  let itemId;
  if (ctx.media.type === "show") {
    itemId = `${ctx.media.tmdbId}_${ctx.media.season.number}_${ctx.media.episode.number}`;
  } else {
    itemId = ctx.media.tmdbId;
  }
  ctx.progress(25);
  const encryptedId = await encryptAesCbc(itemId, PASSPHRASE);
  const urlSafeId = encryptedId.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  ctx.progress(50);
  const apiUrl = `${VIDROCK_BASE_URL}/api/${mediaType}/${urlSafeId}`;
  const response = await ctx.fetcher(apiUrl, { headers: WORKING_HEADERS });
  let parsedResponse = response;
  if (typeof response === "string") {
    if (response.includes("<!DOCTYPE") || response.includes("<html")) {
      throw new NotFoundError("Vidrock API returned HTML error page");
    }
    try {
      parsedResponse = JSON.parse(response);
    } catch (e) {
      throw new NotFoundError(`Invalid JSON response from Vidrock: ${response.substring(0, 100)}`);
    }
  }
  if (!parsedResponse) {
    throw new NotFoundError("No response from Vidrock API");
  }
  ctx.progress(75);
  const streamData = await processVidrockResponse(parsedResponse, ctx.fetcher);
  if (streamData.length === 0) {
    throw new NotFoundError("No streams found");
  }
  ctx.progress(100);
  const streams = streamData.map((stream) => {
    if (stream.qualities) {
      return {
        id: stream.id,
        type: "file",
        qualities: stream.qualities,
        headers: stream.headers,
        flags: [],
        captions: []
      };
    }
    const isWorkerUrl = stream.url.includes("workers.dev") || stream.url.includes("storm.gemlelispe");
    const isHLS = stream.url.includes(".m3u8") || isWorkerUrl;
    if (isHLS) {
      return {
        id: stream.id,
        type: "hls",
        playlist: stream.url,
        headers: stream.headers,
        flags: [],
        captions: []
      };
    }
    return {
      id: stream.id,
      type: "file",
      qualities: {
        [stream.quality]: {
          type: "mp4",
          url: stream.url
        }
      },
      headers: stream.headers,
      flags: [],
      captions: []
    };
  });
  return {
    embeds: [],
    stream: streams
  };
}
const vidrockScraper = makeSourcerer({
  id: "vidrock",
  name: "Helix",
  rank: 250,
  disabled: true,
  flags: [],
  scrapeMovie: comboScraper,
  scrapeShow: comboScraper
});
const decoders = {
  /** Reverse chunks of 3 characters */
  decoder1: (content) => {
    const chunkSize = 3;
    const chunks = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.substring(i, Math.min(i + chunkSize, content.length)));
    }
    return chunks.reverse().join("");
  },
  /** XOR with key + shift, then base64 decode */
  decoder2: (content) => {
    const key = "pWB9V)[*4I`nJpp?ozyB~dbr9yt!_n4u".split("").map((c) => c.charCodeAt(0));
    const shift = 3;
    const bytes = (content.match(/.{2}/g) || []).map((hex) => parseInt(hex, 16));
    const decrypted = bytes.map((v, i) => (v ^ key[i % key.length]) - shift);
    return Buffer.from(String.fromCharCode(...decrypted), "base64").toString("utf-8");
  },
  /** ROT13 then base64 decode */
  decoder3: (content) => {
    const rot13 = content.split("").map((ch) => {
      if (/[a-mA-M]/.test(ch)) return String.fromCharCode(ch.charCodeAt(0) + 13);
      if (/[n-zN-Z]/.test(ch)) return String.fromCharCode(ch.charCodeAt(0) - 13);
      return ch;
    });
    return Buffer.from(rot13.join(""), "base64").toString("utf-8");
  },
  /** Reverse, take every other char, then base64 decode */
  decoder4: (content) => {
    const reversed = content.split("").reverse().join("");
    const filtered = Array.from(reversed).filter((_, i) => i % 2 === 0).join("");
    return Buffer.from(filtered, "base64").toString("utf-8");
  },
  /** Reverse, shift -1, hex pairs to chars */
  decoder5: (content) => {
    try {
      const reversed = content.split("").reverse().join("");
      const shifted = Array.from(reversed).map((char) => String.fromCharCode(char.charCodeAt(0) - 1)).join("");
      const hexPairs = shifted.match(/.{1,2}/g) || [];
      const decoded = hexPairs.map((pair) => {
        const code = parseInt(pair, 16);
        return Number.isNaN(code) ? "" : String.fromCharCode(code);
      }).join("");
      return decoded;
    } catch (e) {
      return "";
    }
  },
  /** Reverse, shift -1, hex pairs */
  decoder6: (content) => {
    const bytes = Array.from(content).reverse().map((ch) => ch.charCodeAt(0) - 1);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 2) {
      chunks.push(parseInt(String.fromCharCode(bytes[i], bytes[i + 1]), 16));
    }
    return Buffer.from(chunks).toString("utf8");
  },
  /** Slice, base64 decode, XOR with key */
  decoder7: (content) => {
    const sliced = content.slice(10, -16);
    const key = '3SAY~#%Y(V%>5d/Yg"$G[Lh1rK4a;7ok'.split("").map((ch) => ch.charCodeAt(0));
    const decoded = Buffer.from(sliced, "base64").toString("binary");
    const bytes = decoded.split("").map((ch) => ch.charCodeAt(0));
    const decrypted = bytes.map((v, i) => v ^ key[i % key.length]);
    return String.fromCharCode(...decrypted);
  },
  /** Character substitution cipher */
  decoder8: (content) => {
    const substitutionMap = {
      x: "a",
      y: "b",
      z: "c",
      a: "d",
      b: "e",
      c: "f",
      d: "g",
      e: "h",
      f: "i",
      g: "j",
      h: "k",
      i: "l",
      j: "m",
      k: "n",
      l: "o",
      m: "p",
      n: "q",
      o: "r",
      p: "s",
      q: "t",
      r: "u",
      s: "v",
      t: "w",
      u: "x",
      v: "y",
      w: "z",
      X: "A",
      Y: "B",
      Z: "C",
      A: "D",
      B: "E",
      C: "F",
      D: "G",
      E: "H",
      F: "I",
      G: "J",
      H: "K",
      I: "L",
      J: "M",
      K: "N",
      L: "O",
      M: "P",
      N: "Q",
      O: "R",
      P: "S",
      Q: "T",
      R: "U",
      S: "V",
      T: "W",
      U: "X",
      V: "Y",
      W: "Z"
    };
    return Array.from(content).map((char) => substitutionMap[char] || char).join("");
  },
  /** Reverse, base64url decode, shift by N */
  decoder9: (shift) => (content) => {
    const normalized = content.split("").reverse().map((ch) => ch === "-" ? "+" : ch === "_" ? "/" : ch).join("");
    const decoded = Buffer.from(normalized, "base64").toString("binary");
    const shifted = decoded.split("").map((ch) => ch.charCodeAt(0) - shift);
    return String.fromCharCode(...shifted);
  }
};
const DECODER_MAP = {
  NdonQLf1Tzyx7bMG: decoders.decoder1,
  sXnL9MQIry: decoders.decoder2,
  IhWrImMIGL: decoders.decoder3,
  KJHidj7det: decoders.decoder7,
  Oi3v1dAlaM: decoders.decoder9(5),
  TsA2KGDGux: decoders.decoder9(7),
  JoAHUMCLXV: decoders.decoder9(3),
  eSfH1IRMyL: decoders.decoder6,
  o2VSUnjnZl: decoders.decoder8,
  xTyBxQyGTA: decoders.decoder4,
  ux8qjPHC66: decoders.decoder5
};
function decodeStreamUrl(decoderId, content) {
  const primaryDecoder = DECODER_MAP[decoderId];
  if (primaryDecoder) {
    try {
      const decoded = primaryDecoder(content);
      if (decoded && (decoded.includes("http") || decoded.includes(".m3u8"))) {
        return decoded;
      }
    } catch {
    }
  }
  for (const [id, decoder] of Object.entries(DECODER_MAP)) {
    if (id === decoderId) continue;
    try {
      const decoded = decoder(content);
      if (decoded && (decoded.includes("http") || decoded.includes(".m3u8"))) {
        return decoded;
      }
    } catch {
    }
  }
  return null;
}
function extractDecoderParams(html) {
  const paramsRe = /<div id="([^"]+)" style="display:none;">([^<]+)<\/div>/;
  const match = html.match(paramsRe);
  if (!match) {
    return null;
  }
  return { id: match[1], content: match[2] };
}
const cookieJar = new CookieJar();
async function fetchWithHeaders(url, options = {}) {
  const { referer: referer2, origin: origin2, retries = 3, delay = 2e3 } = options;
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.5",
    "Accept-Encoding": "gzip, deflate, br",
    DNT: "1",
    Connection: "keep-alive",
    "Upgrade-Insecure-Requests": "1",
    "Sec-Fetch-Dest": "document",
    "Sec-Fetch-Mode": "navigate",
    "Sec-Fetch-Site": "none",
    "Cache-Control": "max-age=0"
  };
  if (referer2) headers.Referer = referer2;
  if (origin2) headers.Origin = origin2;
  const cookies = await cookieJar.getCookies(url);
  if (cookies.length > 0) {
    headers.Cookie = cookies.map((c) => `${c.key}=${c.value}`).join("; ");
  }
  let lastError = null;
  for (let i = 0; i < retries; i++) {
    try {
      if (i > 0) {
        const randomDelay = Math.floor(Math.random() * 1e3) + delay;
        await new Promise((resolve) => {
          setTimeout(resolve, randomDelay);
        });
      }
      const response = await fetch$1(url, {
        headers,
        redirect: "follow"
      });
      const setCookieHeaders = response.headers.get("set-cookie");
      if (setCookieHeaders) {
        const cookieStrings = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
        for (const cookieStr of cookieStrings) {
          await cookieJar.setCookie(cookieStr, url);
        }
      }
      if (!response.ok) {
        if (response.status === 403) {
          lastError = new Error(`Cloudflare blocked (403)`);
          continue;
        }
        if (response.status === 503) {
          lastError = new Error(`Service unavailable (503)`);
          continue;
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const html = await response.text();
      if (html.includes("cf-turnstile") || html.includes("Checking your browser") || html.includes("cf-challenge")) {
        lastError = new Error("Cloudflare challenge cannot be bypassed without browser");
        continue;
      }
      return html;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Failed to fetch after multiple retries");
}
function extractScripts(html) {
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  const scripts = [];
  const matches = html.matchAll(scriptRegex);
  for (const match of matches) {
    scripts.push(match[1]);
  }
  return scripts;
}
async function vidsrcScrape(ctx) {
  var _a, _b;
  const { imdbId, tmdbId } = ctx.media;
  if (!imdbId && !tmdbId) throw new NotFoundError("No ID found");
  const isShow = ctx.media.type === "show";
  let season;
  let episode;
  if (isShow) {
    const show = ctx.media;
    season = (_a = show.season) == null ? void 0 : _a.number;
    episode = (_b = show.episode) == null ? void 0 : _b.number;
  }
  let embedUrl = "";
  if (isShow) {
    embedUrl = imdbId ? `https://vidsrc-embed.ru/embed/tv?imdb=${imdbId}&season=${season}&episode=${episode}` : `https://vidsrc-embed.ru/embed/tv?tmdb=${tmdbId}&season=${season}&episode=${episode}`;
  } else {
    embedUrl = imdbId ? `https://vidsrc-embed.ru/embed/${imdbId}` : `https://vidsrc-embed.ru/embed/movie?tmdb=${tmdbId}`;
  }
  ctx.progress(10);
  const embedHtml = await ctx.proxiedFetcher(embedUrl, {
    headers: {
      Referer: "https://vidsrc-embed.ru/",
      "User-Agent": "Mozilla/5.0"
    }
  });
  ctx.progress(30);
  const iframeMatch = embedHtml.match(/<iframe[^>]*id="player_iframe"[^>]*src="([^"]*)"[^>]*>/);
  if (!iframeMatch) throw new NotFoundError("Initial iframe not found");
  const rcpUrl = iframeMatch[1].startsWith("//") ? `https:${iframeMatch[1]}` : iframeMatch[1];
  ctx.progress(50);
  const rcpHtml = await fetchWithHeaders(rcpUrl, {
    referer: embedUrl,
    retries: 3,
    delay: 3e3
  });
  const scriptMatch = rcpHtml.match(/src:\s+'(\/prorcp\/[^']+)'/);
  if (!scriptMatch) {
    const directM3u8Match = rcpHtml.match(/file\s*:\s*['"]([^'"]*\.m3u8[^'"]*)['"]/);
    if (!directM3u8Match) {
      throw new NotFoundError("Could not find prorcp iframe or direct m3u8 URL - Cloudflare may be blocking");
    }
    const streamUrl2 = directM3u8Match[1];
    return {
      stream: [
        {
          id: "vidsrc-cloudnestra-0",
          displayName: generateCodename(0, "Server"),
          type: "hls",
          playlist: streamUrl2,
          headers: {
            Referer: "https://cloudnestra.com/",
            Origin: "https://cloudnestra.com"
          },
          proxyDepth: 2,
          flags: [],
          captions: []
        }
      ],
      embeds: []
    };
  }
  const prorcpUrl = `https://cloudnestra.com${scriptMatch[1]}`;
  ctx.progress(70);
  const finalHtml = await fetchWithHeaders(prorcpUrl, {
    referer: rcpUrl,
    retries: 3,
    delay: 2e3
  });
  const scripts = extractScripts(finalHtml);
  let scriptWithPlayer = "";
  for (const script of scripts) {
    if (script.includes("Playerjs")) {
      scriptWithPlayer = script;
      break;
    }
  }
  if (!scriptWithPlayer) {
    throw new NotFoundError("No Playerjs config found");
  }
  let streamUrl = "";
  const m3u8Match = scriptWithPlayer.match(/file\s*:\s*['"]([^'"]+)['"]/);
  if (!m3u8Match) {
    const fileVarMatch = scriptWithPlayer.match(/file\s*:\s*([a-zA-Z0-9_]+)\s*[,}]/);
    if (fileVarMatch) {
      const varName = fileVarMatch[1];
      const divMatch = finalHtml.match(new RegExp(`<div id="${varName}"[^>]*>\\s*([^<]+)\\s*</div>`, "s"));
      if (divMatch) {
        const encodedData = divMatch[1].trim();
        try {
          streamUrl = Buffer.from(encodedData, "base64").toString("utf-8");
        } catch (e) {
          streamUrl = encodedData;
        }
      } else {
        throw new NotFoundError("No file data found in referenced div");
      }
    } else {
      throw new NotFoundError("No file field in Playerjs");
    }
  } else {
    streamUrl = m3u8Match[1];
  }
  const decoderParams = extractDecoderParams(finalHtml);
  if (decoderParams) {
    const decoded = decodeStreamUrl(decoderParams.id, decoderParams.content);
    if (decoded && (decoded.includes("http") || decoded.includes(".m3u8"))) {
      streamUrl = decoded;
    }
  }
  if (!streamUrl.includes(".m3u8") && !streamUrl.startsWith("http")) {
    throw new NotFoundError("Could not decode stream URL - decoder params not found or invalid");
  }
  const rawUrls = streamUrl.split(" or ");
  const streams = [];
  const domainMap = {};
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
  if (!domainMap.v1) domainMap.v1 = "shadowlandschronicles.com";
  const headers = {
    referer: "https://cloudnestra.com/",
    origin: "https://cloudnestra.com"
  };
  for (let url of rawUrls) {
    url = url.trim();
    for (const [key, value] of Object.entries(domainMap)) {
      if (url.includes(`{${key}}`)) {
        url = url.replace(new RegExp(`{${key}}`, "g"), value);
      }
    }
    if (url.includes("tmstr5")) {
      url = url.replace(/tmstr5/g, "tmstr2");
    }
    if (url.match(/{v\d+}/)) {
      continue;
    }
    try {
      const response = await fetch(url, {
        method: "HEAD",
        headers: {
          referer: "https://cloudnestra.com/",
          origin: "https://cloudnestra.com"
        }
      });
      if (!response.ok) {
        continue;
      }
    } catch {
      continue;
    }
    streams.push({
      id: `vidsrc-cloudnestra-${streams.length}`,
      displayName: generateCodename(streams.length, "Server"),
      type: "hls",
      playlist: url,
      headers,
      proxyDepth: 2,
      flags: [],
      captions: []
    });
  }
  ctx.progress(90);
  if (streams.length === 0) {
    throw new NotFoundError("No valid streams found");
  }
  return {
    stream: streams,
    embeds: []
  };
}
const vidsrcScraper = makeSourcerer({
  id: "cloudnestra",
  name: "Shadow",
  rank: 400,
  disabled: false,
  flags: [],
  scrapeMovie: vidsrcScrape,
  scrapeShow: vidsrcScrape
});
const BASE_URL = "https://vixsrc.to";
async function vixsrcScrape(ctx) {
  var _a, _b;
  const tmdbId = ctx.media.tmdbId;
  if (!tmdbId) throw new NotFoundError("TMDB ID not found");
  const isShow = ctx.media.type === "show";
  let season;
  let episode;
  if (isShow) {
    const show = ctx.media;
    season = (_a = show.season) == null ? void 0 : _a.number;
    episode = (_b = show.episode) == null ? void 0 : _b.number;
  }
  const vixsrcUrl = isShow ? `${BASE_URL}/tv/${tmdbId}/${season}/${episode}` : `${BASE_URL}/movie/${tmdbId}`;
  ctx.progress(10);
  const html = await ctx.proxiedFetcher(vixsrcUrl, {
    headers: {
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Referer: BASE_URL
    }
  });
  ctx.progress(30);
  let masterPlaylistUrl = null;
  if (html.includes("window.masterPlaylist")) {
    const urlMatch = html.match(/url:\s*['"]([^'"]+)['"]/);
    const tokenMatch = html.match(/['"]?token['"]?\s*:\s*['"]([^'"]+)['"]/);
    const expiresMatch = html.match(/['"]?expires['"]?\s*:\s*['"]([^'"]+)['"]/);
    if (urlMatch && tokenMatch && expiresMatch) {
      const baseUrl2 = urlMatch[1];
      const token = tokenMatch[1];
      const expires = expiresMatch[1];
      if (baseUrl2.includes("?b=1")) {
        masterPlaylistUrl = `${baseUrl2}&token=${token}&expires=${expires}&h=1&lang=en`;
      } else {
        masterPlaylistUrl = `${baseUrl2}?token=${token}&expires=${expires}&h=1&lang=en`;
      }
    }
  }
  if (!masterPlaylistUrl) {
    const m3u8Match = html.match(/(https?:\/\/[^'"\s]+\.m3u8[^'"\s]*)/);
    if (m3u8Match) {
      masterPlaylistUrl = m3u8Match[1];
    }
  }
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
    throw new NotFoundError("No master playlist URL found");
  }
  ctx.progress(70);
  const captions = [];
  try {
    const masterResponse = await ctx.proxiedFetcher(masterPlaylistUrl, {
      headers: {
        Referer: BASE_URL,
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
      }
    });
    const resolveUrl = (relative, base) => {
      if (relative.startsWith("http")) return relative;
      const parent = base.substring(0, base.lastIndexOf("/") + 1);
      return new URL(relative, parent).toString();
    };
    const subtitleRegex = /#EXT-X-MEDIA:TYPE=SUBTITLES.*?NAME="([^"]+)".*?LANGUAGE="([^"]+)".*?URI="([^"]+)"/g;
    let match;
    const subtitleTasks = [];
    while ((match = subtitleRegex.exec(masterResponse)) !== null) {
      const name = match[1];
      const lang = match[2];
      const uri = resolveUrl(match[3], masterPlaylistUrl);
      subtitleTasks.push(
        (async () => {
          try {
            const subManifest = await ctx.proxiedFetcher(uri, {
              headers: { Referer: BASE_URL }
            });
            const vttMatch = subManifest.match(/(https?:\/\/[^'"\s]+\.vtt[^'"\s]*)/) || subManifest.match(/([^\s]+\.vtt[^\s]*)/);
            if (vttMatch) {
              const vttUrl = resolveUrl(vttMatch[1], uri);
              captions.push({
                id: `vixsrc-${lang}-${name}`,
                language: lang,
                url: vttUrl,
                label: name,
                hasCorsRestrictions: false,
                type: "vtt"
              });
            }
          } catch (e) {
          }
        })()
      );
    }
    await Promise.all(subtitleTasks);
    console.log(`[VixSRC] Resolved ${captions.length} subtitles`);
  } catch (e) {
    console.error("[VixSRC] Error parsing master playlist:", e);
  }
  return {
    stream: [
      {
        id: "vixsrc-0",
        displayName: generateCodename(0, "Server"),
        type: "hls",
        playlist: masterPlaylistUrl,
        headers: {
          Referer: BASE_URL,
          Origin: BASE_URL,
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        },
        proxyDepth: 2,
        flags: [],
        captions
      }
    ],
    embeds: []
  };
}
const vixsrcScraper = makeSourcerer({
  id: "vixsrc",
  name: "Halo",
  rank: 350,
  disabled: false,
  flags: [],
  scrapeMovie: vixsrcScrape,
  scrapeShow: vixsrcScrape
});
function gatherAllSources() {
  return [
    vidsrcScraper,
    // Rank: 300, Cloudnestra (Primary)
    lookmovieScraper,
    // Rank: 250
    vidrockScraper,
    // Rank: 200
    showboxScraper,
    // Rank: 190
    vidlinkScraper,
    // Rank: 185
    hdRezkaScraper,
    // Rank: 175
    videoeasyScraper,
    // Rank: 150
    vixsrcScraper,
    // Rank: 145
    ee3Scraper
    // Rank: varies
  ];
}
function gatherAllEmbeds() {
  return [upcloudScraper, vidCloudScraper, ridooScraper, closeLoadScraper];
}
function getBuiltinSources() {
  return gatherAllSources().filter((v) => !v.disabled && !v.externalSource);
}
function getBuiltinExternalSources() {
  return gatherAllSources().filter((v) => v.externalSource && !v.disabled);
}
function getBuiltinEmbeds() {
  return gatherAllEmbeds().filter((v) => !v.disabled);
}
function findDuplicates(items, keyFn) {
  const groups = /* @__PURE__ */ new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }
  return Array.from(groups.entries()).filter(([_, groupItems]) => groupItems.length > 1).map(([key, groupItems]) => ({ key, items: groupItems }));
}
function formatDuplicateError(type, duplicates, keyName) {
  const duplicateList = duplicates.map(({ key, items }) => {
    const itemNames = items.map((item) => item.name || item.id).join(", ");
    return `  ${keyName} ${key}: ${itemNames}`;
  }).join("\n");
  return `${type} have duplicate ${keyName}s:
${duplicateList}`;
}
function getProviders(features, list) {
  const sources = list.sources.filter((v) => !(v == null ? void 0 : v.disabled));
  const embeds = list.embeds.filter((v) => !(v == null ? void 0 : v.disabled));
  const combined = [...sources, ...embeds];
  const duplicateIds = findDuplicates(combined, (v) => v.id);
  if (duplicateIds.length > 0) {
    throw new Error(formatDuplicateError("Sources/embeds", duplicateIds, "ID"));
  }
  const duplicateSourceRanks = findDuplicates(sources, (v) => v.rank);
  if (duplicateSourceRanks.length > 0) {
    throw new Error(formatDuplicateError("Sources", duplicateSourceRanks, "rank"));
  }
  const duplicateEmbedRanks = findDuplicates(embeds, (v) => v.rank);
  if (duplicateEmbedRanks.length > 0) {
    throw new Error(formatDuplicateError("Embeds", duplicateEmbedRanks, "rank"));
  }
  return {
    sources: sources.filter((s) => flagsAllowedInFeatures(features, s.flags)),
    embeds
  };
}
function makeProviders(ops) {
  var _a;
  const features = getTargetFeatures(
    ops.proxyStreams ? "any" : ops.target,
    ops.consistentIpForRequests ?? false,
    ops.proxyStreams
  );
  const sources = [...getBuiltinSources()];
  if (ops.externalSources === "all") sources.push(...getBuiltinExternalSources());
  else {
    (_a = ops.externalSources) == null ? void 0 : _a.forEach((source) => {
      const matchingSource = getBuiltinExternalSources().find((v) => v.id === source);
      if (!matchingSource) return;
      sources.push(matchingSource);
    });
  }
  const list = getProviders(features, {
    embeds: getBuiltinEmbeds(),
    sources
  });
  return makeControls({
    embeds: list.embeds,
    sources: list.sources,
    features,
    fetcher: ops.fetcher,
    proxiedFetcher: ops.proxiedFetcher,
    proxyStreams: ops.proxyStreams
  });
}
function buildProviders() {
  let consistentIpForRequests = false;
  let target = null;
  let fetcher = null;
  let proxiedFetcher = null;
  const embeds = [];
  const sources = [];
  const builtinSources = getBuiltinSources();
  const builtinExternalSources = getBuiltinExternalSources();
  const builtinEmbeds = getBuiltinEmbeds();
  return {
    enableConsistentIpForRequests() {
      consistentIpForRequests = true;
      return this;
    },
    setFetcher(f) {
      fetcher = f;
      return this;
    },
    setProxiedFetcher(f) {
      proxiedFetcher = f;
      return this;
    },
    setTarget(t) {
      target = t;
      return this;
    },
    addSource(input) {
      if (typeof input !== "string") {
        sources.push(input);
        return this;
      }
      const matchingSource = [...builtinSources, ...builtinExternalSources].find((v) => v.id === input);
      if (!matchingSource) throw new Error("Source not found");
      sources.push(matchingSource);
      return this;
    },
    addEmbed(input) {
      if (typeof input !== "string") {
        embeds.push(input);
        return this;
      }
      const matchingEmbed = builtinEmbeds.find((v) => v.id === input);
      if (!matchingEmbed) throw new Error("Embed not found");
      embeds.push(matchingEmbed);
      return this;
    },
    addBuiltinProviders() {
      sources.push(...builtinSources);
      embeds.push(...builtinEmbeds);
      return this;
    },
    build() {
      if (!target) throw new Error("Target not set");
      if (!fetcher) throw new Error("Fetcher not set");
      const features = getTargetFeatures(target, consistentIpForRequests);
      const list = getProviders(features, {
        embeds,
        sources
      });
      return makeControls({
        fetcher,
        proxiedFetcher: proxiedFetcher ?? void 0,
        embeds: list.embeds,
        sources: list.sources,
        features
      });
    }
  };
}
const isReactNative = () => {
  try {
    require("react-native");
    return true;
  } catch (e) {
    return false;
  }
};
function serializeBody(body) {
  if (body === void 0 || typeof body === "string" || body instanceof URLSearchParams || body instanceof FormData) {
    if (body instanceof URLSearchParams && isReactNative()) {
      return {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: body.toString()
      };
    }
    return {
      headers: {},
      body
    };
  }
  return {
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  };
}
function getHeaders(list, res) {
  const output = new Headers();
  list.forEach((header) => {
    var _a;
    const realHeader = header.toLowerCase();
    const realValue = res.headers.get(realHeader);
    const extraValue = (_a = res.extraHeaders) == null ? void 0 : _a.get(realHeader);
    const value = extraValue ?? realValue;
    if (!value) return;
    output.set(realHeader, value);
  });
  return output;
}
function makeStandardFetcher(_f) {
  const normalFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const controller = new AbortController();
    const timeout = 15e3;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...seralizedBody.headers,
        ...ops.headers
      };
      const res = await fetch(fullUrl, {
        method: ops.method,
        headers,
        body: seralizedBody.body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      let body;
      const isJson = (_a = res.headers.get("content-type")) == null ? void 0 : _a.includes("application/json");
      if (isJson) body = await res.json();
      else body = await res.text();
      return {
        body,
        finalUrl: res.url,
        headers: getHeaders(ops.readHeaders, {
          headers: res.headers,
          status: res.status,
          url: res.url
        }),
        statusCode: res.status
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Fetch request to ${fullUrl} timed out after ${timeout}ms`);
      }
      throw error;
    }
  };
  return normalFetch;
}
function makeProxiedFetcher(_f) {
  const SCRAPER_PROXY = process.env.SCRAPER_PROXY;
  if (!SCRAPER_PROXY) {
    return makeStandardFetcher();
  }
  const proxiedFetch = async (url, ops) => {
    var _a;
    const fullUrl = makeFullUrl(url, ops);
    const seralizedBody = serializeBody(ops.body);
    const proxyUrl = new URL(SCRAPER_PROXY);
    proxyUrl.searchParams.set("url", fullUrl);
    const controller = new AbortController();
    const timeout = 15e3;
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        ...seralizedBody.headers,
        ...ops.headers
      };
      const res = await fetch(proxyUrl.toString(), {
        method: ops.method,
        headers,
        body: seralizedBody.body,
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      let body;
      const isJson = (_a = res.headers.get("content-type")) == null ? void 0 : _a.includes("application/json");
      if (isJson) body = await res.json();
      else body = await res.text();
      return {
        body,
        finalUrl: res.url,
        headers: getHeaders(ops.readHeaders, {
          headers: res.headers,
          status: res.status,
          url: res.url
        }),
        statusCode: res.status
      };
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error(`Proxied fetch request to ${fullUrl} timed out after ${timeout}ms`);
      }
      throw error;
    }
  };
  return proxiedFetch;
}
const headerMap = {
  cookie: "X-Cookie",
  referer: "X-Referer",
  origin: "X-Origin",
  "user-agent": "X-User-Agent",
  "x-real-ip": "X-X-Real-Ip"
};
function makeSimpleProxyFetcher(proxyUrl, f) {
  const proxiedFetch = async (url, ops) => {
    const fetcher = makeStandardFetcher();
    const fullUrl = makeFullUrl(url, ops);
    const headerEntries = Object.entries(ops.headers).map((entry) => {
      const key = entry[0].toLowerCase();
      if (headerMap[key]) return [headerMap[key], entry[1]];
      return entry;
    });
    return fetcher(proxyUrl, {
      ...ops,
      query: {
        destination: fullUrl
      },
      headers: Object.fromEntries(headerEntries),
      baseUrl: void 0
    });
  };
  return proxiedFetch;
}
function getNativeLanguageName(code) {
  const normalized = code.toLowerCase().trim();
  const nativeNames = {
    // 🌍 Global
    en: "English",
    es: "Español",
    "es-419": "Español (Latinoamérica)",
    "es-ES": "Español (España)",
    "es-MX": "Español (México)",
    fr: "Français",
    "fr-CA": "Français (Canada)",
    de: "Deutsch",
    it: "Italiano",
    pt: "Português",
    "pt-BR": "Português (Brasil)",
    "pt-PT": "Português (Portugal)",
    ru: "Русский",
    // 🌏 East Asia
    ja: "日本語",
    ko: "한국어",
    zh: "中文",
    "zh-Hans": "简体中文",
    "zh-Hant": "繁體中文",
    "zh-CN": "中文 (简体)",
    "zh-TW": "中文 (繁體)",
    "zh-HK": "中文 (香港)",
    // 🌍 Middle East
    ar: "العربية",
    he: "עברית",
    fa: "فارسی",
    ur: "اردو",
    // 🇮🇳 Indian languages
    hi: "हिन्दी",
    bn: "বাংলা",
    pa: "ਪੰਜਾਬੀ",
    gu: "ગુજરાતી",
    te: "తెలుగు",
    mr: "मराठी",
    ta: "தமிழ்",
    kn: "ಕನ್ನಡ",
    ml: "മലയാളം",
    or: "ଓଡ଼ିଆ",
    as: "অসমীয়া",
    ne: "नेपाली",
    si: "සිංහල",
    // 🌏 Southeast Asia
    id: "Bahasa Indonesia",
    ms: "Bahasa Melayu",
    vi: "Tiếng Việt",
    th: "ไทย",
    tl: "Filipino",
    km: "ខ្មែរ",
    lo: "ລາວ",
    my: "မြန်မာ",
    // 🌍 Europe
    nl: "Nederlands",
    pl: "Polski",
    sv: "Svenska",
    no: "Norsk",
    da: "Dansk",
    fi: "Suomi",
    cs: "Čeština",
    hu: "Magyar",
    ro: "Română",
    el: "Ελληνικά",
    uk: "Українська",
    bg: "Български",
    hr: "Hrvatski",
    sk: "Slovenčina",
    sl: "Slovenščina",
    sr: "Српски",
    ca: "Català",
    eu: "Euskara",
    lt: "Lietuvių",
    lv: "Latviešu",
    et: "Eesti",
    is: "Íslenska",
    mt: "Malti",
    sq: "Shqip",
    mk: "Македонски",
    bs: "Bosanski",
    ga: "Gaeilge",
    cy: "Cymraeg",
    gl: "Galego",
    // 🌍 Africa
    sw: "Kiswahili",
    af: "Afrikaans",
    zu: "isiZulu",
    xh: "isiXhosa",
    am: "አማርኛ",
    // 🌏 Others
    tr: "Türkçe"
  };
  return nativeNames[normalized] || code.toUpperCase();
}
async function fetchSubtitles(options) {
  try {
    const {
      tmdbId,
      imdbId,
      season,
      episode,
      language,
      // Don't use as filter, just for fallback
      format = "srt",
      encoding,
      hearingImpaired,
      source
    } = options;
    const searchParams = {
      format
    };
    if (tmdbId) {
      searchParams.tmdb_id = parseInt(tmdbId, 10);
    } else if (imdbId) {
      searchParams.imdb_id = imdbId;
    } else {
      console.warn("[Subtitles] No TMDB or IMDB ID provided");
      return [];
    }
    if (season !== void 0) searchParams.season = season;
    if (episode !== void 0) searchParams.episode = episode;
    if (encoding) searchParams.encoding = encoding;
    if (hearingImpaired !== void 0) searchParams.hi = hearingImpaired;
    if (source) searchParams.source = source;
    const data = await searchSubtitles(searchParams);
    const allSubtitles = data.map((sub) => {
      const langCode = sub.language || language || "en";
      const langName = getNativeLanguageName(langCode);
      return {
        id: sub.id,
        language: langCode,
        languageName: langName,
        url: sub.url,
        format: sub.format || format,
        source: sub.source,
        // Can be string or array
        hearingImpaired: sub.isHearingImpaired || false
      };
    });
    const uniqueByLanguage = /* @__PURE__ */ new Map();
    allSubtitles.forEach((sub) => {
      const existing = uniqueByLanguage.get(sub.language);
      if (!existing) {
        uniqueByLanguage.set(sub.language, sub);
      } else if (existing.hearingImpaired && !sub.hearingImpaired) {
        uniqueByLanguage.set(sub.language, sub);
      } else if (existing.hearingImpaired === sub.hearingImpaired) {
        const subSource = Array.isArray(sub.source) ? sub.source[0] : sub.source;
        if (subSource === "opensubtitles") {
          uniqueByLanguage.set(sub.language, sub);
        }
      }
    });
    const uniqueSubtitles = Array.from(uniqueByLanguage.values()).sort(
      (a, b) => a.languageName.localeCompare(b.languageName)
    );
    return uniqueSubtitles;
  } catch (error) {
    console.warn("[Subtitles] Failed to fetch:", error instanceof Error ? error.message : error);
    return [];
  }
}
export {
  NotFoundError,
  anonymizeSourceId,
  buildProviders,
  fetchSubtitles,
  flags,
  getBuiltinEmbeds,
  getBuiltinExternalSources,
  getBuiltinSources,
  getProviderCodename,
  getProviderIdFromCodename,
  makeProviders,
  makeProxiedFetcher,
  makeSimpleProxyFetcher,
  makeStandardFetcher,
  resolveSourceId,
  targets
};

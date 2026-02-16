import { Embed, Sourcerer } from "@/providers/base";
import { upcloudScraper } from "@/providers/embeds/upcloud";
import { ee3Scraper } from "@/providers/sources/ee3";

import { closeLoadScraper } from "./embeds/closeload";
import { ridooScraper } from "./embeds/ridoo";
import { vidCloudScraper } from "./embeds/vidcloud";
import { hdRezkaScraper } from "./sources/hdrezka";
import { lookmovieScraper } from "./sources/lookmovie";
import { showboxScraper } from "./sources/showbox";
import { videoeasyScraper } from "./sources/videoeasy";
import { vidlinkScraper } from "./sources/vidlink";
import { vidrockScraper } from "./sources/vidrock";
import { vidsrcScraper } from "./sources/vidsrc";
import { vixsrcScraper } from "./sources/vixsrc";

export function gatherAllSources(): Array<Sourcerer> {
  // Active providers only (cleaned up disabled ones)
  return [
    vidsrcScraper, // Rank: 300, Cloudnestra (Primary)
    lookmovieScraper, // Rank: 250
    vidrockScraper, // Rank: 200
    showboxScraper, // Rank: 190
    vidlinkScraper, // Rank: 185
    hdRezkaScraper, // Rank: 175
    videoeasyScraper, // Rank: 150
    // vixsrcScraper, // Rank: 145
    ee3Scraper, // Rank: varies
  ];
}

export function gatherAllEmbeds(): Array<Embed> {
  // Only embeds used by working providers
  return [upcloudScraper, vidCloudScraper, ridooScraper, closeLoadScraper];
}

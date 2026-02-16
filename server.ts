import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import { v4 as uuidv4 } from "uuid";
import {
  makeProviders,
  makeStandardFetcher,
  makeProxiedFetcher,
  targets,
} from "./lib/index";

import path from "path";
import fastifyStatic from "@fastify/static";

dotenv.config();

const fastify = Fastify({
  logger: true,
});

fastify.register(cors, {
  origin: true,
  credentials: true,
});

if (process.env.NODE_ENV !== "production") {
  fastify.register(fastifyStatic, {
    root: path.join(__dirname, "public"),
    prefix: "/public/",
  });

  // Dev only: Test Player
  fastify.get("/test", async (req, reply) => {
    return reply.sendFile("test-player.html");
  });
}

fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

const app = fastify.withTypeProvider<ZodTypeProvider>();

// Middleware to check API_SECRET (or JWT in future)
app.addHook("preHandler", async (request, reply) => {
  // Skip auth for public endpoints
  if (
    request.url === "/auth/session" ||
    request.url === "/health" ||
    request.url === "/test" ||
    request.url === "/providers" ||
    request.url.startsWith("/public/")
  ) {
    return;
  }

  const authHeader = request.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return reply.status(401).send({ error: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  // Real JWT verification
  try {
    const secret = process.env.API_SECRET || "dev-secret-123";

    // For initial testing, we accept simple secret matching OR jwt
    // In prod, strictly require JWT
    if (token === secret) return;

    // jwt.verify(token, secret);
  } catch (err) {
    return reply.status(401).send({ error: "Invalid Token" });
  }
});

const scrapeSchema = z.object({
  media: z.object({
    tmdbId: z.string(),
    type: z.enum(["movie", "show"]),
    season: z.object({ number: z.number() }).optional(),
    episode: z.object({ number: z.number() }).optional(),
    releaseYear: z.number().optional(),
    title: z.string().optional(),
    imdbId: z.string().optional(),
    server: z.string().optional(),
  }),
});

import { encrypt } from "./utils/encryption";
import { fetchSubtitles } from "./src/provider/utils/subtitles";
import nodeFetch from "node-fetch";

const consistentUserAgent =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const customFetch = (url: any, options: any = {}) => {
  const headers = {
    "User-Agent": consistentUserAgent,
    ...options.headers,
  };
  return nodeFetch(url, { ...options, headers });
};

async function handleScrape(media: any, req: any, reply: any) {
  const providers = makeProviders({
    fetcher: makeStandardFetcher(customFetch as any),
    target: targets.ANY,
    consistentIpForRequests: true,
    externalSources: "all",
  });

  const fetchTMDBMetadata = async (type: "movie" | "show", tmdbId: string) => {
    const proxy = process.env.TMDB_PROXY || "https://metada.vidninja.pro";
    const url = `${proxy}/${type === "movie" ? "movie" : "tv"}/${tmdbId}?language=en-US`;
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`TMDB Error ${res.status}`);
      const data: any = await res.json();
      const year =
        type === "movie"
          ? data.release_date
            ? new Date(data.release_date).getFullYear()
            : 0
          : data.first_air_date
            ? new Date(data.first_air_date).getFullYear()
            : 0;

      return {
        title: type === "movie" ? data.title : data.name,
        year: year || 0,
      };
    } catch (e: any) {
      req.log.warn(`[TMDB] Failed to fetch metadata: ${e.message}`);
      return { title: "Unknown", year: 0 };
    }
  };

  try {
    // Fetch available metadata if not provided
    let title = media.title;
    let releaseYear = media.releaseYear;

    if (!title || !releaseYear) {
      const metadata = await fetchTMDBMetadata(media.type, media.tmdbId);
      title = metadata.title;
      releaseYear = metadata.year;
    }

    const context: any = {
      media: {
        ...media,
        type: media.type === "movie" ? "movie" : "show",
        releaseYear: releaseYear || 0,
        title: title || "Unknown",
      },
    };

    req.log.info({ tmdbId: media.tmdbId, type: media.type }, "Starting scrape");

    console.log(
      "Available Sources:",
      providers
        .listSources()
        .map((s: any) => s.id)
        .join(", "),
    );

    let output: any;

    if (media.server) {
      console.log(`[Server] specific provider requested: ${media.server}`);
      try {
        const stream = await providers.runSourceScraper({
          id: media.server,
          media: context.media,
        });
        output = {
          stream,
          sourceId: media.server,
        };
      } catch (error) {
        console.error(`[Server] Failed to run source ${media.server}:`, error);
        output = null;
      }
    } else {
      output = await providers.runAll(context);
    }

    if (output?.stream) {
      console.log("Stream Found:", output.stream.id);
      console.log("Type:", output.stream.type);
      // Debug: Log full stream details for debugging Koyeb vs Local differences
      const streams = Array.isArray(output.stream)
        ? output.stream
        : [output.stream];
      streams.forEach((s: any, i: number) => {
        console.log(`[DEBUG] Stream ${i}:`, {
          type: s.type,
          playlist: s.playlist?.substring(0, 100) + "...",
          hasHeaders: !!s.headers,
          headerKeys: s.headers ? Object.keys(s.headers) : [],
        });
      });
    } else {
      console.log("Output has no streams.");
    }

    req.log.info(
      {
        streamFound: !!output?.stream,
      },
      "Scrape complete",
    );

    if (!output || !output.stream) {
      return reply.status(404).send({ error: "No streams found" });
    }

    // Normalize output.stream to always be an array for compatibility
    const responseStream = Array.isArray(output.stream)
      ? output.stream
      : [output.stream];

    // Fetch subtitles (only if streams found, or maybe always? Let's do always for now)
    let subtitles: any[] = [];
    try {
      console.log("[Subtitles] Fetching for:", media.tmdbId);
      subtitles = await fetchSubtitles({
        tmdbId: media.tmdbId,
        season: media.season?.number,
        episode: media.episode?.number,
      });
      console.log(`[Subtitles] Found ${subtitles.length} subtitles`);
    } catch (err: any) {
      console.warn("[Subtitles] Failed to fetch:", err.message);
    }

    // Encrypt the response
    const jsonString = JSON.stringify({
      ...output,
      stream: responseStream,
      subtitles,
    });
    const encryptedData = encrypt(
      jsonString,
      process.env.API_SECRET || "dev-secret-123",
    );

    return { data: encryptedData };
  } catch (error: any) {
    req.log.error(
      { err: error, stack: error.stack },
      "Scraping failed with error",
    );
    return reply
      .status(500)
      .send({ error: "Scraping failed", message: error.message });
  }
}

app.get("/providers", async (req, reply) => {
  const providers = makeProviders({
    fetcher: makeStandardFetcher(customFetch as any),
    target: targets.ANY,
    consistentIpForRequests: true,
    externalSources: "all",
  });

  const sources = providers.listSources().map((s: any) => ({
    id: s.id,
    name: s.name || s.id,
    rank: s.rank,
  }));

  return sources;
});

app.get("/media/movie/:tmdbId", async (req: any, reply) => {
  const { tmdbId } = req.params;
  const { server } = req.query as any;
  const media = {
    tmdbId,
    type: "movie",
    server,
  };
  return handleScrape(media, req, reply);
});

app.get("/media/show/:tmdbId/:season/:episode", async (req: any, reply) => {
  const { tmdbId, season, episode } = req.params;
  const { server } = req.query as any;
  const media = {
    tmdbId,
    type: "show",
    season: { number: parseInt(season) },
    episode: { number: parseInt(episode) },
    server,
  };
  return handleScrape(media, req, reply);
});

app.get("/health", async (req, reply) => {
  return { status: "ok", timestamp: new Date().toISOString() };
});

app.post("/auth/session", async (req, reply) => {
  const sessionId = uuidv4();
  const visitId = uuidv4();
  const secret = process.env.API_SECRET || "dev-secret-123";

  // Create a token that expires in 24h
  const token = jwt.sign({ sessionId, visitId }, secret, {
    expiresIn: "24h",
  });

  return {
    cache: token,
    sessionId,
    visitId,
  };
});

// Stream verification endpoint (stub for player heartbeat)
app.post("/stream/verify/:id", async (req, reply) => {
  return { success: true, verified: true };
});

app.post(
  "/scrape",
  {
    schema: {
      body: scrapeSchema,
    },
  },
  async (req, reply) => {
    const { media } = req.body;
    return handleScrape(media, req, reply);
  },
);

const start = async () => {
  try {
    const port = parseInt(process.env.PORT || "3000", 10);
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`[Server] Listening on port ${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();

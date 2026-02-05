import { Flags } from '@/entrypoint/utils/targets';
import { Caption } from '@/providers/captions';

export type StreamFile = {
  type: 'mp4';
  url: string;
};

export type Qualities = 'unknown' | '360' | '480' | '720' | '1080' | '4k';

type ThumbnailTrack = {
  type: 'vtt';
  url: string;
};

type StreamCommon = {
  id: string; // only unique per output
  displayName?: string; // optional friendly name for UI display (e.g., "Server Alpha")
  flags: Flags[];
  captions: Caption[];
  thumbnailTrack?: ThumbnailTrack;
  headers?: Record<string, string>; // these headers HAVE to be set to watch the stream (for playlists)
  preferredHeaders?: Record<string, string>; // these headers are optional, would improve the stream
  segmentHeaders?: Record<string, string>; // headers specifically for segment requests (.ts, .m4s) - some CDNs require different headers
};

export type FileBasedStream = StreamCommon & {
  type: 'file';
  qualities: Partial<Record<Qualities, StreamFile>>;
};

export type HlsBasedStream = StreamCommon & {
  type: 'hls';
  playlist: string;
  proxyDepth?: 0 | 1 | 2;
};

export type Stream = FileBasedStream | HlsBasedStream;

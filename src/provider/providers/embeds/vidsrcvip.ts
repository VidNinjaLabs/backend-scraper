import { flags } from '@/entrypoint/utils/targets';
import { makeEmbed } from '@/providers/base';

const embeds = [
  {
    id: 'vidsrc-comet',
    name: 'Comet',
    rank: 39,
  },
  {
    id: 'vidsrc-pulsar',
    name: 'Pulsar',
    rank: 38,
  },
  {
    id: 'vidsrc-nova',
    name: 'Nova',
    rank: 37,
  },
];

function makeVidSrcEmbed(provider: { id: string; name: string; rank: number }) {
  return makeEmbed({
    id: provider.id,
    name: provider.name,
    rank: provider.rank,
    flags: [],
    async scrape(ctx) {
      return {
        stream: [
          {
            id: 'primary',
            type: 'hls',
            playlist: ctx.url,
            flags: [flags.CORS_ALLOWED],
            captions: [],
            preferredHeaders: {
              Referer: 'https://vidsrc.vip/',
              Origin: 'https://vidsrc.vip',
            },
          },
        ],
      };
    },
  });
}

export const [vidsrcCometEmbed, vidsrcPulsarEmbed, vidsrcNovaEmbed] = embeds.map(makeVidSrcEmbed);

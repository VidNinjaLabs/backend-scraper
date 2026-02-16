/* eslint-disable no-empty */
/* eslint-disable no-console */
/**
 * Cloudnestra stream URL decoders
 * These decoder functions decode the obfuscated stream URLs without needing JavaScript execution
 * Based on VidSrc.js decoder implementations
 */

type DecoderFunction = (content: string) => string;

/**
 * Decoder implementations
 */
const decoders = {
  /** Reverse chunks of 3 characters */
  decoder1: (content: string): string => {
    const chunkSize = 3;
    const chunks: string[] = [];
    for (let i = 0; i < content.length; i += chunkSize) {
      chunks.push(content.substring(i, Math.min(i + chunkSize, content.length)));
    }
    return chunks.reverse().join('');
  },

  /** XOR with key + shift, then base64 decode */
  decoder2: (content: string): string => {
    const key = 'pWB9V)[*4I`nJpp?ozyB~dbr9yt!_n4u'.split('').map((c) => c.charCodeAt(0));
    const shift = 3;
    const bytes = (content.match(/.{2}/g) || []).map((hex) => parseInt(hex, 16));
    const decrypted = bytes.map((v, i) => (v ^ key[i % key.length]) - shift);
    return Buffer.from(String.fromCharCode(...decrypted), 'base64').toString('utf-8');
  },

  /** ROT13 then base64 decode */
  decoder3: (content: string): string => {
    const rot13 = content.split('').map((ch) => {
      if (/[a-mA-M]/.test(ch)) return String.fromCharCode(ch.charCodeAt(0) + 13);
      if (/[n-zN-Z]/.test(ch)) return String.fromCharCode(ch.charCodeAt(0) - 13);
      return ch;
    });
    return Buffer.from(rot13.join(''), 'base64').toString('utf-8');
  },

  /** Reverse, take every other char, then base64 decode */
  decoder4: (content: string): string => {
    const reversed = content.split('').reverse().join('');
    const filtered = Array.from(reversed)
      .filter((_, i) => i % 2 === 0)
      .join('');
    return Buffer.from(filtered, 'base64').toString('utf-8');
  },

  /** Reverse, shift -1, hex pairs to chars */
  decoder5: (content: string): string => {
    try {
      const reversed = content.split('').reverse().join('');
      const shifted = Array.from(reversed)
        .map((char) => String.fromCharCode(char.charCodeAt(0) - 1))
        .join('');
      const hexPairs = shifted.match(/.{1,2}/g) || [];
      const decoded = hexPairs
        .map((pair) => {
          const code = parseInt(pair, 16);
          return Number.isNaN(code) ? '' : String.fromCharCode(code);
        })
        .join('');
      return decoded;
    } catch (e) {
      return '';
    }
  },

  /** Reverse, shift -1, hex pairs */
  decoder6: (content: string): string => {
    const bytes = Array.from(content)
      .reverse()
      .map((ch) => ch.charCodeAt(0) - 1);
    const chunks: number[] = [];
    for (let i = 0; i < bytes.length; i += 2) {
      chunks.push(parseInt(String.fromCharCode(bytes[i], bytes[i + 1]), 16));
    }
    return Buffer.from(chunks).toString('utf8');
  },

  /** Slice, base64 decode, XOR with key */
  decoder7: (content: string): string => {
    const sliced = content.slice(10, -16);
    const key = '3SAY~#%Y(V%>5d/Yg"$G[Lh1rK4a;7ok'.split('').map((ch) => ch.charCodeAt(0));
    const decoded = Buffer.from(sliced, 'base64').toString('binary');
    const bytes = decoded.split('').map((ch) => ch.charCodeAt(0));
    const decrypted = bytes.map((v, i) => v ^ key[i % key.length]);
    return String.fromCharCode(...decrypted);
  },

  /** Character substitution cipher */
  decoder8: (content: string): string => {
    const substitutionMap: Record<string, string> = {
      x: 'a',
      y: 'b',
      z: 'c',
      a: 'd',
      b: 'e',
      c: 'f',
      d: 'g',
      e: 'h',
      f: 'i',
      g: 'j',
      h: 'k',
      i: 'l',
      j: 'm',
      k: 'n',
      l: 'o',
      m: 'p',
      n: 'q',
      o: 'r',
      p: 's',
      q: 't',
      r: 'u',
      s: 'v',
      t: 'w',
      u: 'x',
      v: 'y',
      w: 'z',
      X: 'A',
      Y: 'B',
      Z: 'C',
      A: 'D',
      B: 'E',
      C: 'F',
      D: 'G',
      E: 'H',
      F: 'I',
      G: 'J',
      H: 'K',
      I: 'L',
      J: 'M',
      K: 'N',
      L: 'O',
      M: 'P',
      N: 'Q',
      O: 'R',
      P: 'S',
      Q: 'T',
      R: 'U',
      S: 'V',
      T: 'W',
      U: 'X',
      V: 'Y',
      W: 'Z',
    };
    return Array.from(content)
      .map((char) => substitutionMap[char] || char)
      .join('');
  },

  /** Reverse, base64url decode, shift by N */
  decoder9:
    (shift: number) =>
    (content: string): string => {
      const normalized = content
        .split('')
        .reverse()
        .map((ch) => (ch === '-' ? '+' : ch === '_' ? '/' : ch))
        .join('');
      const decoded = Buffer.from(normalized, 'base64').toString('binary');
      const shifted = decoded.split('').map((ch) => ch.charCodeAt(0) - shift);
      return String.fromCharCode(...shifted);
    },
};

/**
 * Decoder ID to function mapping
 * To add new decoders, simply add a new entry here
 */
const DECODER_MAP: Record<string, DecoderFunction> = {
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
  ux8qjPHC66: decoders.decoder5,
};

/**
 * Decode stream URL based on decoder ID
 * If the primary decoder fails, tries all other decoders as fallback
 */
export function decodeStreamUrl(decoderId: string, content: string): string | null {
  const primaryDecoder = DECODER_MAP[decoderId];

  // Try primary decoder first
  if (primaryDecoder) {
    try {
      const decoded = primaryDecoder(content);
      if (decoded && (decoded.includes('http') || decoded.includes('.m3u8'))) {
        return decoded;
      }
    } catch {}
  }

  // Primary failed - try all other decoders as fallback

  for (const [id, decoder] of Object.entries(DECODER_MAP)) {
    if (id === decoderId) continue; // Skip primary decoder

    try {
      const decoded = decoder(content);
      if (decoded && (decoded.includes('http') || decoded.includes('.m3u8'))) {
        return decoded;
      }
    } catch {
      // Continue to next decoder
    }
  }

  return null;
}

/**
 * Extract decoder ID and content from HTML
 */
export function extractDecoderParams(html: string): { id: string; content: string } | null {
  const paramsRe = /<div id="([^"]+)" style="display:none;">([^<]+)<\/div>/;
  const match = html.match(paramsRe);

  if (!match) {
    return null;
  }

  return { id: match[1], content: match[2] };
}

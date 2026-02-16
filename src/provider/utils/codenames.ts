/**
 * Codename generator for anonymizing server/stream names
 * Provides friendly, memorable names instead of technical IDs
 */

// NOTE: Server codename pool is defined in the SERVER-LEVEL CODENAMES section below

// ============================================
// PROVIDER-LEVEL CODENAMES
// Maps provider IDs to unique codenames
// ============================================

export const PROVIDER_CODENAMES: Record<string, string> = {
  cloudnestra: 'Shadow',
  lookmovie: 'Iron',
  vidrock: 'Helix',
  videoeasy: 'Blade',
  vidlink: 'Storm',
  vixsrc: 'Halo',
  hdhub4u: 'Hub',
  ee3: 'Vector',
  showbox: 'Box',
  hdrezka: 'Rezka',
};

// ============================================
// SERVER-LEVEL CODENAMES
// Automatic codename assignment system
// ============================================

// Session tracker for used codenames (resets per scrape session)
const usedCodenamesInSession: Set<string> = new Set();
let sessionId: string | null = null;

// Persistent domain-to-codename mapping (consistent across sessions)
const domainCodenameCache: Map<string, string> = new Map();

/**
 * Start a new codename session (call at the start of each scrape)
 */
export function startCodenameSession(): string {
  sessionId = `session-${Date.now()}`;
  usedCodenamesInSession.clear();
  return sessionId;
}

/**
 * End the current codename session
 */
export function endCodenameSession(): void {
  sessionId = null;
  usedCodenamesInSession.clear();
}

// ============================================
// StreamNamer - Sequential Server Naming
// ============================================

// Server codename pool (Tech-themed names for cool appearance)
const SERVER_LETTERS = [
  'Node',
  'Core',
  'Edge',
  'Flux',
  'Nexus',
  'Pulse',
  'Prism',
  'Relay',
  'Surge',
  'Vortex',
  'Spark',
  'Stream',
  'Circuit',
  'Cache',
  'Buffer',
  'Socket',
  'Portal',
  'Gateway',
  'Chain',
  'Mesh',
];

/**
 * StreamNamer - Creates unique, professional stream IDs
 * Format: ProviderCodename-ServerLetter-FormatIndex
 * Example: Dope-Alpha-0, Dope-Beta-0, Myx-Gamma-1
 */
export class StreamNamer {
  private providerCodename: string;

  private serverIndex: number = 0;

  private urlToServer: Map<string, string> = new Map();

  private serverFormatCount: Map<string, number> = new Map();

  constructor(providerId: string) {
    this.providerCodename = PROVIDER_CODENAMES[providerId] || providerId.substring(0, 4).toUpperCase();
  }

  /**
   * Get the next stream ID for a given URL
   * Same URL will get same server letter, different format index
   */
  getStreamId(url: string): string {
    // Extract domain key to group same servers
    const domainKey = this.extractDomainKey(url);

    // Check if we've seen this server before
    let serverLetter = this.urlToServer.get(domainKey);

    if (!serverLetter) {
      // Assign next available letter
      serverLetter = SERVER_LETTERS[this.serverIndex % SERVER_LETTERS.length];
      this.urlToServer.set(domainKey, serverLetter);
      this.serverIndex++;
    }

    // Get format index for this server (for multiple formats from same CDN)
    const currentCount = this.serverFormatCount.get(serverLetter) || 0;
    this.serverFormatCount.set(serverLetter, currentCount + 1);

    return `${this.providerCodename}-${serverLetter}-${currentCount}`;
  }

  /**
   * Extract domain key from URL (hides original CDN name)
   */
  private extractDomainKey(url: string): string {
    try {
      const hostname = new URL(url).hostname;
      // Just use first part, stripped of numbers
      const parts = hostname.split('.');
      let base = parts[0].replace(/\d+$/, '');
      if (base.length <= 3 && parts.length > 1) {
        base = parts[1].replace(/cdn$/, '').replace(/\d+$/, '');
      }
      return base.toLowerCase();
    } catch {
      return `unknown-${Date.now()}`;
    }
  }
}

/**
 * Extract domain key helper (for grouping same CDN servers)
 */
function extractDomainKey(url: string): string {
  try {
    const hostname = new URL(url).hostname;
    const parts = hostname.split('.');
    let baseName = parts[0].replace(/\d+$/, '');
    if (baseName.length <= 4 && parts.length > 1) {
      baseName = parts[1].replace(/cdn$/, '').replace(/\d+$/, '');
    }
    return baseName.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/**
 * Legacy function for backward compatibility
 * @deprecated Use StreamNamer class instead
 */
export function getServerCodename(url: string): string {
  // Simple sequential assignment for backward compatibility
  const domainKey = extractDomainKey(url);

  let codename = domainCodenameCache.get(domainKey);
  if (!codename) {
    const index = domainCodenameCache.size % SERVER_LETTERS.length;
    codename = SERVER_LETTERS[index];
    domainCodenameCache.set(domainKey, codename);
  }

  return codename;
}

// Reverse mapping: codename → provider ID
export const CODENAME_TO_PROVIDER: Record<string, string> = Object.entries(PROVIDER_CODENAMES).reduce(
  (acc, [providerId, codename]) => {
    acc[codename] = providerId;
    return acc;
  },
  {} as Record<string, string>,
);

/**
 * Get provider codename from real ID
 * @param providerId - Real provider ID
 * @returns Codename or 'unknown'
 */
export function getProviderCodename(providerId: string): string {
  return PROVIDER_CODENAMES[providerId] || 'unknown';
}

/**
 * Get real provider ID from codename
 * @param codename - Provider codename
 * @returns Real provider ID or null
 */
export function getProviderIdFromCodename(codename: string): string | null {
  return CODENAME_TO_PROVIDER[codename] || null;
}

/**
 * Resolve source ID from user input (codename or real ID)
 * Used for API endpoints to accept both codenames and real IDs
 * @param input - User input (codename or real ID)
 * @param sources - Available sources
 * @returns Resolved provider ID or null
 */
export function resolveSourceId(input: string | undefined, sources: any[]): string | null {
  if (!input) {
    // Auto-select: return highest ranked source
    return sources[0]?.id || null;
  }

  // Normalize input to handle case-insensitive lookups
  const normalizedInput = input.trim();

  // Check if it's a codename (case-insensitive)
  const codenameKey = Object.keys(PROVIDER_CODENAMES).find(
    (key) => PROVIDER_CODENAMES[key].toLowerCase() === normalizedInput.toLowerCase(),
  );

  if (codenameKey) {
    return codenameKey;
  }

  // Check if it's a real ID (backward compatibility)
  if (sources.find((s: any) => s.id === normalizedInput)) {
    return normalizedInput;
  }

  return null;
}

/**
 * Anonymize provider ID to codename
 * @param providerId - Real provider ID
 * @returns Codename
 */
export function anonymizeSourceId(providerId: string): string {
  return PROVIDER_CODENAMES[providerId] || 'unknown';
}

// ============================================
// STREAM-LEVEL CODENAMES
// Generates friendly names for individual streams
// ============================================

/**
 * Simple hash function for consistent codename generation
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash &= hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate a codename for a stream index
 * @param index - The stream index (0-based)
 * @param prefix - Optional prefix (e.g., 'Server', 'Stream')
 * @returns A friendly codename
 */
export function generateCodename(index: number, prefix?: string): string {
  const codename = SERVER_LETTERS[index % SERVER_LETTERS.length];

  // If we've exhausted the pool, append a number
  const suffix = index >= SERVER_LETTERS.length ? ` ${Math.floor(index / SERVER_LETTERS.length) + 1}` : '';

  return prefix ? `${prefix} ${codename}${suffix}` : `${codename}${suffix}`;
}

/**
 * Generate codenames for multiple streams
 * @param count - Number of codenames to generate
 * @param prefix - Optional prefix
 * @returns Array of codenames
 */
export function generateCodenames(count: number, prefix?: string): string[] {
  return Array.from({ length: count }, (_, i) => generateCodename(i, prefix));
}

/**
 * Create a mapping between real IDs and codenames
 * @param realIds - Array of real stream IDs
 * @param prefix - Optional prefix
 * @returns Map of real ID to codename
 */
export function createCodenameMapping(realIds: string[], prefix?: string): Map<string, string> {
  const mapping = new Map<string, string>();

  realIds.forEach((id, index) => {
    mapping.set(id, generateCodename(index, prefix));
  });

  return mapping;
}

/**
 * Get a codename from a stream ID
 * Extracts the index from IDs like "vidsrc-cloudnestra-0" and generates a codename
 * @param streamId - The stream ID
 * @param prefix - Optional prefix
 * @returns A codename or the original ID if pattern doesn't match
 */
export function getCodenameFromId(streamId: string, prefix: string = 'Server'): string {
  // Try to extract index from common patterns:
  // - "provider-server-0" -> 0
  // - "provider-server-1" -> 1
  // - "server-quality" -> use quality as suffix
  const indexMatch = streamId.match(/-(\d+)$/);

  if (indexMatch) {
    const index = parseInt(indexMatch[1], 10);
    return generateCodename(index, prefix);
  }

  // If no index found, try to extract quality suffix
  const qualityMatch = streamId.match(/-(360|480|720|1080|4k)$/i);
  if (qualityMatch) {
    const quality = qualityMatch[1];
    // Use a hash of the base ID to get a consistent codename
    const baseId = streamId.replace(/-[^-]+$/, '');
    const hash = simpleHash(baseId);
    const index = hash % SERVER_LETTERS.length;
    return `${generateCodename(index, prefix)} (${quality}p)`;
  }

  // Fallback: use hash of entire ID
  const hash = simpleHash(streamId);
  const index = hash % SERVER_LETTERS.length;
  return generateCodename(index, prefix);
}

/**
 * Auto-assign displayName to stream objects
 * Automatically adds displayName field to streams if not present
 * @param streams - Array of stream objects
 * @param prefix - Optional prefix for codenames
 * @returns Streams with displayName added
 */
export function autoAssignStreamCodenames<T extends { id: string; displayName?: string }>(
  streams: T[],
  prefix: string = 'Server',
): T[] {
  return streams.map((stream, index) => ({
    ...stream,
    displayName: stream.displayName || generateCodename(index, prefix),
  }));
}

import { MovieMedia, ShowMedia } from '..';

// TMDB Proxy (required - no direct access to TMDB)
function getTMDBProxy(): string {
  const proxy = process.env.TMDB_PROXY;
  if (!proxy) {
    throw new Error(
      'Missing TMDB_PROXY environment variable. Deploy tmdb-proxy worker first.\n' +
        'See: tmdb-proxy/README.md for deployment instructions.',
    );
  }
  return proxy;
}

export async function getMovieMediaDetails(id: string): Promise<MovieMedia> {
  const proxyBase = getTMDBProxy();
  const proxyUrl = `${proxyBase}/movie/${id}`;

  const response = await fetch(proxyUrl);

  if (!response.ok) {
    throw new Error(`TMDB Proxy returned ${response.status}: ${response.statusText}`);
  }

  const tmdbData = (await response.json()) as any;

  // Transform TMDB response to MovieMedia format
  const movie: MovieMedia = {
    type: 'movie',
    title: tmdbData.title || tmdbData.original_title,
    releaseYear: tmdbData.release_date ? parseInt(tmdbData.release_date.split('-')[0], 10) : 0,
    tmdbId: id,
    imdbId: tmdbData.imdb_id,
  };

  if (!movie.releaseYear) {
    throw new Error(`${movie.title} has no release year. Assuming unreleased`);
  }

  return movie;
}

export async function getShowMediaDetails(
  id: string,
  _seasonNumber: string,
  _episodeNumber: string,
): Promise<ShowMedia> {
  const proxyBase = getTMDBProxy();
  const proxyUrl = `${proxyBase}/tv/${id}`;

  const response = await fetch(proxyUrl);

  if (!response.ok) {
    throw new Error(`TMDB Proxy returned ${response.status}: ${response.statusText}`);
  }

  const tmdbData = (await response.json()) as any;

  // Transform TMDB response to ShowMedia format
  const show: ShowMedia = {
    type: 'show',
    title: tmdbData.name || tmdbData.original_name,
    releaseYear: tmdbData.first_air_date ? parseInt(tmdbData.first_air_date.split('-')[0], 10) : 0,
    tmdbId: id,
    imdbId: tmdbData.external_ids?.imdb_id,
    season: {
      number: parseInt(_seasonNumber, 10),
      tmdbId: id,
    },
    episode: {
      number: parseInt(_episodeNumber, 10),
      tmdbId: id,
    },
  };

  if (!show.releaseYear) {
    throw new Error(`${show.title} has no first_air_date. Assuming unaired`);
  }

  return show;
}

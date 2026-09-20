'use strict';

/* Senpai Stream — Synthetiq Player video module (contract v3).
 * Source: https://senpai-stream.space (FR films / series / animes).
 * Runtime: isolated JS with global `fetchv2`. No Node.js, no DOM.
 * Evidence (2026-09-20, unauthenticated GET):
 *  - Search:  GET /search/{encodeURIComponent(query)} -> HTML cards linking to
 *             /movie/{slug}, /tv-show/{slug}, /anime/{slug}.
 *  - Details: GET /movie|/tv-show|/anime/{slug} -> <h1>, meta description,
 *             og:image, /genre/ links, /episode/ links (series/anime).
 *  - Episode: GET /episode/{slug}/{season}-{episode} -> watch-component
 *             snapshot with videos=[[{label:"Version Francaise",type:"mp4",
 *             index:0,source:"local"}]]; NO direct mp4/m3u8 in HTML.
 *             Player is gated by Cloudflare Turnstile (cf_turnstile_response)
 *             + ad-wall steps (progressAd/incrementSteps) + login for download.
 *             This module does NOT bypass CAPTCHA / ad-wall / login / DRM:
 *             extractStreamUrl only returns a stream after fetching the
 *             candidate media URL and verifying a non-HTML video payload.
 */

var BASE_URL = 'https://senpai-stream.space';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
var DEFAULT_HEADERS = { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7' };
var MEDIA_HEADERS = { 'User-Agent': UA, Referer: BASE_URL + '/', Origin: BASE_URL };

function httpFetch(url, options) {
  if (typeof fetchv2 !== 'undefined' && fetchv2) return fetchv2(url, options || {});
  return fetch(url, options || {});
}

function toAbsolute(href) {
  if (!href) return null;
  var h = String(href).trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.indexOf('//') === 0) return 'https:' + h;
  if (h.charAt(0) === '/') return BASE_URL + h;
  return BASE_URL + '/' + h;
}

/* Read a fetchv2/fetch response as text, tolerating runtime differences. */
async function readText(resp) {
  if (!resp) throw new Error('EMPTY_RESPONSE');
  if (typeof resp.text === 'function') return await resp.text();
  if (typeof resp.text === 'string') return resp.text;
  if (typeof resp.body === 'string') return resp.body;
  if (resp.body != null && typeof resp.body.text === 'function') return await resp.body.text();
  if (typeof resp.arrayBuffer === 'function') {
    var buf = await resp.arrayBuffer();
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(buf);
    return String(buf);
  }
  throw new Error('UNREADABLE_RESPONSE');
}

/* Read a response as JSON. Handles response.json as async method OR plain
 * value, then falls back to body / text parsing. Required by module rules. */
async function readJson(resp) {
  if (!resp) throw new Error('EMPTY_RESPONSE');
  try {
    if (typeof resp.json === 'function') return await resp.json();
  } catch (e) { /* fall through to body/text */ }
  if (resp.json != null && typeof resp.json === 'object') return resp.json;
  if (typeof resp.body === 'object' && resp.body !== null) return resp.body;
  var raw = null;
  try {
    if (typeof resp.body === 'string' && resp.body) raw = resp.body;
    else raw = await readText(resp);
  } catch (e) { raw = null; }
  if (typeof raw === 'string' && raw) return JSON.parse(raw);
  throw new Error('UNREADABLE_JSON_RESPONSE');
}

async function fetchHtml(url) {
  var resp = await httpFetch(url, { method: 'GET', headers: DEFAULT_HEADERS });
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status === 404) throw new Error('NOT_FOUND: ' + url);
  if (status < 200 || status >= 400) throw new Error('HTTP_' + status + ': ' + url);
  var html = await readText(resp);
  if (!html || !html.length) throw new Error('EMPTY_HTML: ' + url);
  return html;
}

function decodeEntities(s) {
  if (s == null) return '';
  var out = String(s);
  out = out.replace(/&#0*39;|&#x27;|&apos;/gi, "'");
  out = out.replace(/&quot;/g, '"');
  out = out.replace(/&amp;/g, '&');
  out = out.replace(/&lt;/g, '<');
  out = out.replace(/&gt;/g, '>');
  out = out.replace(/&nbsp;/g, ' ');
  out = out.replace(/&#(\d+);/g, function (m, n) {
    try { return String.fromCharCode(parseInt(n, 10)); } catch (e) { return m; }
  });
  out = out.replace(/&#x([0-9a-f]+);/gi, function (m, n) {
    try { return String.fromCharCode(parseInt(n, 16)); } catch (e) { return m; }
  });
  return out;
}

function stripTags(s) {
  return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function detailKind(url) {
  var u = String(url || '');
  if (u.indexOf('/movie/') >= 0) return 'movie';
  if (u.indexOf('/tv-show/') >= 0) return 'tv';
  if (u.indexOf('/anime/') >= 0) return 'anime';
  return 'video';
}

function pickImage(fragment) {
  var m = fragment.match(/data-src="(https:[^"]+?)"/);
  if (m && m[1].indexOf('data:image') !== 0) return m[1].split('?')[0].split(' ')[0];
  var all = fragment.match(/src="(https:[^"]+?)"/g) || [];
  for (var i = 0; i < all.length; i++) {
    var u = all[i].slice(5, -1);
    if (u.indexOf('data:image') === 0) continue;
    if (u.indexOf('sprite.svg') >= 0) continue;
    if (u.indexOf('abonnements.png') >= 0) continue;
    return u.split('?')[0].split(' ')[0];
  }
  return null;
}

/* Parse detail cards (/movie|/tv-show|/anime) from any listing HTML. */
function parseCards(html) {
  var out = [];
  var seen = {};
  var re = /(https:\/\/senpai-stream\.space\/(?:movie|tv-show|anime)\/[a-z0-9\-]+)/g;
  var m;
  while ((m = re.exec(html))) {
    var url = m[1];
    if (seen[url]) continue;
    seen[url] = true;
    var pos = m.index;
    var ctx = html.slice(pos, Math.min(html.length, pos + 3500));
    var title = null;
    var alt = ctx.match(/alt="([^"]{1,200})"/);
    if (alt) title = decodeEntities(alt[1]).trim();
    if (!title) {
      var h3 = ctx.match(/<h3[^>]*>([\s\S]{0,300}?)<\/h3>/);
      if (h3) title = stripTags(h3[1]);
    }
    if (!title || /^(film|serie|s[eé]rie|anim[eé]|saison|episode)$/i.test(title)) {
      var slug = url.split('/').pop() || '';
      title = decodeEntities(slug.replace(/-/g, ' ')).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    var image = pickImage(ctx);
    var year = null;
    var ym = ctx.match(/\b((?:19|20)\d{2})\b/);
    if (ym) year = ym[1];
    var kind = detailKind(url);
    out.push({
      id: url, url: url, href: url,
      title: title, name: title,
      image: image, poster: image, thumbnail: image,
      type: kind, kind: kind, year: year
    });
  }
  return out;
}

function parseDetails(html, url) {
  var title = null;
  var h1 = html.match(/<h1[^>]*>([\s\S]{0,800}?)<\/h1>/);
  if (h1) title = stripTags(h1[1]);
  if (!title) {
    var og = html.match(/<meta property="og:title" content="([^"]{1,300})"/);
    if (og) title = decodeEntities(og[1]);
  }
  if (!title) {
    var t = html.match(/<title[^>]*>([\s\S]{0,200})<\/title>/);
    if (t) title = stripTags(t[1]).split('|')[0].split('-')[0].trim();
  }
  var desc = null;
  var md = html.match(/<meta name="description" content="([^"]{0,2000})"/);
  if (md) desc = decodeEntities(md[1]).trim();
  if (!desc) {
    var ps = html.match(/<p[^>]*>([\s\S]{0,1500}?)<\/p>/g) || [];
    for (var i = 0; i < ps.length; i++) {
      var txt = stripTags(ps[i]);
      if (txt.length > 60 && txt.indexOf('Senpai-Stream est une plateforme') < 0) { desc = txt; break; }
    }
  }
  var image = null;
  var ogi = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (ogi) image = ogi[1];
  var genres = [];
  var gr = /\/genre\/[^"]*"[^>]*>([^<]{1,60})</g;
  var gm;
  while ((gm = gr.exec(html))) {
    var g = decodeEntities(gm[1]).trim();
    if (g && genres.indexOf(g) < 0) genres.push(g);
  }
  var year = null;
  var ym = html.match(/\b((?:19|20)\d{2})\b/);
  if (ym) year = ym[1];
  var kind = detailKind(url);
  if (!title) title = url;
  return {
    id: url, url: url, href: url,
    title: title, name: title,
    description: desc || '', synopsis: desc || '',
    image: image, poster: image, thumbnail: image,
    genres: genres, genre: genres.join(', '),
    year: year, type: kind, kind: kind
  };
}

/* Parse episode links from a detail or episode page. */
function parseEpisodes(html, baseHint) {
  var out = [];
  var seen = {};
  var re = /<a[^>]*href="([^"]*\/episode\/[a-z0-9\-]+\/[0-9]+-[0-9]+[^"]*)"[^>]*>([\s\S]{0,2000}?)<\/a>/g;
  var m;
  while ((m = re.exec(html))) {
    var url = toAbsolute(decodeEntities(m[1]));
    if (!url || seen[url]) continue;
    seen[url] = true;
    var inner = stripTags(m[2]);
    var se = url.match(/\/episode\/([a-z0-9\-]+)\/([0-9]+)-([0-9]+)/);
    var season = se ? parseInt(se[2], 10) : null;
    var ep = se ? parseInt(se[3], 10) : null;
    var title = inner || ((season != null ? 'Saison ' + season + ' ' : '') + 'Episode ' + (ep != null ? ep : url));
    title = title.replace(/\s+/g, ' ').trim().slice(0, 220);
    out.push({
      id: url, url: url, href: url,
      title: title, name: title,
      season: season, episode: ep, number: ep,
      show: baseHint || null
    });
  }
  /* Fallback: bare href scan (covers server-rendered lists without anchors). */
  if (!out.length) {
    var re2 = /\/episode\/[a-z0-9\-]+\/[0-9]+-[0-9]+/g;
    var m2;
    while ((m2 = re2.exec(html))) {
      var u2 = toAbsolute(m2[0]);
      if (!u2 || seen[u2]) continue;
      seen[u2] = true;
      var se2 = u2.match(/\/([0-9]+)-([0-9]+)\/?$/);
      var s2 = se2 ? parseInt(se2[1], 10) : null;
      var e2 = se2 ? parseInt(se2[2], 10) : null;
      var t2 = (s2 != null ? 'Saison ' + s2 + ' ' : '') + 'Episode ' + (e2 != null ? e2 : u2);
      out.push({ id: u2, url: u2, href: u2, title: t2, name: t2, season: s2, episode: e2, number: e2, show: baseHint || null });
    }
  }
  out.sort(function (a, b) {
    if (a.season !== b.season) return (a.season || 0) - (b.season || 0);
    return (a.episode || 0) - (b.episode || 0);
  });
  return out;
}

/* Labels declared by the watch-component snapshot, e.g.
 * [{label:"Version Francaise", type:"mp4", source:"local"}]. */
function parseDeclaredVersions(html) {
  var versions = [];
  var re = /&quot;label&quot;:&quot;([^&]+?)&quot;,&quot;type&quot;:&quot;([^&]+?)&quot;,&quot;index&quot;:(\d+),&quot;source&quot;:&quot;([^&]+?)&quot;/g;
  var m;
  while ((m = re.exec(html))) {
    versions.push({
      label: decodeEntities(m[1]).replace(/\\u00e7/g, 'c').replace(/\\/g, ''),
      type: m[2], index: parseInt(m[3], 10), source: m[4]
    });
  }
  return versions;
}

function findMediaUrls(html) {
  var found = [];
  var seen = {};
  function push(u, via) {
    if (!u) return;
    var url = String(u).replace(/\\\//g, '/').trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (url.indexOf('youtube.com') >= 0 || url.indexOf('youtube-nocookie') >= 0) return;
    if (url.indexOf('data:image') === 0) return;
    if (seen[url]) return;
    seen[url] = true;
    found.push({ url: url, via: via || 'page' });
  }
  var m;
  var reM3 = /https?:[^"'\s<>\\]*\.m3u8[^"'\s<>\\]*/g;
  while ((m = reM3.exec(html))) push(decodeEntities(m[0]), 'm3u8-scan');
  var reMp4 = /https?:[^"'\s<>\\]*\.mp4[^"'\s<>\\]*/g;
  while ((m = reMp4.exec(html))) push(decodeEntities(m[0]), 'mp4-scan');
  var reIf = /<iframe[^>]*src="([^"]+)"/g;
  while ((m = reIf.exec(html))) {
    var src = m[1].trim();
    if (!src || src === 'iframeSrc' || src.indexOf('{{') >= 0) continue;
    if (src.indexOf('youtube') >= 0) continue;
    push(src.charAt(0) === '/' ? toAbsolute(src) : src, 'iframe');
  }
  return found;
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') {
    try { return headers.get(name); } catch (e) { return null; }
  }
  for (var k in headers) {
    if (k && k.toLowerCase() === String(name).toLowerCase()) return headers[k];
  }
  return null;
}

/* Verify a candidate is real media: reject HTML / empty / error payloads. */
async function verifyMedia(url, headers) {
  var resp = await httpFetch(url, {
    method: 'GET',
    headers: Object.assign({}, headers || {}, { Range: 'bytes=0-65535' })
  });
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status === 404 || status === 410) throw new Error('MEDIA_NOT_FOUND: ' + url);
  if (status >= 400 && status !== 416) throw new Error('MEDIA_HTTP_' + status + ': ' + url);
  var ctype = headerValue(resp.headers, 'content-type') || '';
  if (/text\/html/i.test(String(ctype))) throw new Error('MEDIA_HTML_REJECTED: ' + url);
  var bodyText = '';
  try { bodyText = await readText(resp); } catch (e) { bodyText = ''; }
  if (!bodyText || !bodyText.length) throw new Error('MEDIA_EMPTY: ' + url);
  var head = bodyText.slice(0, 2000).toLowerCase();
  if (head.indexOf('<html') >= 0 || head.indexOf('<!doctype html') >= 0) {
    throw new Error('MEDIA_HTML_REJECTED: ' + url);
  }
  var isHls = /\.m3u8(\?|#|$)/i.test(url) || bodyText.slice(0, 7) === '#EXTM3U' || /application\/.*mpegurl/i.test(String(ctype));
  return { contentType: ctype || (isHls ? 'application/x-mpegURL' : 'video/mp4'), isHls: !!isHls };
}

function normalizeId(id) {
  if (id == null) throw new Error('EMPTY_ID');
  var s = String(id).trim();
  if (!s) throw new Error('EMPTY_ID');
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '/') return toAbsolute(s);
  if (/^(movie|tv-show|anime|episode)\//.test(s)) return toAbsolute('/' + s);
  return s;
}

globalThis.searchResults = async function (query) {
  var q = String(query == null ? '' : query).trim();
  if (!q) return [];
  var url = BASE_URL + '/search/' + encodeURIComponent(q);
  var html = await fetchHtml(url);
  return parseCards(html);
};

globalThis.extractDetails = async function (id) {
  var url = normalizeId(id);
  if (url.indexOf('http') !== 0) {
    /* Bare slug: probe the three detail routes in order. */
    var probes = [BASE_URL + '/anime/' + url, BASE_URL + '/tv-show/' + url, BASE_URL + '/movie/' + url];
    var lastErr = null;
    for (var i = 0; i < probes.length; i++) {
      try {
        var h = await fetchHtml(probes[i]);
        return parseDetails(h, probes[i]);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('NOT_FOUND: ' + id);
  }
  var html = await fetchHtml(url);
  return parseDetails(html, url);
};

globalThis.extractEpisodes = async function (id) {
  var url = normalizeId(id);
  if (/\/episode\//.test(url)) {
    /* An episode URL was given: list siblings from its own page. */
    var h = await fetchHtml(url);
    var eps = parseEpisodes(h, url);
    if (eps.length) return eps;
    return [{ id: url, url: url, href: url, title: 'Episode', name: 'Episode', season: null, episode: 1, number: 1, show: url }];
  }
  var html = await fetchHtml(url);
  var episodes = parseEpisodes(html, url);
  if (episodes.length) return episodes;
  if (/^\/(movie)\//.test(url.replace(BASE_URL, '')) || detailKind(url) === 'movie') {
    var d = parseDetails(html, url);
    return [{ id: url, url: url, href: url, title: d.title || 'Film', name: d.title || 'Film', season: null, episode: 1, number: 1, show: url }];
  }
  return [];
};

globalThis.extractStreamUrl = async function (episodeHref, lang) {
  var url = normalizeId(episodeHref);
  var html = await fetchHtml(url);
  var versions = parseDeclaredVersions(html);
  var wanted = versions;
  if (lang) {
    var l = String(lang).toLowerCase();
    var matched = versions.filter(function (v) { return v.label && v.label.toLowerCase().indexOf(l) >= 0; });
    if (matched.length) wanted = matched;
  }
  var label = wanted.length ? wanted[0].label : 'Version Francaise';
  var candidates = findMediaUrls(html);

  /* One level of dynamic resolution: non-YouTube iframe embeds are
   * fetched and scanned for mp4/m3u8 (temporary links resolved live). */
  var embeds = candidates.filter(function (c) { return c.via === 'iframe'; }).slice(0, 3);
  for (var i = 0; i < embeds.length; i++) {
    try {
      var eh = await fetchHtml(embeds[i].url);
      var inner = findMediaUrls(eh);
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].via !== 'iframe') candidates.push(inner[j]);
      }
    } catch (e) { /* embed unreadable: keep evidence, try next */ }
  }

  var direct = candidates.filter(function (c) { return c.via !== 'iframe'; });
  var errors = [];
  for (var k = 0; k < direct.length; k++) {
    var headers = Object.assign({}, MEDIA_HEADERS, { Referer: url });
    try {
      var info = await verifyMedia(direct[k].url, headers);
      var stream = {
        label: label + (info.isHls ? ' (HLS)' : ''),
        url: direct[k].url,
        headers: headers,
        type: info.isHls ? 'm3u8' : (wanted[0] && wanted[0].type) || 'mp4',
        source: (wanted[0] && wanted[0].source) || 'local',
        via: direct[k].via
      };
      return { streams: [stream], subtitles: [] };
    } catch (e) { errors.push(e && e.message ? e.message : String(e)); }
  }

  if (!direct.length) {
    throw new Error(
      'STREAM_GATED: no direct media URL is exposed on ' + url +
      ' (declared versions: ' + JSON.stringify(versions.map(function (v) { return v.label; })) +
      '). Playback requires the site Cloudflare Turnstile + ad-wall steps and was not bypassed.' +
      (errors.length ? ' Checks: ' + errors.join(' | ') : '')
    );
  }
  throw new Error('STREAM_UNVERIFIED: ' + errors.join(' | '));
};

/* ---- Discovery (supported: static listing pages, no login) ---- */

var DISCOVERY_SECTIONS = [
  { id: 'home', title: 'Accueil', url: BASE_URL + '/' },
  { id: 'trending', title: 'Tendances', url: BASE_URL + '/trending' },
  { id: 'movies', title: 'Films', url: BASE_URL + '/movies' },
  { id: 'tv-shows', title: 'Series', url: BASE_URL + '/tv-shows' },
  { id: 'animes', title: 'Animes', url: BASE_URL + '/animes' },
  { id: 'browse-movies', title: 'Nouveaux films', url: BASE_URL + '/browse?type=movie&sort=created_at' },
  { id: 'browse-tv', title: 'Nouvelles series', url: BASE_URL + '/browse?type=tv&sort=created_at' }
];

globalThis.discoveryHome = async function () {
  var sections = [];
  for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
    var s = DISCOVERY_SECTIONS[i];
    try {
      var html = await fetchHtml(s.url);
      var items = parseCards(html).slice(0, 30);
      sections.push({ id: s.id, title: s.title, items: items });
    } catch (e) {
      sections.push({ id: s.id, title: s.title, items: [], error: e && e.message ? e.message : String(e) });
    }
  }
  return sections;
};

globalThis.discoveryFeed = async function (sectionId, page) {
  var id = String(sectionId || 'trending').trim();
  var target = null;
  for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
    if (DISCOVERY_SECTIONS[i].id === id) { target = DISCOVERY_SECTIONS[i]; break; }
  }
  if (!target) target = DISCOVERY_SECTIONS[1];
  var url = target.url;
  if (page && Number(page) > 1) {
    url += (url.indexOf('?') >= 0 ? '&' : '?') + 'page=' + Number(page);
  }
  var html = await fetchHtml(url);
  return { id: target.id, title: target.title, items: parseCards(html).slice(0, 30) };
};

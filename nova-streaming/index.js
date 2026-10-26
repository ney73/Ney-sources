'use strict';

var BASE_URL = 'https://watchnova.win';
var CATALOG_URL = BASE_URL + '/api/catalog';
var UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
var DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7',
  Referer: BASE_URL + '/'
};
var MEDIA_HEADERS = {
  'User-Agent': UA,
  Accept: '*/*',
  'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.7',
  Referer: BASE_URL + '/',
  Origin: BASE_URL
};
var CATALOG_TTL_MS = 300000;
var REQUEST_TIMEOUT_MS = 20000;
var PAGE_SIZE = 30;

var catalogCache = null;
var catalogInFlight = null;

function httpFetch(url, options) {
  var opts = options || {};
  var fetchImpl = null;
  if (typeof fetchv2 !== 'undefined' && fetchv2) fetchImpl = fetchv2;
  else if (typeof fetch !== 'undefined' && fetch) fetchImpl = fetch;
  if (!fetchImpl) return Promise.reject(new Error('NO_FETCH_IMPLEMENTATION'));
  if (typeof AbortController !== 'undefined' && !opts.signal && typeof setTimeout === 'function') {
    var controller = new AbortController();
    var timer = setTimeout(function () {
      try { controller.abort(); } catch (e) {}
    }, REQUEST_TIMEOUT_MS);
    var withSignal = Object.assign({}, opts, { signal: controller.signal });
    var pending;
    try {
      pending = fetchImpl(url, withSignal);
    } catch (e) {
      clearTimeout(timer);
      return Promise.reject(e);
    }
    return Promise.resolve(pending).then(function (resp) {
      clearTimeout(timer);
      return resp;
    }, function (err) {
      clearTimeout(timer);
      throw err;
    });
  }
  return Promise.resolve(fetchImpl(url, opts));
}

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

async function readJson(resp) {
  if (!resp) throw new Error('EMPTY_RESPONSE');
  try {
    if (typeof resp.json === 'function') return await resp.json();
  } catch (e) {}
  if (resp.json != null && typeof resp.json === 'object') return resp.json;
  if (resp.body != null && typeof resp.body === 'object' && typeof resp.body !== 'function') return resp.body;
  var raw = null;
  try {
    if (typeof resp.body === 'string' && resp.body) raw = resp.body;
    else raw = await readText(resp);
  } catch (e) {
    raw = null;
  }
  if (typeof raw === 'string' && raw) return JSON.parse(raw);
  throw new Error('UNREADABLE_JSON_RESPONSE');
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

async function fetchWithRetry(url, options, attempts) {
  var max = attempts || 2;
  var last = null;
  for (var i = 0; i < max; i++) {
    try {
      return await httpFetch(url, options);
    } catch (e) {
      last = e;
    }
    if (i < max - 1 && typeof setTimeout === 'function') {
      await new Promise(function (resolve) { setTimeout(resolve, 250 * (i + 1)); });
    }
  }
  throw last || new Error('FETCH_FAILED: ' + url);
}

async function fetchText(url, headers) {
  var resp = await fetchWithRetry(url, { method: 'GET', headers: headers || DEFAULT_HEADERS }, 2);
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status === 404) throw new Error('NOT_FOUND: ' + url);
  if (status < 200 || status >= 400) throw new Error('HTTP_' + status + ': ' + url);
  var text = await readText(resp);
  if (!text || !text.length) throw new Error('EMPTY_BODY: ' + url);
  return text;
}

async function fetchJson(url, headers) {
  var resp = await fetchWithRetry(url, { method: 'GET', headers: headers || DEFAULT_HEADERS }, 2);
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status === 404) throw new Error('NOT_FOUND: ' + url);
  if (status < 200 || status >= 400) throw new Error('HTTP_' + status + ': ' + url);
  return await readJson(resp);
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

function toAbsolute(href) {
  if (!href) return null;
  var h = String(href).trim();
  if (/^https?:\/\//i.test(h)) return h;
  if (h.indexOf('//') === 0) return 'https:' + h;
  if (h.charAt(0) === '/') return BASE_URL + h;
  return BASE_URL + '/' + h;
}

function resolveUrl(base, rel) {
  if (!rel) return base;
  var r = String(rel).trim();
  if (/^https?:\/\//i.test(r)) return r;
  if (r.indexOf('//') === 0) return 'https:' + r;
  var originMatch = String(base).match(/^https?:\/\/[^\/]+/i);
  var origin = originMatch ? originMatch[0] : BASE_URL;
  if (r.charAt(0) === '/') return origin + r;
  var clean = String(base).replace(/[?#].*$/, '');
  var dir = clean.replace(/\/[^\/]*$/, '/');
  return dir + r;
}

function hostOf(url) {
  var m = String(url || '').match(/^https?:\/\/([^\/?#]+)/i);
  return m ? m[1].toLowerCase().replace(/:\d+$/, '') : '';
}

function pathOf(url) {
  var m = String(url || '').match(/^https?:\/\/[^\/]+(\/[^?#]*)?/i);
  return m && m[1] ? m[1] : '';
}

function providerOf(url) {
  var h = hostOf(url);
  if (!h) return 'embed';
  if (/(^|\.)uqload\.(vc|is|com|to|co)$/i.test(h) || h.indexOf('uqload.') >= 0) return 'uqload';
  if (/(^|\.)heiwastream\.fr$/i.test(h)) return 'heiwastream';
  if (/(^|\.)voe\.sx$/i.test(h)) return 'voe';
  if (/(^|\.)vidzy\./i.test(h)) return 'vidzy';
  if (/(^|\.)playmogo\./i.test(h)) return 'playmogo';
  if (/(^|\.)movix\./i.test(h)) return 'movix';
  if (/(^|\.)vidmoly\./i.test(h)) return 'vidmoly';
  if (/(^|\.)dood\./i.test(h)) return 'dood';
  if (/(^|\.)streamtape\./i.test(h)) return 'streamtape';
  if (/(^|\.)sibnet\./i.test(h)) return 'sibnet';
  return h;
}

function normalizeText(s) {
  var out = String(s == null ? '' : s).toLowerCase();
  try {
    out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {}
  out = out.replace(/[^a-z0-9]+/g, ' ');
  return out.replace(/\s+/g, ' ').trim();
}

function slugify(s) {
  var t = normalizeText(s);
  return t ? t.replace(/\s+/g, '-') : 'titre';
}

function compareStrings(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function normalizeId(id) {
  if (id == null) throw new Error('EMPTY_ID');
  var s = String(id).trim();
  if (!s) throw new Error('EMPTY_ID');
  if (/^https?:\/\//i.test(s)) {
    var q = s.match(/[?&]id=([^&]+)/);
    if (q) return decodeURIComponent(q[1]);
    var m = s.match(/(movie-\d+|tv-\d+(?:-s\d+e\d+)?)/);
    if (m) return m[1];
    return s;
  }
  return s;
}

async function loadCatalog(force) {
  var now = Date.now();
  if (!force && catalogCache && (now - catalogCache.at) < CATALOG_TTL_MS) return catalogCache.items;
  if (!force && catalogInFlight) return await catalogInFlight;
  var pending = (async function () {
    var data = await fetchJson(CATALOG_URL + '?v=' + now, DEFAULT_HEADERS);
    var items = data && Array.isArray(data.items) ? data.items : [];
    if (!items.length) throw new Error('EMPTY_CATALOG');
    catalogCache = { at: Date.now(), items: items };
    return items;
  })();
  catalogInFlight = pending;
  try {
    return await pending;
  } finally {
    catalogInFlight = null;
  }
}

function findByAnyId(items, id) {
  var s = String(id == null ? '' : id).trim();
  if (!s) return null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    if (String(it.id) === s) return it;
    if (it.tmdbId != null && String(it.tmdbId) === s) return it;
  }
  return null;
}

function cardFromItem(item) {
  if (!item) return null;
  var isFilm = item.type === 'film';
  var mediaType = isFilm ? 'movie' : 'tv';
  var url = BASE_URL + '/' + (isFilm ? 'films' : 'series') + '/' + slugify(item.title) + '?id=' + encodeURIComponent(item.id);
  var image = item.poster || item.backdrop || null;
  return {
    id: String(item.id),
    url: url,
    href: url,
    title: item.title || '',
    name: item.title || '',
    originalTitle: item.originalTitle || '',
    image: image,
    poster: image,
    thumbnail: item.backdrop || item.poster || null,
    backdrop: item.backdrop || null,
    logo: item.logo || null,
    description: item.synopsis || '',
    synopsis: item.synopsis || '',
    genres: Array.isArray(item.genres) ? item.genres : [],
    genre: Array.isArray(item.genres) ? item.genres.join(', ') : '',
    year: item.year || '',
    releaseDate: item.releaseDate || '',
    rating: item.voteAverage || null,
    voteAverage: item.voteAverage || null,
    type: mediaType,
    kind: item.type || mediaType,
    mediaType: item.type || mediaType,
    tmdbId: item.tmdbId != null ? item.tmdbId : null,
    seasons: item.seasons || 0,
    duration: item.duration || '',
    premium: !!item.premium,
    trailer: item.trailerUrl || null
  };
}

function detailsFromItem(item) {
  var base = cardFromItem(item);
  if (!base) return null;
  base.cast = Array.isArray(item.cast) ? item.cast : [];
  base.directors = Array.isArray(item.directors) ? item.directors : [];
  base.studios = Array.isArray(item.studios) ? item.studios : [];
  base.productionCountries = Array.isArray(item.productionCountries) ? item.productionCountries : [];
  base.originalLanguage = item.originalLanguage || '';
  base.publishedAt = item.publishedAt || '';
  base.addedAt = item.addedAt || '';
  base.premiumUntil = item.premiumUntil || null;
  base.weeklyViews = item.weeklyViews || 0;
  base.weeklyUniqueViewers = item.weeklyUniqueViewers || 0;
  return base;
}

function searchScore(query, item) {
  var q = normalizeText(query);
  if (!q) return -Infinity;
  var title = normalizeText(item.title);
  var orig = normalizeText(item.originalTitle);
  var genres = normalizeText((item.genres || []).join(' '));
  var year = String(item.year || '');
  var qWords = q.split(' ').filter(Boolean);
  var score = -Infinity;
  if (title === q || orig === q) score = 1000;
  else if (title.indexOf(q) === 0 || orig.indexOf(q) === 0) score = 850;
  else if (title.indexOf(q) >= 0 || orig.indexOf(q) >= 0) score = 700 - Math.abs(title.length - q.length);
  else {
    var hits = 0;
    for (var i = 0; i < qWords.length; i++) {
      var w = qWords[i];
      if (title.indexOf(w) >= 0 || orig.indexOf(w) >= 0 || genres.indexOf(w) >= 0) hits++;
    }
    if (hits === qWords.length && qWords.length > 0) score = 500 + hits * 10;
    else if (hits > 0) score = 300 + hits * 20;
    else if (genres.indexOf(q) >= 0) score = 250;
  }
  if (score === -Infinity) return -Infinity;
  if (/\bfilms?\b/.test(q) && item.type !== 'film') return -Infinity;
  if (/\bseries?\b/.test(q) && item.type !== 'serie') return -Infinity;
  var ym = q.match(/\b((?:19|20)\d{2})\b/);
  if (ym) {
    if (year !== ym[1]) score -= 250;
    else score += 100;
  }
  score += (Number(item.voteAverage) || 0) * 0.5;
  score += Math.min(Number(item.weeklyViews) || 0, 100) * 0.01;
  return score;
}

function sectionItems(items, sectionId) {
  var id = String(sectionId || 'trending').toLowerCase();
  var list = items.slice();
  if (id === 'films' || id === 'movies') {
    list = list.filter(function (it) { return it.type === 'film'; });
  } else if (id === 'series' || id === 'tv') {
    list = list.filter(function (it) { return it.type === 'serie'; });
  } else if (id === 'new' || id === 'nouveautes') {
    list.sort(function (a, b) {
      var da = String(a.publishedAt || a.addedAt || '');
      var db = String(b.publishedAt || b.addedAt || '');
      if (da !== db) return compareStrings(db, da);
      return compareStrings(String(a.id), String(b.id));
    });
    return list;
  } else if (id === 'trending' || id === 'tendances') {
    list.sort(function (a, b) {
      var fa = (a.trending || a.featured) ? 1 : 0;
      var fb = (b.trending || b.featured) ? 1 : 0;
      if (fa !== fb) return fb - fa;
      var va = Number(a.weeklyViews) || 0;
      var vb = Number(b.weeklyViews) || 0;
      if (va !== vb) return vb - va;
      var ra = Number(a.voteAverage) || 0;
      var rb = Number(b.voteAverage) || 0;
      if (ra !== rb) return rb - ra;
      return compareStrings(String(a.id), String(b.id));
    });
    return list;
  } else {
    var genre = id.replace(/-/g, ' ');
    list = list.filter(function (it) {
      var gs = Array.isArray(it.genres) ? it.genres : [];
      for (var i = 0; i < gs.length; i++) {
        if (normalizeText(gs[i]) === genre) return true;
      }
      return false;
    });
    list.sort(function (a, b) {
      var ra = Number(a.voteAverage) || 0;
      var rb = Number(b.voteAverage) || 0;
      if (ra !== rb) return rb - ra;
      var va = Number(a.weeklyViews) || 0;
      var vb = Number(b.weeklyViews) || 0;
      if (va !== vb) return vb - va;
      return compareStrings(String(a.id), String(b.id));
    });
    return list;
  }
  list.sort(function (a, b) {
    var va = Number(a.weeklyViews) || 0;
    var vb = Number(b.weeklyViews) || 0;
    if (va !== vb) return vb - va;
    var ra = Number(a.voteAverage) || 0;
    var rb = Number(b.voteAverage) || 0;
    if (ra !== rb) return rb - ra;
    return compareStrings(String(a.id), String(b.id));
  });
  return list;
}

async function fetchEpisodes(titleId) {
  var id = String(titleId || '').trim();
  if (!id) return [];
  var data = await fetchJson(BASE_URL + '/api/titles/' + encodeURIComponent(id) + '/episodes', DEFAULT_HEADERS);
  return data && Array.isArray(data.episodes) ? data.episodes : [];
}

function readJsString(src, start) {
  var quote = src.charAt(start);
  if (quote !== '"' && quote !== "'") return null;
  var out = '';
  var i = start + 1;
  while (i < src.length) {
    var ch = src.charAt(i);
    if (ch === '\\') {
      var next = src.charAt(i + 1);
      if (next === 'n') { out += '\n'; i += 2; }
      else if (next === 'r') { out += '\r'; i += 2; }
      else if (next === 't') { out += '\t'; i += 2; }
      else if (next === 'b') { out += '\b'; i += 2; }
      else if (next === 'f') { out += '\f'; i += 2; }
      else if (next === 'v') { out += '\v'; i += 2; }
      else if (next === '0') { out += '\0'; i += 2; }
      else if (next === 'x') {
        var hex2 = src.slice(i + 2, i + 4);
        if (/^[0-9a-f]{2}$/i.test(hex2)) { out += String.fromCharCode(parseInt(hex2, 16)); i += 4; }
        else { out += next; i += 2; }
      } else if (next === 'u') {
        var hex4 = src.slice(i + 2, i + 6);
        if (/^[0-9a-f]{4}$/i.test(hex4)) { out += String.fromCharCode(parseInt(hex4, 16)); i += 6; }
        else { out += next; i += 2; }
      } else if (next === '\n') {
        i += 2;
      } else {
        out += next;
        i += 2;
      }
    } else if (ch === quote) {
      return { value: out, end: i + 1 };
    } else {
      out += ch;
      i++;
    }
  }
  return null;
}

function unpackPacked(html) {
  var source = String(html || '');
  var idx = source.indexOf('eval(function(p,a,c,k,e,d)');
  if (idx < 0) return null;
  var end = source.indexOf('</script>', idx);
  var block = source.slice(idx, end > idx ? end : source.length);
  var at = block.indexOf("}('");
  if (at < 0) return null;
  var payload = readJsString(block, at + 2);
  if (!payload) return null;
  var j = payload.end;
  if (block.charAt(j) !== ',') return null;
  j++;
  var a = '';
  while (j < block.length && /[0-9]/.test(block.charAt(j))) { a += block.charAt(j); j++; }
  if (!a || block.charAt(j) !== ',') return null;
  j++;
  var c = '';
  while (j < block.length && /[0-9]/.test(block.charAt(j))) { c += block.charAt(j); j++; }
  if (!c || block.charAt(j) !== ',') return null;
  j++;
  var k = readJsString(block, j);
  if (!k) return null;
  var p = payload.value;
  var count = parseInt(c, 10);
  var base = parseInt(a, 10);
  var words = k.value.split('|');
  while (count--) {
    if (!words[count]) continue;
    var word = words[count];
    p = p.replace(new RegExp('\\b' + count.toString(base) + '\\b', 'g'), function () { return word; });
  }
  return p;
}

function normalizeMediaUrl(url) {
  return decodeEntities(String(url || '').replace(/\\\//g, '/').replace(/&amp;/g, '&')).trim();
}

function extractUqloadFile(unpacked) {
  if (!unpacked) return null;
  var m = unpacked.match(/sources\s*:\s*\[\s*\{\s*file\s*:\s*["']([^"']+)["']/);
  if (m) return normalizeMediaUrl(m[1]);
  var all = unpacked.match(/https?:[^"'\s<>\\]+\.m3u8[^"'\s<>\\]*/g) || [];
  for (var i = 0; i < all.length; i++) {
    var u = normalizeMediaUrl(all[i]);
    if (u.indexOf('/hls2/') >= 0 || u.indexOf('master.m3u8') >= 0) return u;
  }
  return all.length ? normalizeMediaUrl(all[0]) : null;
}

function uqloadIdFromHls(url) {
  var m = String(url || '').match(/\/hls2\/[^\/]+\/[^\/]+\/([a-z0-9]+)[^\/]*\/(?:master|index[^\/]*)\.m3u8/i);
  return m ? m[1] : null;
}

function uqloadEmbedUrl(url) {
  var hlsId = uqloadIdFromHls(url);
  var host = hostOf(url);
  var dm = host.match(/uqload\.(vc|is|com|to|co)$/i);
  var site = dm ? ('https://uqload.' + dm[1]) : 'https://uqload.vc';
  if (hlsId) return site + '/embed-' + hlsId + '.html';
  var m = String(url || '').match(/^(https?:\/\/[^\/]+)\/(?:embed-)?([a-z0-9]+)(?:\.html)?\/?$/i);
  if (m) return m[1] + '/embed-' + m[2] + '.html';
  return url;
}

function vidzyIdFromUrl(url) {
  var s = String(url || '');
  var em = s.match(/\/embed-([a-z0-9]+)\.html/i);
  if (em) return em[1];
  var hm = s.match(/[\/,]([a-z0-9]{6,})_[^\/]*\.urlset\//i);
  if (hm) return hm[1];
  var pm = s.match(/^([a-z0-9]{6,})$/i);
  return pm ? pm[1] : null;
}

function vidzyEmbedUrl(url) {
  var s = String(url || '');
  if (/\/embed-[a-z0-9]+\.html/i.test(s)) return s;
  var id = vidzyIdFromUrl(s);
  if (!id) return s;
  var host = hostOf(s);
  var site = 'https://vidzy.cc';
  if (/(^|\.)vidzy\.(org|live)$/i.test(host)) site = 'https://' + host;
  return site + '/embed-' + id + '.html';
}

function qualityLabel(res) {
  var m = String(res || '').match(/\d+x(\d+)/);
  if (!m) return String(res || 'HLS');
  var h = parseInt(m[1], 10);
  if (h >= 1000) return (Math.round(h / 10) * 10) + 'p';
  return h + 'p';
}

function parseHlsMaster(text, masterUrl, headers, source) {
  var out = [];
  if (!text || text.indexOf('#EXTM3U') < 0) return out;
  var lines = String(text).split(/\r?\n/);
  var pending = null;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    if (line.indexOf('#EXT-X-STREAM-INF:') === 0) {
      pending = line;
      continue;
    }
    if (pending && line.charAt(0) !== '#') {
      var url = resolveUrl(masterUrl, line);
      var res = (pending.match(/RESOLUTION=(\d+x\d+)/i) || [])[1] || '';
      var bw = (pending.match(/BANDWIDTH=(\d+)/i) || [])[1] || '';
      out.push({
        label: (source ? source + ' ' : '') + (res ? qualityLabel(res) : (bw ? Math.round(Number(bw) / 1000) + ' kbps' : 'HLS')),
        url: url,
        headers: headers,
        type: 'm3u8',
        source: source,
        resolution: res,
        bandwidth: bw
      });
      pending = null;
    }
  }
  return out;
}

async function resolveHls(url, headers, source, labelPrefix) {
  var mediaHeaders = Object.assign({}, headers || MEDIA_HEADERS);
  var resp = await fetchWithRetry(url, { method: 'GET', headers: mediaHeaders }, 2);
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status < 200 || status >= 400) throw new Error('HLS_HTTP_' + status + ': ' + url);
  var text = await readText(resp);
  if (!text || text.indexOf('#EXTM3U') < 0) throw new Error('HLS_INVALID: ' + url);
  var variants = parseHlsMaster(text, url, mediaHeaders, source);
  var prefix = labelPrefix || source || 'HLS';
  if (variants.length) {
    variants.sort(function (a, b) {
      var ha = parseInt(((a.resolution || '').match(/\d+x(\d+)/) || [])[1], 10) || 0;
      var hb = parseInt(((b.resolution || '').match(/\d+x(\d+)/) || [])[1], 10) || 0;
      if (ha !== hb) return hb - ha;
      return (Number(b.bandwidth) || 0) - (Number(a.bandwidth) || 0);
    });
    var probe = variants[0];
    var probeResp = await fetchWithRetry(probe.url, { method: 'GET', headers: mediaHeaders }, 1);
    var probeStatus = probeResp != null && probeResp.status != null ? probeResp.status : 200;
    var probeText = '';
    try { probeText = await readText(probeResp); } catch (e) { probeText = ''; }
    if (probeStatus < 200 || probeStatus >= 400 || !probeText || probeText.indexOf('#EXTM3U') < 0 ||
        (probeText.indexOf('#EXTINF') < 0 && probeText.indexOf('#EXT-X-TARGETDURATION') < 0)) {
      throw new Error('HLS_VARIANT_INVALID: ' + probe.url);
    }
    var streams = [{ label: prefix + ' Auto', url: url, headers: mediaHeaders, type: 'm3u8', source: source, resolution: 'auto' }];
    for (var i = 0; i < variants.length; i++) streams.push(variants[i]);
    return streams;
  }
  if (text.indexOf('#EXTINF') >= 0 || text.indexOf('#EXT-X-TARGETDURATION') >= 0) {
    return [{ label: prefix + ' HLS', url: url, headers: mediaHeaders, type: 'm3u8', source: source, resolution: 'auto' }];
  }
  throw new Error('HLS_NO_VARIANTS: ' + url);
}

async function verifyMedia(url, headers) {
  var h = Object.assign({}, headers || MEDIA_HEADERS, { Range: 'bytes=0-4095' });
  var resp = await fetchWithRetry(url, { method: 'GET', headers: h }, 2);
  var status = resp != null && resp.status != null ? resp.status : 200;
  if (status === 404 || status === 410) throw new Error('MEDIA_NOT_FOUND: ' + url);
  if (status >= 400 && status !== 416) throw new Error('MEDIA_HTTP_' + status + ': ' + url);
  var ctype = headerValue(resp.headers, 'content-type') || '';
  if (/text\/html/i.test(String(ctype))) throw new Error('MEDIA_HTML_REJECTED: ' + url);
  var bytes = null;
  try {
    if (typeof resp.arrayBuffer === 'function') bytes = new Uint8Array(await resp.arrayBuffer());
  } catch (e) {
    bytes = null;
  }
  if (bytes) {
    if (!bytes.length) throw new Error('MEDIA_EMPTY: ' + url);
    var head = '';
    for (var i = 0; i < Math.min(bytes.length, 200); i++) head += String.fromCharCode(bytes[i]);
    if (/<html|<!doctype/i.test(head)) throw new Error('MEDIA_HTML_REJECTED: ' + url);
    var isMp4 = bytes.length >= 8 && String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]) === 'ftyp';
    var isHls = /\.m3u8(\?|#|$)/i.test(url) || /mpegurl/i.test(String(ctype));
    return { isHls: isHls, isMp4: isMp4, contentType: ctype };
  }
  var text = '';
  try { text = await readText(resp); } catch (e) { text = ''; }
  if (!text || !text.length) throw new Error('MEDIA_EMPTY: ' + url);
  var head2 = text.slice(0, 2000).toLowerCase();
  if (head2.indexOf('<html') >= 0 || head2.indexOf('<!doctype') >= 0) throw new Error('MEDIA_HTML_REJECTED: ' + url);
  var isHls2 = /\.m3u8(\?|#|$)/i.test(url) || text.slice(0, 7) === '#EXTM3U' || /mpegurl/i.test(String(ctype));
  return { isHls: isHls2, isMp4: false, contentType: ctype };
}

function findMediaUrls(html) {
  var out = [];
  var seen = {};
  function push(u, via) {
    if (!u) return;
    var url = normalizeMediaUrl(u);
    if (!/^https?:\/\//i.test(url)) return;
    if (/youtube\.com|youtube-nocookie/i.test(url)) return;
    if (/data:image/i.test(url)) return;
    if (/fsvid\.lol|\/troll\//i.test(url)) return;
    if (seen[url]) return;
    seen[url] = true;
    out.push({ url: url, via: via || 'scan' });
  }
  var m;
  var reSource = /sources\s*:\s*\[\s*\{[^}]*?["']?(?:src|file)["']?\s*:\s*["']([^"']+)["']/g;
  while ((m = reSource.exec(html))) push(m[1], 'source');
  var reFile = /["']file["']\s*:\s*["']([^"']+)["']/g;
  while ((m = reFile.exec(html))) push(m[1], 'file');
  var reM3 = /https?:[^"'\s<>\\]*\.m3u8[^"'\s<>\\]*/g;
  while ((m = reM3.exec(html))) push(m[0], 'm3u8');
  var reMp4 = /https?:[^"'\s<>\\]*\.mp4[^"'\s<>\\]*/g;
  while ((m = reMp4.exec(html))) push(m[0], 'mp4');
  var reIf = /<iframe[^>]*src=["']([^"']+)["']/g;
  while ((m = reIf.exec(html))) push(m[1], 'iframe');
  return out;
}

async function resolveGeneric(url, provider) {
  var html = await fetchText(url, Object.assign({}, DEFAULT_HEADERS, { Referer: BASE_URL + '/' }));
  var candidates = findMediaUrls(html);
  var mediaHeaders = Object.assign({}, MEDIA_HEADERS, { Referer: url });
  for (var i = 0; i < candidates.length; i++) {
    var c = candidates[i];
    if (c.via === 'iframe') continue;
    if (/\.m3u8(\?|#|$)/i.test(c.url)) {
      try { return await resolveHls(c.url, mediaHeaders, provider); } catch (e) {}
    } else if (/\.mp4(\?|#|$)/i.test(c.url)) {
      try {
        var info = await verifyMedia(c.url, mediaHeaders);
        return [{ label: provider + (info.isHls ? ' HLS' : ' MP4'), url: c.url, headers: mediaHeaders, type: info.isHls ? 'm3u8' : 'mp4', source: provider }];
      } catch (e) {}
    }
  }
  return [];
}

function embedFallback(url, provider) {
  return {
    streams: [{
      label: (provider || 'embed') + ' (embed)',
      url: url,
      headers: Object.assign({}, DEFAULT_HEADERS, { Referer: BASE_URL + '/' }),
      type: 'embed',
      source: provider || 'embed'
    }],
    subtitles: []
  };
}

async function resolveUqload(url) {
  if (/\.m3u8(\?|#|$)/i.test(url) && !uqloadIdFromHls(url)) {
    var directHeaders = Object.assign({}, MEDIA_HEADERS, { Referer: BASE_URL + '/' });
    return await resolveHls(url, directHeaders, 'uqload');
  }
  var embedUrl = uqloadEmbedUrl(url);
  var html = await fetchText(embedUrl, Object.assign({}, DEFAULT_HEADERS, { Referer: BASE_URL + '/' }));
  var unpacked = unpackPacked(html);
  if (!unpacked) throw new Error('UQLOAD_PACKED_NOT_FOUND: ' + embedUrl);
  var file = extractUqloadFile(unpacked);
  if (!file) throw new Error('UQLOAD_FILE_NOT_FOUND: ' + embedUrl);
  var originMatch = embedUrl.match(/^https?:\/\/[^\/]+/i);
  var origin = originMatch ? originMatch[0] : 'https://uqload.vc';
  var headers = Object.assign({}, MEDIA_HEADERS, { Referer: embedUrl, Origin: origin });
  return await resolveHls(file, headers, 'uqload');
}

async function resolveWatchUrl(input) {
  var s = String(input == null ? '' : input).trim();
  if (!s) throw new Error('EMPTY_EPISODE');
  if (/^https?:\/\//i.test(s)) return s;
  var id = normalizeId(s);
  if (/^movie-\d+$/i.test(id)) {
    var items = await loadCatalog();
    var item = findByAnyId(items, id);
    if (item && item.watchUrl) return item.watchUrl;
    throw new Error('NO_WATCH_URL: ' + id);
  }
  var em = id.match(/^(tv-\d+)-s(\d+)e(\d+)$/i);
  if (em) {
    var eps = await fetchEpisodes(em[1]);
    for (var i = 0; i < eps.length; i++) {
      if (String(eps[i].id) === id && eps[i].watchUrl) return eps[i].watchUrl;
    }
    throw new Error('NO_WATCH_URL: ' + id);
  }
  if (/^tv-\d+$/i.test(id)) {
    var eps2 = await fetchEpisodes(id);
    if (eps2.length && eps2[0].watchUrl) return eps2[0].watchUrl;
    throw new Error('NO_WATCH_URL: ' + id);
  }
  var items2 = await loadCatalog();
  var item2 = findByAnyId(items2, id);
  if (item2 && item2.watchUrl) return item2.watchUrl;
  throw new Error('UNKNOWN_EPISODE: ' + id);
}

globalThis.searchResults = async function (query) {
  try {
    var q = String(query == null ? '' : query).trim();
    if (!q) return [];
    var items = await loadCatalog();
    var scored = [];
    for (var i = 0; i < items.length; i++) {
      var s = searchScore(q, items[i]);
      if (s !== -Infinity) scored.push({ item: items[i], score: s });
    }
    scored.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return compareStrings(String(a.item.id), String(b.item.id));
    });
    var out = [];
    for (var j = 0; j < scored.length && out.length < 40; j++) {
      var card = cardFromItem(scored[j].item);
      if (card) out.push(card);
    }
    return out;
  } catch (e) {
    return [];
  }
};

globalThis.extractDetails = async function (id) {
  try {
    var key = normalizeId(id);
    var items = await loadCatalog();
    var item = findByAnyId(items, key);
    if (!item) return [];
    return detailsFromItem(item);
  } catch (e) {
    return [];
  }
};

globalThis.extractEpisodes = async function (id) {
  try {
    var key = normalizeId(id);
    var items = await loadCatalog();
    var item = findByAnyId(items, key);
    if (!item) return [];
    if (item.type === 'film') {
      if (!item.watchUrl) return [];
      return [{
        id: String(item.id),
        url: item.watchUrl,
        href: item.watchUrl,
        title: item.title || 'Film',
        name: item.title || 'Film',
        season: null,
        episode: 1,
        number: 1,
        show: String(item.id),
        watchUrl: item.watchUrl,
        duration: item.duration || null,
        thumbnail: item.backdrop || item.poster || null,
        synopsis: item.synopsis || '',
        type: 'movie',
        kind: 'movie'
      }];
    }
    var eps = await fetchEpisodes(item.id);
    var out = [];
    for (var i = 0; i < eps.length; i++) {
      var ep = eps[i];
      if (!ep || !ep.watchUrl) continue;
      var title = ep.name || ('Saison ' + ep.seasonNumber + ' Episode ' + ep.episodeNumber);
      out.push({
        id: String(ep.id),
        url: ep.watchUrl,
        href: ep.watchUrl,
        title: title,
        name: title,
        season: ep.seasonNumber,
        episode: ep.episodeNumber,
        number: ep.episodeNumber,
        show: String(item.id),
        watchUrl: ep.watchUrl,
        duration: ep.duration || null,
        thumbnail: ep.thumbnailUrl || item.backdrop || null,
        synopsis: ep.synopsis || '',
        premiumUntil: ep.premiumUntil || null,
        type: 'episode',
        kind: 'episode'
      });
    }
    out.sort(function (a, b) {
      if (a.season !== b.season) return (a.season || 0) - (b.season || 0);
      return (a.episode || 0) - (b.episode || 0);
    });
    return out;
  } catch (e) {
    return [];
  }
};

globalThis.extractStreamUrl = async function (episodeHref, lang) {
  var watchUrl = await resolveWatchUrl(episodeHref);
  var provider = providerOf(watchUrl);
  if (provider === 'uqload') {
    try {
      var streams = await resolveUqload(watchUrl);
      return { streams: streams, subtitles: [] };
    } catch (e) {
      return embedFallback(uqloadEmbedUrl(watchUrl), provider);
    }
  }
  if (provider === 'heiwastream') {
    return embedFallback(watchUrl, provider);
  }
  if (/\.m3u8(\?|#|$)/i.test(watchUrl)) {
    var h = Object.assign({}, MEDIA_HEADERS, { Referer: BASE_URL + '/' });
    try {
      var hlsStreams = await resolveHls(watchUrl, h, provider);
      return { streams: hlsStreams, subtitles: [] };
    } catch (e) {
      if (provider === 'vidzy') return embedFallback(vidzyEmbedUrl(watchUrl), provider);
      return {
        streams: [{
          label: provider + ' HLS',
          url: watchUrl,
          headers: h,
          type: 'm3u8',
          source: provider
        }],
        subtitles: []
      };
    }
  }
  if (/\.mp4(\?|#|$)/i.test(watchUrl)) {
    var mh = Object.assign({}, MEDIA_HEADERS, { Referer: BASE_URL + '/' });
    try {
      var info = await verifyMedia(watchUrl, mh);
      return {
        streams: [{
          label: provider + (info.isHls ? ' HLS' : ' MP4'),
          url: watchUrl,
          headers: mh,
          type: info.isHls ? 'm3u8' : 'mp4',
          source: provider
        }],
        subtitles: []
      };
    } catch (e) {
      return embedFallback(watchUrl, provider);
    }
  }
  try {
    var generic = await resolveGeneric(watchUrl, provider);
    if (generic.length) return { streams: generic, subtitles: [] };
  } catch (e) {}
  return embedFallback(provider === 'vidzy' ? vidzyEmbedUrl(watchUrl) : watchUrl, provider);
};

var DISCOVERY_SECTIONS = [
  { id: 'trending', title: 'Tendances' },
  { id: 'new', title: 'Nouveautés' },
  { id: 'films', title: 'Films' },
  { id: 'series', title: 'Séries' },
  { id: 'action', title: 'Action' },
  { id: 'thriller', title: 'Thriller' },
  { id: 'comedie', title: 'Comédie' },
  { id: 'science-fiction', title: 'Science-fiction' },
  { id: 'horreur', title: 'Horreur' },
  { id: 'drame', title: 'Drame' }
];

globalThis.discoveryHome = async function () {
  try {
    var items = await loadCatalog();
    var sections = [];
    for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
      var s = DISCOVERY_SECTIONS[i];
      var list = sectionItems(items, s.id);
      if (!list.length) continue;
      var cards = [];
      for (var j = 0; j < list.length && cards.length < 30; j++) {
        var c = cardFromItem(list[j]);
        if (c) cards.push(c);
      }
      sections.push({ id: s.id, title: s.title, items: cards });
    }
    return sections;
  } catch (e) {
    return [];
  }
};

globalThis.getHome = async function () {
  try {
    var sections = await globalThis.discoveryHome();
    if (!Array.isArray(sections)) return [];
    var out = [];
    var seen = {};
    for (var i = 0; i < sections.length; i++) {
      var items = sections[i] && sections[i].items;
      if (!Array.isArray(items)) continue;
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var key = it && it.id;
        if (!key || seen[key]) continue;
        seen[key] = true;
        out.push(it);
        if (out.length >= 30) return out;
      }
    }
    return out;
  } catch (e) {
    return [];
  }
};

globalThis.discoveryFeed = async function (sectionId, page) {
  var id = String(sectionId || 'trending').trim();
  var target = null;
  for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
    if (DISCOVERY_SECTIONS[i].id === id) { target = DISCOVERY_SECTIONS[i]; break; }
  }
  if (!target) { id = 'trending'; target = DISCOVERY_SECTIONS[0]; }
  try {
    var items = await loadCatalog();
    var list = sectionItems(items, id);
    var p = Math.max(1, parseInt(page, 10) || 1);
    var start = (p - 1) * PAGE_SIZE;
    var slice = list.slice(start, start + PAGE_SIZE);
    var cards = [];
    for (var j = 0; j < slice.length; j++) {
      var c = cardFromItem(slice[j]);
      if (c) cards.push(c);
    }
    var totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
    return {
      id: id,
      title: target.title,
      page: p,
      totalPages: totalPages,
      hasMore: start + PAGE_SIZE < list.length,
      items: cards
    };
  } catch (e) {
    return { id: id, title: target.title, page: 1, totalPages: 1, hasMore: false, items: [] };
  }
};

'use strict';

/* VoirAnime — Synthetiq Player video module (contract v3).
 * Source: https://voir-anime.to (verified active; voiranime.com = NXDOMAIN).
 * Runtime: isolated JS with global `fetchv2`. No optional chaining, no
 * nullish coalescing, no complex async — plain ES5-compatible syntax only.
 * Headers: iPhone Safari UA as specified by module owner.
 * Search route: /?s={query} (302 -> /?post_type=wp-manga&s={query};
 * fetchHtml follows redirects manually so unfollowing runtimes still work).
 * Card selectors (Madara theme, verified 2026-09-23):
 *   - href: https://voir-anime.to/anime/{slug}/  (detail link)
 *   - title: <h3 class="h4"><a>...</a></h3>  or title="..." attr on anchor
 *   - image: <img src="..."> inside div.tab-thumb
 * Detail: /anime/{slug}/ ; episodes: wp-manga-chapter list or chapter select.
 * Does NOT bypass CAPTCHA / login / DRM.
 */

var BASE_URL = 'https://voir-anime.to';
var UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15';
var DEFAULT_HEADERS = {
  'User-Agent': UA,
  Accept: 'text/html,application/xhtml+xml',
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
  } catch (e) { /* fall through */ }
  if (resp.json != null && typeof resp.json === 'object') return resp.json;
  if (resp.body != null && typeof resp.body === 'object') return resp.body;
  var raw = null;
  try {
    if (typeof resp.body === 'string' && resp.body) raw = resp.body;
    else raw = await readText(resp);
  } catch (e) { raw = null; }
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

/* Fetch HTML, manually following 3xx Location headers (up to 5 hops).
 * Some runtimes' fetchv2 does not auto-follow redirects; /?s= returns
 * 302 to /?post_type=wp-manga&s=, so this is required. */
async function fetchHtml(url) {
  var current = url;
  for (var hop = 0; hop < 5; hop++) {
    var resp = await httpFetch(current, { method: 'GET', headers: DEFAULT_HEADERS });
    var status = resp != null && resp.status != null ? resp.status : 200;
    if (status === 404) throw new Error('NOT_FOUND: ' + current);
    if (status >= 300 && status < 400) {
      var loc = headerValue(resp.headers, 'location');
      if (!loc) break;
      current = toAbsolute(loc);
      continue;
    }
    if (status < 200 || status >= 400) throw new Error('HTTP_' + status + ': ' + current);
    var html = await readText(resp);
    if (!html || !html.length) throw new Error('EMPTY_HTML: ' + current);
    return html;
  }
  throw new Error('HTTP_REDIRECT_LOOP: ' + url);
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

function detectLang(text) {
  var t = String(text || '');
  if (/(^|[\s(\-])VF(\)|$|[\s\-])/i.test(t) || /-vf([\-\/]|$)/i.test(t)) return 'VF';
  if (/VOSTFR/i.test(t)) return 'VOSTFR';
  return null;
}

function pickImage(fragment) {
  var m = fragment.match(/<img[^>]*src="([^"]+)"/);
  if (m && m[1] && m[1].indexOf('data:image') !== 0) return m[1].split('?')[0].trim();
  var dm = fragment.match(/data-src="([^"]+)"/);
  if (dm && dm[1] && dm[1].indexOf('data:image') !== 0) return dm[1].split('?')[0].trim();
  return null;
}

function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/* Bulletproof anime-card parser. Matches absolute /anime/{slug}/ detail
 * anchors (episode URLs /anime/{slug}/{ep}/ are excluded by the slug-only
 * pattern). Forward-only context window captures title/img/rating/latest. */
function parseAnimeCards(html) {
  if (!html || typeof html !== 'string') return [];
  var out = [];
  var seen = {};
  var base = escRe(BASE_URL);
  var re = new RegExp('<a[^>]*href="(' + base + '\\/anime\\/([a-z0-9\\-]+)\\/)"[^>]*>', 'g');
  var m;
  while ((m = re.exec(html))) {
    var url = m[1];
    if (seen[url]) continue;
    seen[url] = true;
    var ctx = html.slice(m.index, Math.min(html.length, m.index + 4500));
    var title = null;
    var tm = m[0].match(/title="([^"]{1,220})"/);
    if (tm) title = decodeEntities(tm[1]).trim();
    if (!title) {
      var h = ctx.match(/<h3[^>]*>\s*<a[^>]*>([\s\S]{0,220}?)<\/a>\s*<\/h3>/);
      if (h) title = stripTags(h[1]);
    }
    if (!title) {
      var slug = String(url).split('/').filter(Boolean).pop() || '';
      title = decodeEntities(slug.replace(/-/g, ' ')).replace(/\b\w/g, function (c) { return c.toUpperCase(); });
    }
    if (!title || /^(EN COURS|Anime|Voiranime)$/i.test(title)) continue;
    var img = pickImage(ctx);
    var extra = {};
    var rm = ctx.match(/post-total-rating[\s\S]{0,400}?<span class="score"[^>]*>([^<]{1,10})</);
    if (rm) extra.rating = stripTags(rm[1]);
    var cm = ctx.match(/latest-chap[\s\S]{0,600}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,160}?)<\/a>/);
    if (cm) extra.latest = stripTags(cm[2]);
    var item = {
      id: url, url: url, href: url,
      title: title, name: title,
      image: img, poster: img, thumbnail: img,
      type: 'anime', kind: 'anime'
    };
    if (extra.rating) item.rating = extra.rating;
    if (extra.latest) item.latest = extra.latest;
    var lang = detectLang(title + ' ' + url + ' ' + (extra.latest || ''));
    if (lang) { item.lang = lang; item.audio = lang; }
    out.push(item);
  }
  return out;
}

function parseDetails(html, url) {
  var title = null;
  var h1 = html.match(/<h1[^>]*>([\s\S]{0,500}?)<\/h1>/);
  if (h1) title = stripTags(h1[1]);
  if (!title) {
    var og = html.match(/<meta property="og:title" content="([^"]{1,300})"/);
    if (og) title = decodeEntities(og[1]).replace(/\s*-\s*Voiranime\s*$/i, '').replace(/^Regarder gratuitement\s+/i, '').replace(/\s+en HD\s*$/i, '').trim();
  }
  if (!title) {
    var t = html.match(/<title[^>]*>([\s\S]{0,200})<\/title>/);
    if (t) title = stripTags(t[1]).split('- Voiranime')[0].trim();
  }
  if (!title) title = url;
  var desc = null;
  var md = html.match(/<meta name="description" content="([^"]{0,2000})"/);
  if (md) desc = decodeEntities(md[1]).trim();
  var sm = html.match(/description-summary[\s\S]{0,300}?summary__content[^>]*>([\s\S]{0,4000}?)<\/div>/);
  if (sm) {
    var st = stripTags(sm[1]);
    if (st && st.length > 20) desc = st;
  }
  var image = null;
  var ogi = html.match(/<meta property="og:image" content="([^"]+)"/);
  if (ogi) image = ogi[1].split('?')[0];
  if (!image) {
    var si = html.match(/summary_image[\s\S]{0,800}?<img[^>]*src="([^"]+)"/);
    if (si) image = si[1].split('?')[0];
  }
  var genres = [];
  var gsec = html.match(/genres-content[^>]*>([\s\S]{0,2000}?)<\/div>/);
  if (gsec) {
    var gr = /<a[^>]*>([^<]{1,60})<\/a>/g;
    var gm;
    while ((gm = gr.exec(gsec[1]))) {
      var g = decodeEntities(gm[1]).trim();
      if (g && genres.indexOf(g) < 0) genres.push(g);
    }
  }
  var year = null;
  var ym = html.match(/\b((?:19|20)\d{2})\b/);
  if (ym) year = ym[1];
  var type = null;
  var tm = html.match(/post-content_item[\s\S]{0,300}?>[\s\r\n]*Type[\s\r\n]*<[\s\S]{0,400}?summary-content[^>]*>([\s\S]{0,120}?)<\/div>/);
  if (tm) type = stripTags(tm[1]);
  var status = null;
  var sm2 = html.match(/post-content_item[\s\S]{0,300}?>[\s\r\n]*(?:Statut|Status)[\s\r\n]*<[\s\S]{0,400}?summary-content[^>]*>([\s\S]{0,120}?)<\/div>/);
  if (sm2) status = stripTags(sm2[1]);
  var rating = null;
  var rtm = html.match(/post-total-rating[\s\S]{0,400}?<span class="score"[^>]*>([^<]{1,10})</);
  if (rtm) rating = stripTags(rtm[1]);
  var langs = [];
  function addLang(l) { if (l && langs.indexOf(l) < 0) langs.push(l); }
  addLang(detectLang(title));
  var epLangRe = /\/(anime)\/[a-z0-9\-]+\/[a-z0-9\-]+-(vostfr|vf)\//g;
  var em;
  while ((em = epLangRe.exec(html))) addLang(em[2].toUpperCase() === 'VF' ? 'VF' : 'VOSTFR');
  if (!langs.length) {
    var allVF = /\(VF\)/i.test(html.slice(0, 20000));
    langs.push(allVF ? 'VF' : 'VOSTFR');
  }
  return {
    id: url, url: url, href: url,
    title: title, name: title,
    description: desc || '', synopsis: desc || '',
    image: image, poster: image, thumbnail: image,
    genres: genres, genre: genres.join(', '),
    year: year, type: type || 'anime', kind: 'anime',
    status: status, rating: rating,
    languages: langs, audio: langs.join(' / '), lang: langs[0] || null
  };
}

function parseEpisodesFromDetail(html, showUrl) {
  var out = [];
  var seen = {};
  var re = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]{0,400}?<a[^>]*href="([^"]+)"[^>]*>([\s\S]{0,600}?)<\/a>/g;
  var m;
  while ((m = re.exec(html))) {
    var url = toAbsolute(decodeEntities(m[1]));
    if (!url || seen[url]) continue;
    seen[url] = true;
    var inner = stripTags(m[2]);
    var dm = html.slice(m.index, m.index + 1200).match(/chapter-release-date[^>]*>([\s\S]{0,200}?)<\/(?:span|div)>/);
    var date = dm ? stripTags(dm[1]) : null;
    var num = null;
    var nm = url.match(/-(\d{1,4})-(?:vostfr|vf)\/?$/i) || inner.match(/(?:^|\D)(\d{1,4})(?:\D|$)/);
    if (nm) num = parseInt(nm[1], 10);
    var lang = detectLang(url + ' ' + inner);
    var title = inner ? inner.replace(/\s+/g, ' ').trim().slice(0, 220) : ('Episode ' + (num != null ? num : url));
    out.push({
      id: url, url: url, href: url,
      title: title, name: title,
      number: num, episode: num, season: 1,
      lang: lang, audio: lang, date: date, show: showUrl || null
    });
  }
  out.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
  return out;
}

function parseEpisodesFromWatch(html, showUrl) {
  var out = [];
  var seen = {};
  var re = /<option[^>]*data-redirect="([^"]+)"[^>]*>([^<]{0,120})<\/option>/g;
  var m;
  while ((m = re.exec(html))) {
    var url = toAbsolute(decodeEntities(m[1]));
    if (!url || seen[url]) continue;
    if (url.indexOf('/anime/') < 0) continue;
    if (url.indexOf('?') >= 0 || /[?&]host=/i.test(url)) continue;
    seen[url] = true;
    var label = stripTags(m[2]);
    if (/^LECTEUR/i.test(label)) continue;
    var num = null;
    var nm = label.match(/(\d{1,4})/) || url.match(/-(\d{1,4})-(?:vostfr|vf)\/?$/i);
    if (nm) num = parseInt(nm[1], 10);
    var lang = detectLang(url + ' ' + label);
    var title = label ? ('Episode ' + label) : ('Episode ' + (num != null ? num : url));
    out.push({
      id: url, url: url, href: url,
      title: title.slice(0, 220), name: title.slice(0, 220),
      number: num, episode: num, season: 1,
      lang: lang, audio: lang, show: showUrl || null
    });
  }
  out.sort(function (a, b) { return (a.number || 0) - (b.number || 0); });
  return out;
}

function providerOf(embedUrl) {
  var u = String(embedUrl || '').toLowerCase();
  if (u.indexOf('voe.sx') >= 0 || u.indexOf('voe.') >= 0) return 'voe';
  if (u.indexOf('voembed') >= 0) return 'voembed';
  if (u.indexOf('mfw09') >= 0 || u.indexOf('filemoon') >= 0) return 'moon';
  if (u.indexOf('streamtape') >= 0 || u.indexOf('stape') >= 0) return 'streamtape';
  if (u.indexOf('sibnet') >= 0) return 'sibnet';
  if (u.indexOf('sendvid') >= 0) return 'sendvid';
  if (u.indexOf('dood') >= 0) return 'dood';
  if (u.indexOf('mixdrop') >= 0) return 'mixdrop';
  if (u.indexOf('uqload') >= 0) return 'uqload';
  return 'embed';
}

function parsePlayers(html) {
  var players = [];
  var seen = {};
  function push(label, embed) {
    if (!embed) return;
    var url = String(embed).replace(/\\\//g, '/').trim();
    if (!/^https?:\/\//i.test(url)) return;
    if (url.indexOf('youtube.com') >= 0 || url.indexOf('youtube-nocookie') >= 0) return;
    if (seen[url]) return;
    seen[url] = true;
    players.push({ label: label || providerOf(url), embed: url, provider: providerOf(url) });
  }
  var srcMap = html.match(/var\s+thisChapterSources\s*=\s*(\{[\s\S]{0,8000}?\});/);
  if (srcMap) {
    var raw = srcMap[1];
    var re = /"([^"]+)"\s*:\s*"<iframe[^>]*src=\\"((?:[^\\]|\\\/)+)\\"/g;
    var m;
    while ((m = re.exec(raw))) {
      push(decodeEntities(m[1]).trim(), decodeEntities(m[2]).replace(/\\\//g, '/'));
    }
  }
  var fre = /<div[^>]*class="[^"]*chapter-video-frame[^"]*"[^>]*>([\s\S]{0,2000}?)<\/div>/;
  var fm = html.match(fre);
  if (fm) {
    var fim = fm[1].match(/<iframe[^>]*src="([^"]+)"/);
    if (fim) push('Lecteur', decodeEntities(fim[1]));
  }
  var allIframes = html.match(/<iframe[^>]*src="([^"]+)"/g) || [];
  for (var i = 0; i < allIframes.length; i++) {
    var sm = allIframes[i].match(/src="([^"]+)"/);
    if (sm && sm[1].indexOf('youtube') < 0) push(null, decodeEntities(sm[1]));
  }
  return players;
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
  return found;
}

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
  if (/^anime\//.test(s)) return toAbsolute('/' + s);
  return toAbsolute('/anime/' + s.replace(/^\/+/, ''));
}

function showUrlOf(episodeUrl) {
  var m = String(episodeUrl).match(/^(https?:\/\/[^/]+\/anime\/[a-z0-9\-]+\/)/);
  return m ? m[1] : null;
}

/* Search: GET /?s={encoded query}. Site 302-redirects to
 * /?post_type=wp-manga&s={query}; fetchHtml follows that manually.
 * Empty query or any error returns [] — never throws. */
globalThis.searchResults = async function (query) {
  try {
    var q = String(query == null ? '' : query).trim().replace(/\s+/g, ' ');
    if (!q) return [];
    var url = BASE_URL + '/?s=' + encodeURIComponent(q);
    var html = null;
    for (var attempt = 0; attempt < 2; attempt++) {
      try { html = await fetchHtml(url); break; }
      catch (e) { if (attempt === 1) return []; }
    }
    if (html == null || html === '') return [];
    var cards = parseAnimeCards(html);
    return cards || [];
  } catch (e) {
    return [];
  }
};

globalThis.extractDetails = async function (id) {
  try {
    var url = normalizeId(id);
    var show = showUrlOf(url) || url;
    var html = await fetchHtml(show);
    return parseDetails(html, show);
  } catch (e) {
    return [];
  }
};

globalThis.extractEpisodes = async function (id) {
  try {
    var url = normalizeId(id);
    var show = showUrlOf(url);
    if (show && url.replace(/\/$/, '') !== show.replace(/\/$/, '')) {
      try {
        var wh = await fetchHtml(url);
        var fromSelect = parseEpisodesFromWatch(wh, show);
        if (fromSelect.length) return fromSelect;
      } catch (e) { /* fall through */ }
      try {
        var dh = await fetchHtml(show);
        var fromDetail = parseEpisodesFromDetail(dh, show);
        if (fromDetail.length) return fromDetail;
      } catch (e2) { /* fall through */ }
      return [{ id: url, url: url, href: url, title: 'Episode', name: 'Episode', season: 1, episode: 1, number: 1, show: show }];
    }
    var html = await fetchHtml(show || url);
    var episodes = parseEpisodesFromDetail(html, show || url);
    if (episodes.length) return episodes;
    return parseEpisodesFromWatch(html, show || url);
  } catch (e) {
    return [];
  }
};

globalThis.extractStreamUrl = async function (episodeHref, lang) {
  var url = normalizeId(episodeHref);
  var html = await fetchHtml(url);
  var players = parsePlayers(html);
  var wanted = players;
  if (lang) {
    var l = String(lang).toLowerCase();
    var isVf = l.indexOf('vf') >= 0;
    var isVostfr = l.indexOf('vostr') >= 0 || l.indexOf('vost') >= 0;
    var epLang = detectLang(url);
    if ((isVf && epLang === 'VOSTFR') || (isVostfr && epLang === 'VF')) {
      var show = showUrlOf(url);
      if (show) {
        try {
          var dh = await fetchHtml(show);
          var alt = parseEpisodesFromDetail(dh, show).filter(function (e) {
            return detectLang(e.url + ' ' + e.title) === (isVf ? 'VF' : 'VOSTFR');
          });
          if (alt.length) {
            html = await fetchHtml(alt[0].url);
            url = alt[0].url;
            players = parsePlayers(html);
            wanted = players;
          }
        } catch (e) { /* keep original */ }
      }
    }
    var matched = players.filter(function (p) { return p.label && p.label.toLowerCase().indexOf(l) >= 0; });
    if (matched.length) wanted = matched;
  }
  var candidates = findMediaUrls(html);
  var declared = [];
  for (var d = 0; d < wanted.length; d++) {
    if (wanted[d].embed && /^https?:\/\//i.test(wanted[d].embed)) {
      declared.push({ url: wanted[d].embed, via: 'host:' + wanted[d].provider, label: wanted[d].label });
    }
  }
  candidates = declared.concat(candidates);
  var embeds = candidates.filter(function (c) { return c.via === 'iframe' || (c.via && c.via.indexOf('host:') === 0); }).slice(0, 5);
  for (var i = 0; i < embeds.length; i++) {
    try {
      var eh = await fetchHtml(embeds[i].url);
      var inner = findMediaUrls(eh);
      for (var j = 0; j < inner.length; j++) {
        if (inner[j].via !== 'iframe') candidates.push(inner[j]);
      }
    } catch (e) { /* keep evidence */ }
  }
  var direct = candidates.filter(function (c) { return c.via !== 'iframe'; });
  var errors = [];
  for (var k = 0; k < direct.length; k++) {
    var c = direct[k];
    if (c.via && c.via.indexOf('host:') === 0) continue;
    var headers = Object.assign({}, MEDIA_HEADERS, { Referer: url });
    try {
      var info = await verifyMedia(c.url, headers);
      return {
        streams: [{
          label: (c.label || 'Direct') + (info.isHls ? ' (HLS)' : ''),
          url: c.url, headers: headers,
          type: info.isHls ? 'm3u8' : 'mp4',
          source: providerOf(c.url), via: c.via
        }],
        subtitles: []
      };
    } catch (e) { errors.push(e && e.message ? e.message : String(e)); }
  }
  var embedStreams = declared.map(function (c) {
    return {
      label: c.label || providerOf(c.url),
      url: c.url,
      headers: Object.assign({}, MEDIA_HEADERS, { Referer: url }),
      type: 'embed', source: providerOf(c.url), via: c.via
    };
  });
  if (embedStreams.length) return { streams: embedStreams, subtitles: [] };
  if (!direct.length) {
    throw new Error('STREAM_GATED: no playable media on ' + url);
  }
  throw new Error('STREAM_GATED: all candidates failed on ' + url);
};

var DISCOVERY_SECTIONS = [
  { id: 'en-cours', title: 'En cours', url: BASE_URL + '/' },
  { id: 'catalogue', title: 'Catalogue', url: BASE_URL + '/anime/' }
];

globalThis.discoveryHome = async function () {
  try {
    var sections = [];
    for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
      var s = DISCOVERY_SECTIONS[i];
      try {
        var html = await fetchHtml(s.url);
        sections.push({ id: s.id, title: s.title, items: parseAnimeCards(html).slice(0, 30) });
      } catch (e) {
        sections.push({ id: s.id, title: s.title, items: [] });
      }
    }
    var anyItems = false;
    for (var k = 0; k < sections.length; k++) {
      if (sections[k].items && sections[k].items.length) { anyItems = true; break; }
    }
    return anyItems ? sections : [];
  } catch (e) {
    return [];
  }
};

globalThis.getHome = async function () {
  try {
    var sections = await globalThis.discoveryHome();
    if (!Array.isArray(sections)) return [];
    var flat = [];
    var seen = {};
    for (var i = 0; i < sections.length; i++) {
      var items = sections[i] && sections[i].items;
      if (!Array.isArray(items)) continue;
      for (var j = 0; j < items.length; j++) {
        var it = items[j];
        var key = (it && (it.id || it.url)) || null;
        if (!key || seen[key]) continue;
        seen[key] = true;
        flat.push(it);
        if (flat.length >= 30) return flat;
      }
    }
    return flat;
  } catch (e) {
    return [];
  }
};

globalThis.discoveryFeed = async function (sectionId, page) {
  var id = String(sectionId || 'en-cours').trim();
  var target = null;
  for (var i = 0; i < DISCOVERY_SECTIONS.length; i++) {
    if (DISCOVERY_SECTIONS[i].id === id) { target = DISCOVERY_SECTIONS[i]; break; }
  }
  if (!target) target = DISCOVERY_SECTIONS[0];
  try {
    var url = target.url;
    if (page && Number(page) > 1) {
      url += (url.charAt(url.length - 1) === '/' ? '' : '/') + 'page/' + Number(page) + '/';
    }
    var html = await fetchHtml(url);
    return { id: target.id, title: target.title, items: parseAnimeCards(html).slice(0, 30) };
  } catch (e) {
    return { id: target.id, title: target.title, items: [] };
  }
};

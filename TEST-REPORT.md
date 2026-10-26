# Nova Streaming — Test Report

- Module: `nova-streaming` 1.0.0 (contract v3, `minAppVersion` 1)
- Source site: https://watchnova.win
- Package: `nova-streaming.zip` (9,862 bytes)
- ZIP SHA-256: `3F3E2AD53591CC9FE45F24A0A282E34A20140003FC71F8BD3355282C7BAAF803`
- `nova-streaming/index.js` SHA-256: `DC7C350F5743F3421471344D8630F0D586C561290B47A19D7652C6F6EEE6B954`
- `nova-streaming/module.json` SHA-256: `A6DDC95AAFD7BA118B86247F2613890F58ECADDAB5007AAE4D65B83C4DCF3F3D`
- Tested: 2026-10-26 on Windows, Node.js v24.21.0 with native `fetch`.
- Scope: Node harness against the ZIP contents. Not tested inside the Flutter app or on a device.
- Method: ZIP extracted to a temp directory, `node --check` run, module loaded, globals invoked. Returned HLS URLs were fetched and checked for `#EXTM3U`, `#EXT-X-STREAM-INF`, `#EXTINF`/`#EXT-X-TARGETDURATION`; uqload masters were probed through their first variant.

## Results: 18/18 checks passed

| # | Check | Result | Detail |
|---|-------|--------|--------|
| 1 | `searchResults("Uncharted")` | PASS | 1 result, `movie-335787` |
| 2 | `searchResults("sterling point")` | PASS | `tv-283297` first; 2 results (second is an unrelated token match) |
| 3 | `extractDetails("movie-335787")` | PASS | Uncharted, 2022, Action |
| 4 | `extractDetails("tv-283297")` | PASS | Sterling Point, 2 seasons |
| 5 | `extractEpisodes("tv-283297")` | PASS | 8 episodes, first `tv-283297-s1e1` |
| 6 | `extractEpisodes("movie-335787")` | PASS | 1 film item fallback |
| 7 | `discoveryHome()` | PASS | 10 sections, 30 items each |
| 8 | `getHome()` | PASS | 30 unique cards |
| 9 | `discoveryFeed("films", 1/2)` | PASS | 30/30 items, 0 duplicates, `totalPages` 10 |
| 10 | uqload episode stream | PASS | 4 streams: Auto + 1080p/720p/360p; all HTTP 200 and valid media playlists |
| 11 | uqload film stream | PASS | 2 streams: Auto + 360p; all HTTP 200 and valid media playlists |
| 12 | stale `strm*.uqload.vc` URL | PASS | ID extracted, embed re-resolution returned 4 valid streams |
| 13 | heiwastream | PASS | embed fallback (PoW not implemented by design) |
| 14 | vidzy direct HLS | PASS | embed fallback; self-referencing master detected |
| 15 | vidzy embed page | PASS | embed fallback; fake `fsvid.lol/troll` URL is filtered out |
| 16 | vidmoly direct HLS | PASS | 2 streams: Auto + 816p, both valid |
| 17 | cloudwindow direct HLS | PASS (fallback) | direct HLS returned; playback not verified (HTTP 403 from test IP) |
| 18 | movix embed page | PASS | embed fallback |

## Provider matrix

- `uqload.vc`: direct HLS verified (master + quality variants with `#EXTINF`).
- `strm*.uqload.vc`: stale catalog token detected; uqload ID derived and fresh embed URL resolved.
- `vidmoly.org`: direct HLS verified.
- `heiwastream.fr`: embed only; its proof-of-work gate was not implemented.
- `vidzy.cc` / `vidzy.org` / `vidzy.live`: embed fallback. The direct HLS masters self-reference `index.m3u8` and yield no media.
- `movix.bet` / `movix.fun`: embed fallback.
- `playmogo.com`: embed fallback; no usable public m3u8 found in the embed page.
- `bll.embedseek.com`: embed fallback.
- `cloudwindow-route.com`: direct HLS returned unverified; the test IP received HTTP 403.
- `tnmr.org`: direct HLS returned unverified; token may be stale.
- Other/unrecognized hosts: embed fallback, no crash.

## Limitations

- No login bypass: `/api/player/direct-link` returns `401 CONNEXION_REQUISE`. The module uses only public catalog, episode and embed data.
- No CAPTCHA, DRM or proof-of-work bypass. heiwastream stays in embed mode.
- Search is client-side over the public catalog; the site has no server-side search route.
- The catalog is about 1.06 MB. The manifest allows 4 MB (`maxResponseBytes`).
- No subtitle tracks were exposed by the tested endpoints; the module returns `subtitles: []`.
- Stream tokens expire. uqload is re-resolved on every call; other direct HLS providers may require a fresh URL.
- `moduleIdentityNumber` is intentionally not set. The maintainer must allocate it before public release.
- `repository.json` was not modified or published.

## Reproduction

```powershell
node --check nova-streaming/index.js
Expand-Archive -LiteralPath nova-streaming.zip -DestinationPath .\tmp
# Load .\tmp\nova-streaming\index.js in a Node harness and call the global exports.
Get-FileHash -LiteralPath nova-streaming.zip -Algorithm SHA256
```

The ZIP contains only `nova-streaming/module.json` and `nova-streaming/index.js`.

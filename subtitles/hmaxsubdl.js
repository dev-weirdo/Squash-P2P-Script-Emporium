// ==UserScript==
// @name         HBOMax Subtitle Downloader
// @namespace    squasher
// @version      1.3
// @description  Download subtitles from HBO Max titles.
// @author       squash
// @include      *://play.hbomax.com/*
// @grant        GM_xmlhttpRequest
// @connect      default.any-any.prd.api.hbomax.com
// @connect      *
// @require      https://cdn.jsdelivr.net/npm/jszip@3.7.1/dist/jszip.min.js
// @require      https://cdn.jsdelivr.net/npm/file-saver-es@2.0.5/dist/FileSaver.min.js
// ==/UserScript==

(function() {
    'use strict';

    // playback endpoint
    const PLAYBACK_INFO_URL = 'https://default.any-any.prd.api.hbomax.com/any/playback/v1/playbackInfo';

    // log wrappers
    function log(...args){ console.log('[HBOMax Subtitle Downloader]', ...args); }
    function err(...args){ console.error('[HBOMax Subtitle Downloader]', ...args); }

    // grease monkey synchronous fetch
    function gmFetch(opts){
        return new Promise((resolve, reject) => {
            opts.onload = r => resolve(r);
            opts.onerror = e => reject(e);
            opts.ontimeout = e => reject(e);
            opts.withCredentials = true;
            GM_xmlhttpRequest(opts);
        });
    }

    // asynchrounous fast fetch
    async function fastFetch(url) {
        try {
            const r = await fetch(url, {
                mode: 'cors',
                credentials: 'omit'
            });
            if (!r.ok) throw new Error('fetch failed: ' + r.status);
            return { ok: true, text: await r.text() };
        } catch (e) {
            // fallback to GM
            const r = await gmFetch({ method: 'GET', url });
            if (!(r.status >= 200 && r.status < 300)) {
                throw new Error('gmFetch failed: ' + r.status);
            }
            return { ok: true, text: r.responseText || '' };
        }
    }

    // ensure FileSaver (saveAs) is available. if not, inject it and wait
    async function ensureFileSaver() {
        if (typeof saveAs === 'function') return;
        if (window.FileSaver && typeof window.FileSaver.saveAs === 'function') {
            window.saveAs = window.FileSaver.saveAs;
            return;
        }
        // try to dynamically load FileSaver.js into page context
        const src = 'https://cdn.jsdelivr.net/npm/file-saver@2.0.5/dist/FileSaver.min.js';
        await new Promise((resolve, reject) => {
            // check again in case another injection loaded it meanwhile
            if (typeof saveAs === 'function') return resolve();
            const s = document.createElement('script');
            s.src = src;
            s.async = true;
            s.onload = () => {
                // sometimes the library attaches to window.saveAs or window.FileSaver
                if (typeof saveAs !== 'function' && window.FileSaver && typeof window.FileSaver.saveAs === 'function') {
                    window.saveAs = window.FileSaver.saveAs;
                }
                resolve();
            };
            s.onerror = () => {
                reject(new Error('Failed to load FileSaver.js'));
            };
            document.head.appendChild(s);
        }).catch(e => {
            log('FileSaver injection failed:', e);
        });
    }

    // --- parsing functions ---

    // get show and edit IDs
    function parseIdsFromPageUrl(){
        const m = location.pathname.match(/video\/watch\/([0-9a-fA-F-]{36})\/([0-9a-fA-F-]{36})/);
        if(!m) return null;
        return { pageShowId: m[1], pageEditId: m[2] };
    }

    // fetch cms routs from hbo api
    async function getCmsRoutes(showId, editId) {
        const url = `https://default.any-any.prd.api.hbomax.com/cms/routes/video/watch/${showId}/${editId}?include=default`;
        log('GET', url);
        const r = await gmFetch({ method: 'GET', url });
        if(!(r.status >= 200 && r.status < 300)) throw new Error('cms/routes GET failed: ' + r.status);
        return JSON.parse(r.responseText);
    }

    // parse cms object from hbo api
    function findCmsObjectForShow(cmsJson, pageShowId) {
        const candidates = [];
        if(cmsJson.data) candidates.push(cmsJson.data);
        if(Array.isArray(cmsJson.included)) candidates.push(...cmsJson.included);
        for(const c of candidates) {
            if(c && c.attributes && c.attributes.alternateId === pageShowId) return c;
        }
        return null;
    }

    // get active video from the cms resource ID
    async function getActiveVideoForShow(showResourceId) {
        const url = `https://default.any-any.prd.api.hbomax.com/content/videos/${showResourceId}/activeVideoForShow?include=edit`;
        log('GET', url);
        const r = await gmFetch({ method: 'GET', url });
        if(!(r.status >= 200 && r.status < 300)) throw new Error('activeVideoForShow GET failed: ' + r.status);
        return JSON.parse(r.responseText);
    }

    async function bootstrap() {
        const url = 'https://default.any-any.prd.api.hbomax.com/session-context/headwaiter/v1/bootstrap';
        log('POST bootstrap ->', url);
        const r = await gmFetch({ method: 'POST', url });
        if(r.status >= 200 && r.status < 300){
            const headers = r.responseHeaders || '';
            const m = headers.match(/x-wbd-session-state:\s*([^\r\n]+)/i);
            if(m) return m[1].trim();
        }
        return null;
    }

    function buildTraceState() {
        try {
            const cookie = document.cookie.split(';').map(x=>x.trim()).find(x=>x.startsWith('session='));
            if(!cookie) return null;
            let val = decodeURIComponent(cookie.split('=').slice(1).join('='));
            return `wbd=session:${val}`;
        } catch(e){ return null; }
    }

    async function postPlayback(editId, xWbd) {
        log('POST playbackInfo ->', PLAYBACK_INFO_URL, 'editId=', editId);
        const body = {
            "appBundle":"com.wbd.stream",
            "applicationSessionId": (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
            "capabilities": {
                "codecs": {
                    "audio": { "decoders": [ { "codec":"eac3", "profiles":["lc","he","hev2","xhe","atmos"] }, { "codec":"ac3","profiles":[]} ] },
                    "video": { "decoders": [ { "codec":"h264", "levelConstraints":{"framerate":{"max":960,"min":0},"height":{"max":2200,"min":64},"width":{"max":3900,"min":64}},"maxLevel":"6.2","profiles":["baseline","main","high"] }, { "codec":"h265","levelConstraints":{"framerate":{"max":960,"min":0},"height":{"max":2200,"min":144},"width":{"max":3900,"min":144}},"maxLevel":"6.2","profiles":["main","main10"] } ], "hdrFormats":["dolbyvision8","dolbyvision5","dolbyvision","hdr10plus","hdr10","hlg"] }
                },
                "contentProtection": {"contentDecryptionModules":[{ "drmKeySystem":"playready","maxSecurityLevel":"sl3000" }]},
                "devicePlatform": { "network": {"capabilities": {"protocols":{"http":{"byteRangeRequests": true}}}, "lastKnownStatus":{"networkTransportType":"wifi"} }, "videoSink": {"capabilities":{"colorGamuts":["standard"],"hdrFormats":[]},"lastKnownStatus":{"height":2200,"width":3900}} },
                "manifests": {"formats": {"dash": {}}}
            },
            "consumptionType":"streaming",
            "deviceInfo": {
                "browser":{"name":"Discovery Player Android androidTV","version":"1.8.1-canary.102"},
                "deviceId":"",
                "deviceType":"androidtv",
                "make":"NVIDIA",
                "model":"SHIELD Android TV",
                "os":{"name":"ANDROID","version":"10"},
                "platform":"android",
                "player": {"mediaEngine":{"name":"exoPlayer","version":"1.2.1"},"playerView":{"height":2160,"width":3840},"sdk":{"name":"Discovery Player Android androidTV","version":"1.8.1-canary.102"}}
            },
            "editId": editId,
            "firstPlay": true,
            "gdpr": false,
            "playbackSessionId": (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)),
            "userPreferences": {"uiLanguage":"en"}
        };

        const headers = {
            'User-Agent': navigator.userAgent,
            'Accept': 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'x-disco-client': 'WEB:NT 10.0:beam:0.0.0',
            'x-disco-params': 'realm=bolt,bid=beam,features=ar',
            'x-device-info': 'beam/0.0.0 (desktop/desktop; Windows/NT 10.0; device)',
            'Origin': 'https://play.hbomax.com',
            'Referer': 'https://play.hbomax.com/'
        };

        if(xWbd) headers['x-wbd-session-state'] = xWbd;
        headers['traceparent'] = '00-053c91686df1e7ee0b0b0f7fda45ee6a-f5a98d6877ba2515-01';
        const ts = buildTraceState();
        if(ts) headers['tracestate'] = ts;

        const r = await gmFetch({ method: 'POST', url: PLAYBACK_INFO_URL, data: JSON.stringify(body), headers });
        if(!(r.status >= 200 && r.status < 300)) throw new Error('playback POST failed: ' + r.status + ' ' + (r.responseText || '').slice(0,200));
        return JSON.parse(r.responseText);
    }

    function manifestUrlFromPlayback(playbackJson) {
        const fallback = playbackJson?.fallback?.manifest?.url;
        if(!fallback) throw new Error('fallback.manifest.url missing in playback response');
        return fallback.replace('_fallback','');
    }

    async function fetchMpdAndExtractSubs(manifestUrl) {
        log('GET MPD ->', manifestUrl);
        const r = await gmFetch({ method:'GET', url: manifestUrl });
        if(!(r.status >= 200 && r.status < 300)) throw new Error('MPD fetch failed: ' + r.status);
        const mpdText = r.responseText;
        const parser = new DOMParser();
        const xml = parser.parseFromString(mpdText, 'application/xml');

        let periods = Array.from(xml.getElementsByTagName('Period'));
        if(periods.length === 0) periods = Array.from(xml.getElementsByTagNameNS('*','Period'));
        if(periods.length === 0) throw new Error('No Period in MPD');
        const period = periods[periods.length - 1];

        let adaptationSets = Array.from(period.getElementsByTagName('AdaptationSet'));
        if(adaptationSets.length === 0) adaptationSets = Array.from(period.getElementsByTagNameNS('*','AdaptationSet'));

        const base = manifestUrl.substring(0, manifestUrl.lastIndexOf('/'));
        const results = [];

        for(const as of adaptationSets) {
            const ct = (as.getAttribute('contentType') || '').toLowerCase();
            if(!ct.includes('text')) continue;
            const rep = as.getElementsByTagName('Representation')[0] || as.getElementsByTagNameNS('*','Representation')[0];
            if(!rep) continue;
            const seg = rep.getElementsByTagName('SegmentTemplate')[0] || rep.getElementsByTagNameNS('*','SegmentTemplate')[0];
            if(!seg) continue;
            const media = seg.getAttribute('media') || '';
            const startNumber = parseInt(seg.getAttribute('startNumber') || seg.getAttribute('start') || '1', 10) || 1;
            const language = as.getAttribute('lang') || as.getAttribute('xml:lang') || 'und';
            const label = (as.getElementsByTagName('Label')[0] && as.getElementsByTagName('Label')[0].textContent) || '';
            const roleNode = as.getElementsByTagName('Role')[0];
            const role = roleNode && roleNode.getAttribute && roleNode.getAttribute('value') ? roleNode.getAttribute('value') : null;

            const sub_types = {
                "sdh": ["_sdh.vtt", "[sdh]"],
                "caption": ["_cc.vtt", "[sdh]"],
                "subtitle": ["_sub.vtt", ""],
                "forced-subtitle": ["_forced.vtt", "[forced]"]
            };

            let sub_type = "";
            switch (role) {
                case 'caption':
                    sub_type = 'sdh';
                    break;
                case 'subtitle':
                    sub_type = 'subtitle';
                    break;
                case 'forced-subtitle':
                    sub_type = 'forced-subtitle';
                    break;
            }
            if(!sub_types[sub_type]) sub_type = 'subtitle';
            const suffix = sub_types[sub_type][0];
            const subtitle_role = sub_types[sub_type][1];

            const parts = media.split('/');
            const path = parts.slice(0,2).join('/');
            const flatUrl = `${base}/${path}/${language}${suffix}`;

            if(media.includes('$Number$')) {
                const arr = [];
                for(let i=1;i<=startNumber;i++){
                    arr.push(`${base}/${media.replace('$Number$', i)}`);
                }
                results.push({ url: arr, format:'vtt', language, subtitle_role, type:'segmented' });
            } else {
                results.push({ url: flatUrl, format:'vtt', language, subtitle_role, type:'flat' });
            }
        }

        return results;
    }

    // --- subtitle parsing functions ---

    function normalizeSegmentText(text, isFirstSegment) {
        if(!text) return '';
        text = text.replace(/^\uFEFF/, '');
        text = text.replace(/^\s*WEBVTT[^\n]*\n?/i, '');
        if(!isFirstSegment) text = text.replace(/^\s+/, '');
        return text;
    }

    function sanitizeFilename(name) {
        if(!name) return 'title';
        let s = name.replace(/[\u0000-\u001f<>:"\/\\|?*\u007f]+/g,' ').trim();
        s = s.replace('-', '');
        s = s.replace(/\s+/g, '.');
        s = s.replace(/\.+/g, '.');
        s = s.replace(/^\.+|\.+$/g,'');
        return s || 'title';
    }

    // merge webvtt segments
    async function buildVttForEntry(entry, progressCb) {
        const timerId = `segments-${entry.language}-${Math.random()}`;
        console.time(timerId);
        if (entry.type === 'flat') {
            const url = entry.url;
            log('Fetching flat VTT', url);
            let text = await fastFetch(url) || '';
            if (!/^\s*WEBVTT/i.test(text)) {
                text = 'WEBVTT\n\n' + text;
            }
            return text;
        }

        if (entry.type === 'segmented') {
            const segUrls = entry.url;
            const total = segUrls.length;

            let completed = 0;

            const promises = segUrls.map((u, i) => fastFetch(u).then(({ text }) => {
                completed++;
                progressCb && progressCb(completed, total, u);

                return normalizeSegmentText(text, i === 0);
            }).catch(e => {
                completed++;
                progressCb && progressCb(completed, total, u);

                log('Segment fetch error', e, u);
                return `\n\nNOTE: segment ${i + 1} fetch error: ${String(e)} - ${u}\n`;
            }));

            const segments = await Promise.all(promises);
            const joined = segments.join('\n');
            return 'WEBVTT\n\n' + joined.replace(/^\s+/, '');
        }
        throw new Error('Unknown subtitle entry type: ' + entry.type);
    }

    // save zip file
    const _save = async (_zip, title) => {
        // ensure FileSaver is available, otherwise try to inject it
        await ensureFileSaver();
        const content = await _zip.generateAsync({type:'blob'});
        if (typeof saveAs === 'function') {
            try {
                saveAs(content, title + '.zip');
                return;
            } catch (e) {
                log('saveAs call threw, falling back to anchor:', e);
            }
        }
        // fallback anchor method
        const url = URL.createObjectURL(content);
        const a = document.createElement('a');
        a.href = url;
        a.download = title + '.zip';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    async function buildZipAndDownload(subs, titleName, year) {
        const zip = new JSZip();
        const total = subs.length;

        updateButtonText("Downloading subtitles...");
        showProgressOverlay('Preparing subtitles...', 0, total);

        const results = await Promise.all(
            subs.map(async (s, idx) => {
                updateProgressOverlay(
                    `Processing ${idx + 1}/${total}: ${s.language} (${s.subtitle_role})`,
                    idx,
                    total
                );

                const vtt = await buildVttForEntry(s, (num, max, url) => {
                    updateProgressOverlay(
                        `Downloading segment ${num}/${max} for ${s.language} — ${url}`,
                        idx,
                        total
                    );
                });

                const sanitizedTitle = sanitizeFilename(titleName);
                const yy = year || '';
                let langTag = s.language || 'und';

                switch (langTag) {
                    case 'nb': langTag = 'no'; break;
                    case 'sr-Latn': langTag = 'sr'; break;
                    case 'ms-MY': langTag = 'ms'; break;
                    case 'ca-ES': langTag = 'ca'; break;
                    case 'zh-Hans-CN': langTag = 'zh-Hans'; break;
                    case 'zh-Hant-TW': langTag = 'zh-Hant'; break;
                    case 'khk-Cyrl': langTag = 'khk'; break;
                }

                const filename = `${sanitizedTitle}.${yy}.HMAX.WEB.${langTag}${s.subtitle_role}.vtt`.replace(/\.+/g, '.').replace('.vtt', '') + '.vtt';
                return { filename, vtt };
            })
        );

        // add to zip in original order
        for (const { filename, vtt } of results) {
            zip.file(filename, vtt);
        }

        updateProgressOverlay('Generating ZIP...', total, total);

        const zipName = `${sanitizeFilename(titleName)}.${year || ''}.HMAX.WEB.subs`;
        await _save(zip, zipName);

        removeProgressOverlay();
        updateButtonText("Download Subtitles");
    }


    // --- progress overlay functions ---

    let _overlayElem = null;
    function showProgressOverlay(title, current, total) {
        removeProgressOverlay();
        _overlayElem = document.createElement('div');
        _overlayElem.style = `
        position:fixed;
        left:10px;
        top:10px;
        z-index:2147483647;
        padding:12px;
        background:#0b0b0b;
        color:#fff;
        border:2px solid #666;
        max-width:40%;
        max-height:60%;
        overflow:auto;
        font-family:monospace;`;

        _overlayElem.innerHTML = `
        <div id="hb_title"><b>${title}</b></div>
        <div id="hb_progress" style="margin-top:8px">${current}/${total}</div>`;

        const close = document.createElement('button');
        close.textContent = 'Close';
        close.style = 'display:block;margin-top:8px;padding:6px';
        close.onclick = () => _overlayElem && _overlayElem.remove();
        _overlayElem.appendChild(close);
        document.body.appendChild(_overlayElem);
    }

    function updateProgressOverlay(msg, current, total) {
        if (!_overlayElem) showProgressOverlay(msg, current, total);
        const title = _overlayElem.querySelector('#hb_title');
        const pr = _overlayElem.querySelector('#hb_progress');

        if (title) title.innerHTML = `<b>${msg}</b>`;
        if (pr) {
            if (current < total) {
                pr.textContent = `Downloading subtitle ${current + 1}/${total}`;
            } else {
                pr.textContent = `Downloading subtitle ${current}/${total}`;
            }
        }
    }

    function removeProgressOverlay() {
        if (_overlayElem) {
            _overlayElem.remove();
            _overlayElem = null;
        }
    }

    // main function
    async function doThing() {
        try {
            updateButtonText("Fetching manifest...");
            const ids = parseIdsFromPageUrl();
            if(!ids) throw new Error('Page URL not in expected format: /video/watch/<SHOW_ID>/<EDIT_ID>');
            log('page ids', ids);

            const cmsJson = await getCmsRoutes(ids.pageShowId, ids.pageEditId);
            log('cms/routes fetched');

            const matched = findCmsObjectForShow(cmsJson, ids.pageShowId);
            if(!matched) throw new Error('Could not find cms object with attributes.alternateId === page SHOW_ID');
            log('matched cms object id', matched.id);

            const titleName = matched?.attributes?.originalName || matched?.attributes?.name || document.title || 'title';
            const releaseDate = matched?.attributes?.airDate || null;
            let year = '';
            if(releaseDate) {
                try { year = (new Date(releaseDate)).getFullYear(); } catch(e){ year = ''; }
            }

            const showResourceId = matched?.relationships?.show?.data?.id;
            if(!showResourceId) throw new Error('matching CMS object does not contain relationships.show.data.id');
            log('showResourceId for activeVideoForShow', showResourceId);

            const activeJson = await getActiveVideoForShow(showResourceId);
            log('activeVideoForShow returned');

            const editItem = activeJson.included?.find(x => x.type === 'edit');
            const audioTracks = editItem?.attributes?.audioTracks || [];
            log(audioTracks);
            const originalAudioTrack = audioTracks.find(t => /Original/i.test(t));
            log(originalAudioTrack);
            let originalLanguageTag = "und";
            if (originalAudioTrack) {
                const langFull = originalAudioTrack.split('-')[0].trim();
                // map full language name → ISO tag
                const langMap = {
                    "English": "en-US",
                    "Bulgarian": "bg",
                    "Chinese": "zh",
                    "Croatian": "hr",
                    "Czech": "cs",
                    "Danish": "da",
                    "Dutch": "nl",
                    "Estonian": "et",
                    "Finnish": "fi",
                    "French": "fr-FR",
                    "French Canadian": "fr-CA",
                    "Galician": "gl",
                    "Georgian": "ka",
                    "German": "de",
                    "Hindi": "hi",
                    "Hebrew": "he",
                    "Hungarian": "hu",
                    "Icelandic": "is",
                    "Italian": "it",
                    "Japanese": "ja",
                    "Korean": "ko",
                    "Latvian": "lv",
                    "Lithuanian": "lt",
                    "Macedonian": "mk",
                    "Norwegian": "no",
                    "Norwegian Bokmal": "nb",
                    "Portuguese": "pt-PT",
                    "Portuguese (Brazilian)": "pt-BR",
                    "Polish": "pl",
                    "Romanian (Moldova)": "ro",
                    "Serbian": "sr",
                    "Serbian Latin": "sr-Latn",
                    "Slovenian": "sl",
                    "Spanish (Spain)": "es-ES",
                    "Swedish": "sv",
                    "Turkish": "tr",
                    "Ukrainian": "uk",
                };
                originalLanguageTag = langMap[langFull] || "und";
            }
            log(`original tag: ${originalLanguageTag}`);

            let editId = activeJson?.data?.relationships?.edit?.data?.id;
            if(!editId && Array.isArray(activeJson?.included)) {
                const e = activeJson.included.find(x => x.type === 'edit');
                if(e && e.id) editId = e.id;
            }
            if(!editId) throw new Error('edit id not found in activeVideoForShow response');
            log('editId', editId);

            const xWbd = await bootstrap();
            log('bootstrap token', xWbd);

            const playbackJson = await postPlayback(editId, xWbd);
            log('playback JSON received');

            const manifestUrl = manifestUrlFromPlayback(playbackJson);
            log('manifest url', manifestUrl);

            const subs = await fetchMpdAndExtractSubs(manifestUrl);
            log('subtitles parsed', subs);

            if(!subs || !subs.length) {
                alert('No subtitles found in MPD.');
                return;
            }
            let filteredSubs = subs;
            if (originalLanguageTag !== "und") {
                filteredSubs = subs.filter(s => {
                    if (s.subtitle_role === '[forced]') {
                        // only keep English forced or original language forced
                        return s.language === 'en-US' || s.language === originalLanguageTag;
                    }
                    return true; // keep all forced subs if no original language is detected
                });
            }

            await buildZipAndDownload(filteredSubs, titleName, year);

        } catch(e) {
            err('Flow error', e);
            alert('Error: ' + (e && e.message ? e.message : e));
            removeProgressOverlay();
        }
    }

    // inject button
    const btn = document.createElement('button');
    btn.textContent = 'Download Subtitles';
    btn.style = 'position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:999999;padding:8px;background:#f2f2f2;border:none;border-radius:4px;color:#000;font-weight:700;cursor:pointer'; //right:10px
    btn.onclick = doThing;
    document.body.appendChild(btn);

    function updateButtonText(text) {
        btn.textContent = text;
    }

    // check if we are on a watch page
    function isWatchPage() {
        return location.pathname.startsWith('/video/watch/');
    }

    // set initial visibility
    btn.style.display = isWatchPage() ? '' : 'none';

    // toggle visibility of download button if on watch page
    function updateButtonVisibility() {
        btn.style.display = isWatchPage() ? '' : 'none';
    }

    // track navigation state changes
    (function() {
        const _pushState = history.pushState;
        history.pushState = function() {
            const result = _pushState.apply(this, arguments);
            window.dispatchEvent(new Event('locationchange'));
            return result;
        };
        const _replaceState = history.replaceState;
        history.replaceState = function() {
            const result = _replaceState.apply(this, arguments);
            window.dispatchEvent(new Event('locationchange'));
            return result;
        };
    })();

    // listen for navigation events
    window.addEventListener('popstate', () => window.dispatchEvent(new Event('locationchange')));
    window.addEventListener('locationchange', updateButtonVisibility);

    // detect DOM changes that may indicate a route load
    const _mo = new MutationObserver(() => updateButtonVisibility());
    _mo.observe(document.documentElement || document.body, { childList: true, subtree: true });

    let _lastPath = location.pathname;
    setInterval(() => {
        if (location.pathname !== _lastPath) {
            _lastPath = location.pathname;
            updateButtonVisibility();
        }
    }, 500);
})();

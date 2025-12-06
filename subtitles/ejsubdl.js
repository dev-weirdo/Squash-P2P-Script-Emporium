// ==UserScript==
// @name         ejsubdl
// @namespace    ejsubdl
// @version      1.0
// @description  Intercept master m3u8 XHR request to download subtitles from ERR Jupiter.
// @author       squash
// @match        https://jupiter.err.ee/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @connect      *
// ==/UserScript==

(function () {
    'use strict';

    // Prevent double-injection
    if (window.__ERR_VTT_COLLECTOR_RUNNING__) return;
    window.__ERR_VTT_COLLECTOR_RUNNING__ = true;

    const CONCURRENCY = 1000;
    const SEGMENT_TIMEOUT_MS = 20000;

    let statusEl = null;
    let capturedMaster = null; // URL of master.m3u8
    let masterBody = null; // body of master
    let contentMeta = null; // {heading, year, masterUrl?}
    let busy = false;
    let processingStarted = false; // prevents duplicate runs

    /* ---------------- UI ---------------- */
    function ensureStatus() {
        if (statusEl) return statusEl;

        const el = document.createElement('div');

        // --- Positioning (top center) ---
        el.style.position = 'fixed';
        el.style.top = '12px';
        el.style.left = '50%';
        el.style.transform = 'translateX(-50%)';
        el.style.zIndex = 9999999;

        // --- Appearance (larger, clearer) ---
        el.style.background = 'rgba(30,144,255,0.75)';
        el.style.color = '#fff';
        el.style.padding = '12px 20px';
        el.style.fontFamily = 'Arial, sans-serif';
        el.style.fontSize = '16px';
        el.style.borderRadius = '8px';
        el.style.boxShadow = '0 2px 10px rgba(0,0,0,0.5)';
        el.style.fontWeight = 'bold';

        el.textContent = 'ejsubdl: idle';

        document.documentElement.appendChild(el);
        statusEl = el;

        return el;
    }

    function setStatus(text, printConsole = true) {
        try { ensureStatus().textContent = 'ejsubdl: ' + text; } catch {}
        if (printConsole) {
            console.log('[ejsubdl] ' + text);
        }
    }

    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const normalizeUrl = u => { try { return new URL(u, location.href).toString(); } catch { return u; } };
    const absoluteUrl = (rel, base) => { try { return new URL(rel, base).toString(); } catch { return rel; } };
    const isMasterUrl = url => /master\.m3u8/i.test(url);

    /* ---------------- GM fetch (CORS-free) ---------------- */
    function gmFetchText(url, timeoutMs = SEGMENT_TIMEOUT_MS) {
        return new Promise((resolve) => {
            try {
                GM_xmlhttpRequest({
                    method: 'GET',
                    url,
                    responseType: 'text',
                    timeout: timeoutMs,
                    headers: { 'Accept': '*/*' },
                    onload: res => resolve(res.responseText || ''),
                    onerror: err => { console.warn('[ejsubdl] GM onerror', url, err); resolve(null); },
                    ontimeout: () => { console.warn('[ejsubdl] GM timeout', url); resolve(null); },
                    withCredentials: true,
                });
            } catch (e) {
                console.warn('[ejsubdl] gmFetchText threw', e);
                resolve(null);
            }
        });
    }

    /* ---------------- Download helper ---------------- */
    function downloadBlob(text, filename='merged.vtt') {
        const blob = new Blob([text], { type: 'text/vtt;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
    }

    /* ---------------- Cue-level dedupe merge ---------------- */
    function buildMergedVttFromParts(orderedParts) {
        const seen = new Set();
        const cues = [];

        for (const raw of orderedParts) {
            if (!raw) continue;
            const part = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
            const body = part.replace(/^\s*WEBVTT[^\n]*\n?/i, '').replace(/^\s*\n+/, '');
            if (!body.trim()) continue;

            const blocks = body.split(/\n{2,}/);
            for (const block of blocks) {
                const linesAll = block.split('\n').map(l => l.trimEnd()).filter(l => l.trim().length > 0);
                if (linesAll.length === 0) continue;

                let tsIdx = linesAll.findIndex(l => l.includes('-->'));
                if (tsIdx === -1) continue;

                const tsLine = linesAll[tsIdx].trim();
                const textLines = linesAll.slice(tsIdx + 1);
                const text = textLines.join('\n').trim();
                const key = tsLine + '|' + text.replace(/\s+/g, ' ').trim();
                if (seen.has(key)) continue;
                seen.add(key);
                cues.push({ ts: tsLine, text });
            }
        }

        const out = ['WEBVTT', ''];
        cues.forEach((cue, idx) => {
            out.push(String(idx + 1));
            out.push(cue.ts);
            if (cue.text) out.push(cue.text);
            out.push('');
        });
        return out.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
    }

    /* ---------------- Subtitle playlist -> segments -> merged ---------------- */
    async function fetchPlaylistSegments(playlistUrl) {
        const body = await gmFetchText(playlistUrl);
        if (!body) return null;

        const lines = body.split('\n').map(l => l.trim()).filter(Boolean);
        const segments = [];
        for (const line of lines) {
            if (line.startsWith('#')) continue;
            segments.push(absoluteUrl(line, playlistUrl));
        }
        if (segments.length === 0) return null;

        const results = new Array(segments.length);
        let idx = 0;
        let active = 0;

        for (let i = 0; i < segments.length; i += CONCURRENCY) {
            const batch = segments.slice(i, i + CONCURRENCY);
            await Promise.all(batch.map((url, j) => {
                const idx = i + j;
                return gmFetchText(url)
                    .then(txt => {
                    results[idx] = txt || '';
                    setStatus(`Fetching segment: (${idx})...`, false);
                })
                    .catch(err => {
                    console.warn('[VTT] Error', url, err);
                    results[idx] = '';
                });
            }));
        }

        return results;
    }

    /* ---------------- Master parsing ---------------- */
    function parseSubtitleTracks(masterBody, masterUrl) {
        const tracks = [];
        const lines = masterBody.split('\n').map(l => l.trim()).filter(Boolean);
        for (const line of lines) {
            if (!line.startsWith('#EXT-X-MEDIA')) continue;
            if (!/TYPE=SUBTITLES/i.test(line)) continue;
            const lang = attr(line, 'LANGUAGE') || '';
            const name = attr(line, 'NAME') || lang || 'sub';
            const uri = attr(line, 'URI');
            if (!uri) continue;
            const abs = absoluteUrl(uri.replace(/^"(.*)"$/, '$1'), masterUrl);
            tracks.push({ lang: lang || 'und', name, uri: abs });
        }
        return tracks;

        function attr(line, key) {
            const m = line.match(new RegExp(key + '="([^"]+)"', 'i'));
            return m ? m[1] : null;
        }
    }

    /* ---------------- Metadata parsing ---------------- */
    function parseContentMeta(jsonText) {
        try {
            const obj = JSON.parse(jsonText);
            const heading = obj?.data?.mainContent?.heading || '';
            const year = obj?.data?.mainContent?.year || '';
            const medias = obj?.data?.mainContent?.medias || [];
            let masterFromMeta = null;
            if (medias.length) {
                const src = medias[0]?.src || {};
                masterFromMeta = src.hlsNew || src.hls || src.hls2;
                if (masterFromMeta && masterFromMeta.startsWith('//')) {
                    masterFromMeta = 'https:' + masterFromMeta;
                }
            }
            const meta = {};
            if (heading) meta.heading = heading;
            if (year) meta.year = year;
            if (masterFromMeta) meta.masterUrl = masterFromMeta;
            return meta;
        } catch (e) {}
        return null;
    }

    function buildFilename(meta, langTag) {
        const title = (meta?.heading || 'Title').replace(/[^\w\s.-]/g, '').trim();
        const year = (meta?.year || '').toString().trim();
        const dottedTitle = title.replace(/\s+/g, '.');
        const lang = (langTag || 'und').replace(/\s+/g, '').toLowerCase();
        return `${dottedTitle}.${year ? year + '.' : ''}Err.Jupiter.WEB.${lang}.vtt`;
    }

    function mapLangTag(lang) {
        if (!lang) return 'und';
        const low = lang.toLowerCase();
        if (low === 'und') return 'et-sdh'; // per requirement
        return low;
    }
    function isSDH(mappedLang) {
        return mappedLang.toLowerCase().includes('sdh');
    }

    /* ---------------- Main pipeline ---------------- */
    async function ensureMasterFetched() {
        if (!capturedMaster || masterBody) return;
        setStatus('Fetching master.m3u8 directly...');
        const body = await gmFetchText(capturedMaster);
        if (body) {
            masterBody = body;
            setStatus('Fetched master.m3u8 directly.');
        } else {
            setStatus('Failed to fetch master.m3u8 directly.');
        }
    }

    async function processOnceReady() {
        if (processingStarted) return;
        if (!capturedMaster && contentMeta?.masterUrl) {
            capturedMaster = normalizeUrl(contentMeta.masterUrl);
            setStatus('Using master.m3u8 from metadata');
        }
        if (!capturedMaster || !contentMeta) return;

        // Mark started to avoid duplicate runs
        processingStarted = true;

        if (!masterBody) {
            await ensureMasterFetched();
            if (!masterBody) { processingStarted = false; return; }
        }

        busy = true;
        setStatus('Processing master.m3u8 for subtitle tracks...');

        const tracks = parseSubtitleTracks(masterBody, capturedMaster);
        console.log('[ejsubdl] Found subtitle tracks:', tracks);
        if (!tracks.length) {
            setStatus('No subtitle tracks found in master.m3u8');
            busy = false;
            return;
        }

        for (const track of tracks) {
            const mappedLang = mapLangTag(track.lang);
            if (isSDH(mappedLang)) {
                console.log('[ejsubdl] Skipping SDH track', track);
                continue;
            }

            setStatus(`Fetching subtitle playlist segments (${mappedLang})...`);
            const parts = await fetchPlaylistSegments(track.uri);
            if (!parts) {
                console.warn('[ejsubdl] No segments for track', track);
                continue;
            }
            console.log('[ejsubdl] Segments fetched:', parts.length, 'for', mappedLang);
            setStatus(`Merging ${parts.length} segments (${mappedLang})...`);
            const merged = buildMergedVttFromParts(parts);
            const filename = buildFilename(contentMeta, mappedLang);
            downloadBlob(merged, filename);
            setStatus(`Downloaded ${filename}`);
            await sleep(300);
        }

        setStatus('Done.');
        busy = false;
    }

    /* ---------------- Hooks: capture master.m3u8 and metadata ---------------- */
    function maybeHandleUrl(url, body) {
        const lower = url.toLowerCase();
        if (isMasterUrl(lower)) {
            capturedMaster = normalizeUrl(url);
            if (body) masterBody = body;
            setStatus('Captured master.m3u8');
            processOnceReady();
        } else if (lower.includes('getcontentpagedata')) {
            const meta = parseContentMeta(body || '');
            if (meta) {
                contentMeta = { ...contentMeta, ...meta };
                processOnceReady();
            }
        }
    }

    function patchXHR() {
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url) {
            try { this.__mon_url = (typeof url === 'string') ? url : (url && url.toString()); } catch { this.__mon_url = url; }
            return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function (body) {
            try {
                if (!this.__mon_hooked) {
                    this.addEventListener('load', function () {
                        try {
                            const respUrl = (this.responseURL && typeof this.responseURL === 'string') ? this.responseURL : (this.__mon_url || '');
                            if (!respUrl) return;
                            if (isMasterUrl(respUrl) || respUrl.toLowerCase().includes('getcontentpagedata')) {
                                const txt = (typeof this.responseText === 'string') ? this.responseText : '';
                                maybeHandleUrl(respUrl, txt);
                            }
                        } catch (e) { console.warn('[ejsubdl] XHR load handler error', e); }
                    }, { once: true });
                    this.__mon_hooked = true;
                }
            } catch {}
            return origSend.apply(this, arguments);
        };
    }

    function patchFetch() {
        if (!window.fetch) return;
        const origFetch = window.fetch;
        window.fetch = function (input, init) {
            let candidateUrl = '';
            try {
                if (typeof input === 'string') candidateUrl = input;
                else if (input && input.url) candidateUrl = input.url;
            } catch {}
            return origFetch.call(this, input, init).then(async (resp) => {
                try {
                    const respUrl = (resp && resp.url) ? resp.url : candidateUrl;
                    if (respUrl && (isMasterUrl(respUrl) || respUrl.toLowerCase().includes('getcontentpagedata'))) {
                        let txt = null;
                        try { txt = await resp.clone().text().catch(()=>null); } catch { txt = null; }
                        maybeHandleUrl(respUrl, txt || '');
                    }
                } catch (e) { console.warn('[ejsubdl] fetch wrapper error', e); }
                return resp;
            });
        };
    }

    /* ---------------- DOM / performance fallbacks ---------------- */
    function observeDom() {
        const checkNode = (node) => {
            if (node.nodeType !== 1) return;
            const el = node;
            const attrs = ['src', 'href', 'data-src'];
            for (const a of attrs) {
                const v = el.getAttribute && el.getAttribute(a);
                if (!v) continue;
                const url = absoluteUrl(v, location.href);
                if (isMasterUrl(url) || url.toLowerCase().includes('getcontentpagedata')) {
                    gmFetchText(url).then(txt => maybeHandleUrl(url, txt || ''));
                    return;
                }
            }
        };
        const mo = new MutationObserver((muts) => {
            for (const m of muts) (m.addedNodes || []).forEach(checkNode);
        });
        mo.observe(document.documentElement || document, { childList: true, subtree: true });
        setTimeout(() => {
            document.querySelectorAll('[src],[href],[data-src]').forEach(checkNode);
        }, 800);
    }

    function scanPerformance() {
        const seen = new Set();
        const tick = () => {
            try {
                const entries = performance.getEntriesByType('resource') || [];
                for (const e of entries) {
                    const n = e.name || '';
                    if (!n || seen.has(n)) continue;
                    seen.add(n);
                    if (isMasterUrl(n) || n.toLowerCase().includes('getcontentpagedata')) {
                        gmFetchText(n).then(txt => maybeHandleUrl(n, txt || ''));
                        return;
                    }
                }
            } catch {}
            setTimeout(tick, 1200);
        };
        setTimeout(tick, 1200);
    }


    /* ---------------- Init ---------------- */
    console.log('[ejsubdl] v1.0 loaded — waiting for master.m3u8 (fetch or metadata) and metadata.');
    ensureStatus();
    patchXHR();
    patchFetch();
    observeDom();
    scanPerformance();
})();

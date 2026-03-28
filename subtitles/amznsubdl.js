// ==UserScript==
// @name        Amazon Subtitle Downloader
// @description Download subtitles from Amazon Prime Video
// @author      squasher
// @license     MIT
// @version     3.4
// @match       https://*.amazon.com/*
// @match       https://*.amazon.de/*
// @match       https://*.amazon.co.uk/*
// @match       https://*.amazon.co.jp/*
// @match       https://*.primevideo.com/*
// @grant       unsafeWindow
// @require     https://cdn.jsdelivr.net/gh/Stuk/jszip@579beb1d45c8d586d8be4411d5b2e48dea018c06/dist/jszip.min.js?version=3.1.5
// @require     https://cdn.jsdelivr.net/gh/eligrey/FileSaver.js@283f438c31776b622670be002caf1986c40ce90c/dist/FileSaver.min.js?version=2018-12-29
// ==/UserScript==

class ProgressBar {
    constructor(max) {
        this.current = 0;
        this.max = max;

        let container = document.querySelector("#userscript_progress_bars");
        if (container === null) {
            container = document.createElement("div");
            container.id = "userscript_progress_bars";
            document.body.appendChild(container);
            container.style.position = "fixed";
            container.style.top = 0;
            container.style.left = 0;
            container.style.width = "100%";
            container.style.background = "red";
            container.style.zIndex = "99999999";
        }

        this.progressElement = document.createElement("div");
        this.progressElement.innerHTML = "Click to stop";
        this.progressElement.style.cursor = "pointer";
        this.progressElement.style.fontSize = "16px";
        this.progressElement.style.textAlign = "center";
        this.progressElement.style.width = "100%";
        this.progressElement.style.height = "20px";
        this.progressElement.style.background = "transparent";
        this.stop = new Promise(resolve => {
            this.progressElement.addEventListener("click", () => { resolve(STOP_THE_DOWNLOAD); });
        });

        container.appendChild(this.progressElement);
    }

    updateLabel(label) {
        this.progressElement.innerHTML = label;
    }

    increment() {
        this.current += 1;
        if (this.current <= this.max) {
            let p = this.current / this.max * 100;
            this.progressElement.style.background = `linear-gradient(to right, green ${p}%, transparent ${p}%)`;
        }
    }

    destroy() {
        this.progressElement.remove();
    }
}

const STOP_THE_DOWNLOAD = "AMAZON_SUBTITLE_DOWNLOADER_STOP_THE_DOWNLOAD";
const TIMEOUT_ERROR = "AMAZON_SUBTITLE_DOWNLOADER_TIMEOUT_ERROR";
const DOWNLOADER_MENU = "subtitle-downloader-menu";

const DOWNLOADER_MENU_HTML = `
<ol>
<li class="header">Amazon subtitle downloader</li>
</ol>
`;

const SCRIPT_CSS = `
#${DOWNLOADER_MENU} {
  position: fixed;
  bottom: 20px;
  right: 20px;
  width: 260px;
  background: #333;
  color: #fff;
  border-radius: 6px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.35);
  z-index: 2147483647;
  display: block;
}
#${DOWNLOADER_MENU} ol { list-style: none; padding: 0; margin: 0; font-size: 12px; }
#${DOWNLOADER_MENU} li { padding: 10px; cursor: pointer; }
#${DOWNLOADER_MENU} li.header { font-weight: bold; cursor: default; }
#${DOWNLOADER_MENU} li:not(.header):hover { background: #444; }
#${DOWNLOADER_MENU} li.status { cursor: default; opacity: 0.6; font-style: italic; }
`;

const EXTENSIONS = {
    "TTMLv2": "ttml2",
    "DFXP": "dfxp"
};

// cache captured subtitle data from intercepted playback responses
// map titleId -> { subtitleUrls, forcedNarrativeUrls }
const SUBTITLE_CACHE = new Map();

// try multiple known JSON paths Amazon has used for subtitle URLs across API versions, changes frequently
// returns { subtitleUrls, forcedNarrativeUrls } or null if nothing found.
const extractSubtitleResult = (data) => {
    const candidates = [
        data?.playbackData?.timedTextUrls?.result,
        data?.playbackData?.timedTextUrls,
        // original / legacy paths
        data?.timedTextUrls?.result,
        data?.timedTextUrls,
        // other wrappers
        data?.catalogMetadata?.timedTextUrls?.result,
        data?.catalogMetadata?.timedTextUrls,
        data?.playbackResources?.timedTextUrls?.result,
        data?.playbackResources?.timedTextUrls,
        data?.resources?.timedTextUrls?.result,
        data?.resources?.timedTextUrls,
        data?.subtitleResources,
        data?.subtitles,
    ];

    for (const c of candidates) {
        if (c && typeof c === "object" && (c.subtitleUrls?.length || c.forcedNarrativeUrls?.length)) {
            return c;
        }
    }

    // walk every top-level key and look for timedTextUrls / subtitleUrls inside
    if (data && typeof data === "object") {
        for (const topKey of Object.keys(data)) {
            const top = data[topKey];
            if (!top || typeof top !== "object") continue;

            const innerCandidates = [
                top?.timedTextUrls?.result,
                top?.timedTextUrls,
                top?.subtitleUrls !== undefined ? top : null,
            ];
            for (const c of innerCandidates) {
                if (c && typeof c === "object" && (c.subtitleUrls?.length || c.forcedNarrativeUrls?.length)) {
                    console.log("[Amazon Subtitle Downloader] found subtitles at non-standard path:", topKey);
                    return c;
                }
            }

            for (const innerKey of Object.keys(top)) {
                const inner = top[innerKey];
                if (!inner || typeof inner !== "object") continue;
                if (inner.subtitleUrls?.length || inner.forcedNarrativeUrls?.length) {
                    console.log("[Amazon Subtitle Downloader] found subtitles at deep path:", topKey, "->", innerKey);
                    return inner;
                }
            }
        }
    }

    // log keys inside timedTextUrls if present, to help debug
    if (data?.timedTextUrls && typeof data.timedTextUrls === "object") {
        console.warn("[Amazon Subtitle Downloader] timedTextUrls found but unrecognized structure. Keys:", Object.keys(data.timedTextUrls));
    }
    if (data?.playbackData && typeof data.playbackData === "object") {
        console.warn("[Amazon Subtitle Downloader] playbackData keys:", Object.keys(data.playbackData));
    }

    return null;
};

const LANG_MAP = {
    "ar-eg": "ar", "ar-sa": "ar", "ar-001": "ar", "ar-ar": "ar",
    "bg-bg": "bg", "bn-in": "bn", "ca-es": "ca", "cs-cz": "cs",
    "da-dk": "da", "de-de": "de", "el-gr": "el", "en-gb": "en-GB",
    "en": "en-US", "en-us": "en-US", "es-es": "es-ES", "es": "es-419",
    "es-mx": "es-MX", "eu-es": "eu", "fi-fi": "fi", "fil-ph": "fil",
    "fil-tl": "fil-TL", "fr-ca": "fr-CA", "fr": "fr-FR", "fr-fr": "fr-FR",
    "gl-es": "gl", "he-il": "he", "he-in": "he", "hi-in": "hi",
    "hr-hr": "hr", "hu-hu": "hu", "id-id": "id", "it-it": "it",
    "is-is": "is", "ja-jp": "ja", "kn-in": "kn", "ko-kr": "ko",
    "lt-lt": "lt", "lv-lv": "lv", "ml-in": "ml", "mr-in": "mr",
    "ms-my": "ms", "nb": "no", "nb-no": "no", "nn-no": "nn", "no-no": "no",
    "nl-nl": "nl", "pl-pl": "pl", "pt": "pt-PT", "pt-pt": "pt-PT",
    "pt-br": "pt-BR", "ro-ro": "ro", "ru-ru": "ru", "sl-sl": "sl",
    "sl-si": "sl", "sk-sk": "sk", "sv-se": "sv", "sv-sv": "sv",
    "ta-in": "ta", "te-in": "te", "th-th": "th", "tr-tr": "tr",
    "uk-ua": "uk", "vi-vn": "vi", "zh-hans": "zh-Hans", "zh-hant": "zh-Hant",
};

function mapLangCode(langCode) {
    if (LANG_MAP.hasOwnProperty(langCode)) langCode = LANG_MAP[langCode];
    return langCode;
}

const asyncSleep = (seconds, value) => new Promise(resolve => {
    window.setTimeout(resolve, seconds * 1000, value);
});

// sanitize filenames
const sanitizeName = name => name.replace(/[:*?"<>|\\\/]+/g, "").replace(/ /g, ".").replace(/\.{2,}/g, ".").replace("Prime.Video.", "");

// XML to SRT unused, but if a user wants it, it can be enabled
const parseTTMLLine = (line, parentStyle, styles) => {
    const topStyle = line.getAttribute("style") || parentStyle;
    let prefix = "";
    let suffix = "";
    let italic = line.getAttribute("tts:fontStyle") === "italic";
    let bold = line.getAttribute("tts:fontWeight") === "bold";
    let ruby = line.getAttribute("tts:ruby") === "text";
    if (topStyle !== null) {
        italic = italic || styles[topStyle][0];
        bold = bold || styles[topStyle][1];
        ruby = ruby || styles[topStyle][2];
    }

    if (italic) {
        prefix = "<i>";
        suffix = "</i>";
    }
    if (bold) {
        prefix += "<b>";
        suffix = "</b>" + suffix;
    }
    if (ruby) {
        prefix += "(";
        suffix = ")" + suffix;
    }

    let result = "";

    for (const node of line.childNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
            const tagName = node.tagName.split(":").pop().toUpperCase();
            if (tagName === "BR") {
                result += "\n";
            } else if (tagName === "SPAN") {
                result += parseTTMLLine(node, topStyle, styles);
            } else {
                console.log("unknown node:", node);
                throw "unknown node";
            }
        } else if (node.nodeType === Node.TEXT_NODE) {
            result += prefix + node.textContent + suffix;
        }
    }

    return result;
};

const xmlToSrt = (xmlString, lang) => {
    try {
        let parser = new DOMParser();
        var xmlDoc = parser.parseFromString(xmlString, "text/xml");

        const styles = {};
        for (const style of xmlDoc.querySelectorAll("head styling style")) {
            const id = style.getAttribute("xml:id");
            if (id === null) throw "style ID not found";
            const italic = style.getAttribute("tts:fontStyle") === "italic";
            const bold = style.getAttribute("tts:fontWeight") === "bold";
            const ruby = style.getAttribute("tts:ruby") === "text";
            styles[id] = [italic, bold, ruby];
        }

        const regionsTop = {};
        for (const style of xmlDoc.querySelectorAll("head layout region")) {
            const id = style.getAttribute("xml:id");
            if (id === null) throw "style ID not found";
            const origin = style.getAttribute("tts:origin") || "0% 80%";
            const position = parseInt(origin.match(/\s(\d+)%/)[1]);
            regionsTop[id] = position < 50;
        }

        const topStyle = xmlDoc.querySelector("body").getAttribute("style");

        const lines = [];
        const textarea = document.createElement("textarea");

        let i = 0;
        for (const line of xmlDoc.querySelectorAll("body p")) {
            let parsedLine = parseTTMLLine(line, topStyle, styles);
            if (parsedLine != "") {
                if (lang.indexOf("ar") == 0) parsedLine = parsedLine.replace(/^(?!\u202B|\u200F)/gm, "\u202B");

                textarea.innerHTML = parsedLine;
                parsedLine = textarea.value;
                parsedLine = parsedLine.replace(/\n{2,}/g, "\n");

                const region = line.getAttribute("region");
                if (regionsTop[region] === true) parsedLine = "{\\an8}" + parsedLine;

                lines.push(++i);
                lines.push((line.getAttribute("begin") + " --> " + line.getAttribute("end")).replace(/\./g, ","));
                lines.push(parsedLine);
                lines.push("");
            }
        }
        return lines.join("\n");
    } catch (e) {
        console.error(e);
        alert("Failed to parse XML subtitle file, see browser console for more details.");
        return null;
    }
};

// get titleId from the current page
const getTitleIdFromPage = () => {
    const patterns = [
        /\/detail\/(amzn1[^\/?#]+)/i,
        /\/detail\/([A-Z0-9]+)/i,
        /\/dp\/(amzn1[^\/?#]+)/i,
        /\/dp\/([A-Z0-9]+)/i,
        /\/gp\/video\/detail\/(amzn1[^\/?#]+)/i,
        /\/gp\/video\/detail\/([A-Z0-9]+)/i,
        /\/watch\/(amzn1[^\/?#]+)/i,
        /\/watch\/([A-Z0-9]+)/i,
    ];
    for (const p of patterns) {
        const m = location.pathname.match(p);
        if (m) return m[1];
    }
    const params = new URLSearchParams(location.search);
    return params.get("titleId") || params.get("gti") || null;
};

// get titleId from a playback resources URL
const getTitleIdFromUrl = (url) => {
    try {
        const u = new URL(url);
        return u.searchParams.get("titleId") || null;
    } catch (e) {
        return null;
    }
};

// get the content title from the page
const getPageTitle = () => {
    const selectors = [
        '[data-automation-id="title"]',
        '[data-testid="title"]',
        'h1[data-title]',
        'h1',
        '.av-detail-section h1',
    ];
    for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
    }
    return document.title.replace(/\s*[-–|].*(?:Prime Video|Amazon).*$/i, "").replace("Prime Video: ", "").trim();
};

// get the release year from the page
const getReleaseYear = () => {
    const el = document.querySelector('span[data-automation-id="release-year-badge"]');
    if (el) return el.textContent.trim();

};

// download subtitles using cached response data
const downloadFromCache = async (titleId) => {
    const cached = SUBTITLE_CACHE.get(titleId);
    if (!cached) {
        alert(
            "No subtitle data captured yet for this title.\n\n" +
            "Wait for the page to fully load, then try again."
        );
        return;
    }

    const displayTitle = getPageTitle() || titleId;
    const releaseYear = getReleaseYear()
    const allSubs = [].concat(cached.subtitleUrls || [], cached.forcedNarrativeUrls || []);
    if (allSubs.length === 0) {
        alert("No subtitles found");
        return;
    }

    const safeName = sanitizeName(displayTitle);
    const subsEntries = [];

    for (const subtitle of allSubs) {
        let lang = mapLangCode(subtitle.languageCode);
        if (subtitle.subtype !== "Dialog") lang += `[${subtitle.subtype}]`;

        if (subtitle.type === "Subtitle") {
            // no suffix
        } else if (subtitle.type === "Sdh") {
            lang += "[sdh]";
        } else if (subtitle.type === "ForcedNarrative") {
            lang += "[forced]";
        } else if (subtitle.type === "SubtitleMachineGenerated") {
            lang += "[machine-generated]";
        } else {
            lang += `[${subtitle.type}]`;
        }

        let subName = safeName + "." + releaseYear + ".AMZN.WEB." + lang;
        // deduplicate names
        const usedNames = subsEntries.map(e => e.name);
        let i = 2;
        while (usedNames.includes(subName)) {
            subName = `${safeName}.AMZN.WEB.${lang}_${i}`;
            ++i;
        }
        subsEntries.push({
            name: subName,
            url: subtitle.url,
            type: subtitle.format,
            language: subtitle.languageCode
        });
    }

    const progress = new ProgressBar(subsEntries.length);
    let stopped = false;

    // listen for stop click
    progress.stop.then(() => { stopped = true; });

    // fetch all subtitle files in parallel
    const fetchResults = await Promise.all(
        subsEntries.map(entry => {
            let extension = EXTENSIONS[entry.type];
            if (typeof extension === "undefined") {
                const match = entry.url.match(/\.([^.\/]+)$/);
                extension = match ? match[1] : entry.type.toLowerCase();
            }
            return fetch(entry.url, { mode: "cors" })
                .then(resp => resp.arrayBuffer())
                .then(buf => {
                    progress.increment();
                    return { entry, extension, buf, error: null };
                })
                .catch(e => {
                    progress.increment();
                    return { entry, extension, buf: null, error: e };
                });
        })
    );

    progress.destroy();

    if (stopped) return;

    const _zip = new JSZip();
    let errorCount = 0;

    for (const { entry, extension, buf, error } of fetchResults) {
        if (error || !buf) {
            console.warn("[Amazon Subtitle Downloader] failed to download:", entry.name, error);
            errorCount++;
            continue;
        }

        let subFilename = entry.name + "." + extension;

        // strip SDH tag if the subtitle doesn't actually contain SDH markers
        const bytes = new Uint8Array(buf);
        const hasSdh = bytes.some(b => b === 40 || b === 41 || b === 91 || b === 93);
        if (!hasSdh && subFilename.includes("[sdh]")) {
            subFilename = subFilename.replace("[sdh]", "");
        }
        if (!subFilename.includes("machine-generated")) {
            _zip.file(subFilename, buf);
        }
    }

    if (errorCount > 0) {
        console.warn(`[Amazon Subtitle Downloader] ${errorCount} subtitle(s) failed to download`);
    }

    const content = await _zip.generateAsync({ type: "blob" });
    saveAs(content, safeName + ".zip");
};

// script menu interface
const updateMenuStatus = () => {
    const menu = document.querySelector(`#${DOWNLOADER_MENU}`);
    if (!menu) return;

    const titleId = getTitleIdFromPage();
    const statusEl = menu.querySelector(".status");
    const downloadEl = menu.querySelector(".download-btn");

    if (!titleId) {
        if (statusEl) statusEl.innerHTML = "Navigate to a title page";
        if (downloadEl) downloadEl.style.display = "none";
        return;
    }

    if (SUBTITLE_CACHE.has(titleId)) {
        const count = (SUBTITLE_CACHE.get(titleId).subtitleUrls || []).length +
                      (SUBTITLE_CACHE.get(titleId).forcedNarrativeUrls || []).length;
        if (statusEl) statusEl.innerHTML = `&#10003; ${count} subtitle track(s) captured`;
        if (downloadEl) {
            downloadEl.style.display = "block";
            downloadEl.style.opacity = "1";
            downloadEl.style.cursor = "pointer";
            downloadEl.onclick = () => downloadFromCache(titleId);
        }
    } else {
        if (statusEl) statusEl.innerHTML = "Waiting for subtitle data...";
        if (downloadEl) {
            downloadEl.style.display = "block";
            downloadEl.style.opacity = "0.5";
            downloadEl.style.cursor = "pointer";
            downloadEl.onclick = () => downloadFromCache(titleId);
        }
    }
};

const ensureMenu = () => {
    if (document.querySelector(`#${DOWNLOADER_MENU}`)) {
        updateMenuStatus();
        return;
    }
    const menu = document.createElement("div");
    menu.id = DOWNLOADER_MENU;
    menu.innerHTML = DOWNLOADER_MENU_HTML;
    document.body.appendChild(menu);

    const ol = menu.querySelector("ol");

    const statusLi = document.createElement("li");
    statusLi.className = "status";
    statusLi.innerHTML = "Waiting...";
    ol.appendChild(statusLi);

    const downloadLi = document.createElement("li");
    downloadLi.className = "download-btn";
    downloadLi.innerHTML = "Download subtitles";
    downloadLi.style.fontWeight = "bold";
    downloadLi.style.display = "none";
    ol.appendChild(downloadLi);

    updateMenuStatus();
};

// intercept fetch to capture playback responses

// url match GetVodPlaybackResources endpoint
const isPlaybackUrl = (u) => typeof u === "string" && /GetVodPlaybackResources/i.test(u);

// wait-for-valid-response helpers (to handle transient timedTextUrls.error)
const WAIT_FOR_VALID_MS = 8000; // wait this long for a later valid playback response
const PENDING_PLAYBACK = new Map(); // key -> { timeoutId, error }

// extract a timedTextUrls.error if present
function getTimedTextError(data) {
    if (!data || typeof data !== "object") return null;
    const candidates = [
        data?.timedTextUrls,
        data?.timedTextUrls?.result,
        data?.playbackData?.timedTextUrls,
        data?.playbackData?.timedTextUrls?.result,
        data?.playbackData?.result?.timedTextUrls,
        data?.playbackData?.result?.timedTextUrls?.result,
    ];
    for (const c of candidates) {
        if (c && typeof c === "object" && c.error) return c.error;
    }
    // scan top-level keys for timedTextUrls.error
    for (const k of Object.keys(data)) {
        try {
            const v = data[k];
            if (v && typeof v === "object" && v.timedTextUrls && v.timedTextUrls.error) return v.timedTextUrls.error;
            if (v && typeof v === "object" && v.timedTextUrls?.result && v.timedTextUrls.result.error) return v.timedTextUrls.result.error;
        } catch (e) {}
    }
    return null;
}

// handler used by both interceptors to process playback JSON responses
function handlePlaybackResponse(data, titleId, url, source) {
    try {
        const result = extractSubtitleResult(data);
        if (result) {
            // valid, cache it and clear any pending error wait
            const cacheKey = titleId || getTitleIdFromPage() || url || "unknown";
            SUBTITLE_CACHE.set(cacheKey, result);
            console.log("[Amazon Subtitle Downloader] cached subtitle data for:", cacheKey,
                        (result.subtitleUrls || []).length, "subtitle tracks,",
                        (result.forcedNarrativeUrls || []).length, "forced narrative tracks (source:", source, ")");
            updateMenuStatus();

            // clear any pending timeout for this url/titleId
            const key = titleId || url;
            const p = PENDING_PLAYBACK.get(key);
            if (p) {
                clearTimeout(p.timeoutId);
                PENDING_PLAYBACK.delete(key);
            }
            return;
        }

        // no valid subtitles found in this response
        // if there is an explicit timedTextUrls.error, wait a bit for a later response
        const timedErr = getTimedTextError(data);
        if (timedErr) {
            const key = titleId || url;
            if (!PENDING_PLAYBACK.has(key)) {
                console.warn("[Amazon Subtitle Downloader] timedTextUrls returned error (will wait briefly for a valid response):", timedErr);
                const timeoutId = setTimeout(() => {
                    // timeout expired and no valid response arrived
                    const pending = PENDING_PLAYBACK.get(key);
                    if (pending) {
                        console.warn("[Amazon Subtitle Downloader] timedTextUrls error persisted after wait:", pending.error);
                        PENDING_PLAYBACK.delete(key);
                    }
                }, WAIT_FOR_VALID_MS);
                PENDING_PLAYBACK.set(key, { timeoutId, error: timedErr });
            }
        }
    } catch (e) {
        console.warn("[Amazon Subtitle Downloader] error handling playback response:", e);
    }
}

// fetch interceptor
// delegates to handlePlaybackResponse and waits for later valid responses if timedTextUrls.error present
const startFetchInterceptor = () => {
    const target = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    const originalFetch = target.fetch;

    target.fetch = function (...args) {
        const request = args[0];
        const url = (typeof request === "string") ? request : (request?.url || "");

        if (!isPlaybackUrl(url)) {
            return originalFetch.apply(this, args);
        }

        const titleId = getTitleIdFromUrl(url);
        console.log("[Amazon Subtitle Downloader] intercepted playback request for titleId:", titleId);

        const resultPromise = originalFetch.apply(this, args);

        resultPromise.then(response => {
            // clone and parse, but do not treat an error as final, delegate to handler which waits for a valid response
            response.clone().json().then(data => {
                handlePlaybackResponse(data, titleId, url, "fetch");
            }).catch(() => { /* not JSON or parse failed, ignore */ });
        }).catch(() => { /* fetch failed, ignore */ });

        return resultPromise;
    };
};

// XHR interceptor
// delegates to handlePlaybackResponse and waits for later valid responses if timedTextUrls.error present
const startXHRInterceptor = () => {
    const target = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    const originalOpen = target.XMLHttpRequest.prototype.open;
    const originalSend = target.XMLHttpRequest.prototype.send;

    target.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this._asdUrl = url;
        return originalOpen.call(this, method, url, ...rest);
    };

    target.XMLHttpRequest.prototype.send = function (...args) {
        if (this._asdUrl && isPlaybackUrl(this._asdUrl)) {
            const url = this._asdUrl;
            const titleId = getTitleIdFromUrl(url);
            console.log("[Amazon Subtitle Downloader] intercepted XHR playback request for titleId:", titleId);

            this.addEventListener("load", function () {
                try {
                    const text = this.responseText;
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch (e) {
                        data = null;
                    }
                    if (!data) return;
                    handlePlaybackResponse(data, titleId, url, "xhr");
                } catch (e) {
                    // ignore
                }
            });
        }
        return originalSend.apply(this, args);
    };
};

// re-create menu on SPA navigation
const startNavigationObserver = () => {
    let lastUrl = location.href;
    const check = () => {
        if (location.href !== lastUrl) {
            lastUrl = location.href;
            console.log("[Amazon Subtitle Downloader] URL changed, refreshing menu");
            const existing = document.querySelector(`#${DOWNLOADER_MENU}`);
            if (existing) existing.remove();
            ensureMenu();
        }
    };
    window.addEventListener("popstate", check);
    setInterval(check, 1500);
};

// startup
console.log("[Amazon Subtitle Downloader] script loaded");

const startAsd = () => {
    console.log("[Amazon Subtitle Downloader] starting initialization");

    // intercept fetch/XHR before Amazon's player makes requests
    startFetchInterceptor();
    startXHRInterceptor();

    // start SPA navigation observer
    startNavigationObserver();

    // create the menu
    ensureMenu();

    // add CSS
    document.querySelectorAll('style[data-asd-style]').forEach(el => el.remove());
    const s = document.createElement("style");
    s.setAttribute("data-asd-style", "1");
    s.innerHTML = SCRIPT_CSS;
    document.head.appendChild(s);

    console.log("[Amazon Subtitle Downloader] initialization finished");
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startAsd, { once: true });
} else {
    startAsd();
}

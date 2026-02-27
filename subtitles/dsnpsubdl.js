// ==UserScript==
// @name           Disney+ Subtitle Downloader
// @description    Download subtitles from Disney+
// @version        1.1
// @author         squasher
// @license        MIT; https://opensource.org/licenses/MIT
// @match          https://www.disneyplus.com/*
// @grant          unsafeWindow
// @require        https://cdn.jsdelivr.net/npm/jszip@3.5.0/dist/jszip.min.js
// @require        https://cdn.jsdelivr.net/npm/file-saver@2.0.2/dist/FileSaver.min.js
// @run-at         document-start
// ==/UserScript==

(function(open, send) {
    'use strict';
    var debug = (location.hash == "#debug");
    debuglog("Disney+ Subtitle Downloader");

    function init() {
        debuglog("Document state: " + document.readyState);
        if (document.readyState == "complete" || document.readyState == "loaded") {
            start();
            debuglog("Already loaded");
        } else {
            if (window.addEventListener) {
                window.addEventListener("load", start, false);
                debuglog("Onload method: addEventListener");
            } else if (window.attachEvent) {
                window.attachEvent("onload", start);
                debuglog("Onload method: attachEvent");
            } else {
                window.onload = start;
                debuglog("Onload method: onload");
            }
        }
        document.listen = true;
    }

    function start() {
        debuglog("start");
        if (typeof document.initaudio !== "undefined") document.initaudio();
        if (typeof document.initsub !== "undefined") document.initsub();
        listensend();
        document.handleinterval = setInterval(buttonhandle,100);
    }

    if (!document.listen) init();

    document.initsub = function() {
        debuglog("initsub");
        document.disneyAuthToken = "";
        document.langs = [];
        document.segments = "";
        document.wait = false;
        document.m3u8found = false;
        document.fetchingyear = false;
        document.url = null;
        document.oldlocation = null;
        document.dmcContentId = "";
        document.filename = "";
        document.releaseyear = "";
        document.episode = "";
        document.downloadall = false;
        document.downloadid = 0;
        document.waitsub = false;
        document.segid = 0;
        document.vttlist = [];

        // add download icon
        document.styleSheets[0].addRule('#subtitleTrackPicker > div:before','content:"";color:#fff;padding-right:25px;padding-top:2px;background:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABQAAAAUCAYAAACNiR0NAAAACXBIWXMAAA7EAAAOxAGVKw4bAAAAIGNIUk0AAHonAACAgwAA+mQAAIDSAAB2hgAA7OkAADmeAAAV/sZ+0zoAAAE4SURBVHja1JS7LkRRFIa/M6aYRCEuCUEUgihFBolGVGqiFY1ConfpNB7CiygUGm8hOiMukwiCCMl8mj2xc5yZM8M0/mTlrLP2v75zydo7UclRL3AGlIAl4L6ZuUC+5oEZYBoo55lbAdai/LPTwFongG3pfwI3gZ3ovhjlXVG+BWz/6FbjKPuto1CbjWoLobYf1RZjRho4pt5F5g11QK2F6FFXo/UXdbwZEHVQvY2aztWPECdR/TkNawREHUpB03pSJ7J6Cf9gL3xOvDiiXmfAHtSplLek7qorqI/BeJjxxFG1kgNDPQjrn4VoLPozRqgCzAGXwFXILzJ8w+H6XgRegW7grcGs3gCTOfP8UgfGg139wwapxrugDl0H+oCkTZjAcsiTxBaO7HZUBI6BtfCmv4Un4aw8/RoA7wq6AO4uOhAAAAAASUVORK5CYII=) no-repeat right;width:20px;height:20px;position:absolute;top:6px;right:10px;opacity:0.6;cursor:pointer;');
        document.styleSheets[0].addRule('#subtitleTrackPicker > div:hover:before','opacity:1;');
        document.styleSheets[0].addRule('#subtitleTrackPicker > div:first-child:before','content:"All";');
    };

    // catch M3U8 files
    function listensend() {
        debuglog("listensend");
        var newOpen = function(...args) {
            this._dsnpUrl = (args.length >= 2) ? args[1] : "";
            if (!document.m3u8found && args.length >= 2) {
                if (args[1].indexOf(".m3u8") > 0 && document.url != args[1]) {
                    // m3u8 url
                    debuglog("m3u8 found : " + args[1]);
                    document.url = args[1];
                    document.langs = [];
                    document.baseurl = document.url.substring(0, document.url.lastIndexOf('/') + 1);
                    document.m3u8found = true;
                    getpagecontent(m3u8loaded, document.url);
                }
            }
            // hook setRequestHeader on this instance
            var origSetReqHeader = this.setRequestHeader.bind(this);
            this.setRequestHeader = function(header, value) {
                if (header.toLowerCase() === 'authorization'
                    && value.indexOf('Bearer ') === 0
                    && args.length >= 2
                    && args[1].indexOf('disney.api.edge.bamgrid.com') > -1
                    && document.disneyAuthToken !== value) {
                    document.disneyAuthToken = value;
                    console.log("Disney auth token captured (length: " + value.length + ")");
                }
                origSetReqHeader(header, value);
            };
            open.call(this,...args);
        }

        var newSend = function(...args) {
            var xhrUrl = this._dsnpUrl || "";

            // capture auth token from Disney API requests
            if (xhrUrl.indexOf("disney.api.edge.bamgrid.com") > -1) {
                var headerValue = this.getRequestHeader && this.getRequestHeader("authorization");
                // getRequestHeader may not exist on all browsers, so also try the
                // getAllResponseHeaders fallback after the request completes.
                // instead, we hook setRequestHeader on this instance
            }
            if (args[0] && args[0].match && args[0].match(/globalization/)) {
                this.addEventListener('readystatechange', function(e) {
                    try {
                        document.globalization = JSON.parse(e.target.response).data.globalization;
                    } catch(e) {}
                }, false);
            }
            // intercept browse page API responses to grab release year
            this.addEventListener('readystatechange', function(e) {
                if (e.target.readyState === 4 && e.target.status === 200 && !document.releaseyear) {
                    try {
                        var text = e.target.responseText;
                        if (text && text.indexOf('releaseYearRange') > -1) {
                            var resp = JSON.parse(text);
                            var year = resp?.data?.page?.visuals?.metastringParts?.releaseYearRange?.startYear;
                            if (year) {
                                document.releaseyear = year;
                                console.log("Release year intercepted: " + year);
                            }
                        }
                    } catch(ex) {}
                }
            }, false);
            send.call(this,...args);
        }

        if (typeof unsafeWindow !== "undefined") {
            debuglog("Window state : unsafe");
            var define = Object.defineProperty;
            define(unsafeWindow.XMLHttpRequest.prototype, "open", {value: exportFunction(newOpen, window)});
            define(unsafeWindow.XMLHttpRequest.prototype, "send", {value: exportFunction(newSend, window)});
        } else {
            debuglog("Window state : safe");
            XMLHttpRequest.prototype.open = newOpen;
            XMLHttpRequest.prototype.send = newSend;
        }
    }

    function fetchYearFromAPI() {
        if (document.fetchingyear || document.releaseyear) return;

        // extract entity ID from /play/UUID
        var match = window.location.pathname.match(/\/play\/([a-f0-9-]+)/i);
        if (!match) {
            document.fetchingyear = false;
            return;
        }

        if (!document.disneyAuthToken) {
            console.log("No auth token yet, will retry");
            document.fetchingyear = false;
            return;
        }

        // the real Disney auth token is ~4000+ chars.
        // short tokens (< 500 chars) are pre-flight tokens and should be filtered.
        if (document.disneyAuthToken.length < 500) {
            debuglog("Waiting for full auth token (current length: "
                     + (document.disneyAuthToken ? document.disneyAuthToken.length : 0) + ")");
            return; // buttonhandle will retry on next interval
        }
        document.fetchingyear = true;

        var entityId = match[1];
        var url = "https://disney.api.edge.bamgrid.com/explore/v1.13/page/entity-" + entityId + "?disableSmartFocus=true&enhancedContainersLimit=15&limit=15";

        console.log("Fetching release year from API: " + url);

        var http = new XMLHttpRequest();
        http.open("GET", url, true);
        http.setRequestHeader("accept", "application/json");
        http.setRequestHeader("authorization", document.disneyAuthToken);
        http.setRequestHeader("x-bamsdk-client-id", "disney-svod-3d9324fc");
        http.setRequestHeader("x-bamsdk-platform", "javascript/windows/chrome");
        http.setRequestHeader("x-dss-edge-accept", "vnd.dss.edge+json; version=2");

        http.onloadend = function() {
            if (http.readyState == 4 && http.status == 200) {
                try {
                    var resp = JSON.parse(http.responseText);
                    var contentTitle = resp?.data?.page?.visuals?.title;
                    var year = resp?.data?.page?.visuals?.metastringParts?.releaseYearRange?.startYear;
                    if (year) {
                        document.releaseyear = year;
                        console.log("Release year from API: " + year);
                    }
                    if (contentTitle) {
                        contentTitle = contentTitle.replaceAll(" Of ", " of ");
                        contentTitle = contentTitle.replaceAll(" The ", " the ");
                        document.filename = contentTitle;
                        console.log("Content title from API: " + contentTitle);
                    }
                } catch(e) {
                    console.log("Failed to parse API response: " + e);
                }
            } else {
                console.log("API request failed: " + http.status);
            }
        };
        http.send();
    }

    function m3u8loaded(response) {
        debuglog("m3u8loaded");
        if (typeof document.m3u8sub !== "undefined") document.m3u8sub(response);
        if (typeof document.m3u8audio !== "undefined") document.m3u8audio(response);
    }

    document.m3u8sub = function(response) {
        var regexpm3u8 =/^#.{0,}GROUP-ID="sub-main".{0,}\.m3u8"$/gm;
        var regexpvtt = /^[\w-_\/]{0,}MAIN[\w-_\/]{0,}.vtt$/gm;
        var regexpvtt2 = /^[\w-_\/]{0,}.vtt$/gm;

        if (response.indexOf('#EXT-X-INDEPENDENT-SEGMENTS') > 0) {
            // sub infos
            var lines = response.match(regexpm3u8);
            lines.forEach(function(line) {
                var lang = linetoarray(line);
                lang.LOCALIZED = document.globalization.timedText.find(t => t.language == lang.LANGUAGE);
                document.langs.push(lang);
                debuglog("Sub found : "+lang.NAME);
            });
        } else if (response.indexOf('.vtt') > 0) {
            debuglog("vtt found");
            var lines = response.match(regexpvtt);
            if (!lines) lines = response.match(regexpvtt2);
            if (lines) {
                lines.forEach(function(line) {
                    var url = document.baseurl;
                    var uri = document.langs[document.langid].URI;
                    url += uri.substring(0, 2);
                    if (line.indexOf("/") < 0) url += uri.substring(2, uri.lastIndexOf("/") + 1);
                    url += line;
                    document.vttlist.push(url);
                });
            } else {
                alert("Unable to parse the m3u8 file, please report a bug for this video.");
            }

            if (document.vttlist.length > 0) {
                getSegments();
            } else {
                alert("Unknown error, please report a bug for this video.");
            }
        }
    }

    function vttloaded(response) {
        debuglog("vttloaded");
        // save segment
        document.segments += response.substring(response.indexOf("-->") - 13);
        document.segid++;
        if (document.segid < document.vttlist.length) {
            getSegments();
        } else if (document.segments.length > 0) {
            // export segments
            exportfile(document.segments);
            document.segments = "";
            document.vttlist = [];
            document.segid = 0;
        } else {
            alert("Unknown error, please report a bug for this video.");
        }
    }

    function linetoarray(line) {
        var result = [];
        var values = line.split(',');
        values.forEach(function(value) {
            var data = value.replace(/\r\n|\r|\n/g,'').split('=');
            if (data.length > 1) {
                var key = data[0];
                var content = data[1].replace(/"/g,'');
                result[key] = content;
            }
        });
        return result;
    }

    function buttonhandle() {
        if (!document.releaseyear && window.location.pathname.indexOf("/play/") > -1) fetchYearFromAPI();
        var buttons = document.getElementsByClassName("control-icon-btn");
        if (buttons.length > 0) {
            if (typeof document.clickhandlesub !== "undefined") document.clickhandlesub();
            if (typeof document.clickhandleaudio !== "undefined") document.clickhandleaudio();
            // movie
            var titleElem = document.getElementsByClassName("title-field")[0];
            if (titleElem && titleElem.innerText && titleElem.innerText.trim().length > 0) document.filename = titleElem.innerText.trim();
            // episode
            var epElem = document.getElementsByClassName("subtitle-field")[0];
            if (epElem && epElem.innerText && epElem.innerText.trim().length > 0) document.episode = epElem.innerText.trim();
            //if (document.getElementsByClassName("subtitle-field").length > 0) document.episode = document.getElementsByClassName("subtitle-field")[0]?.innerText
        }

        if (document.oldlocation != window.location.href && document.oldlocation!=null) {
            // location changed
            document.m3u8found = false;
            document.langs = [];
            document.audios = [];
        }

        document.oldlocation = window.location.href;
    }

    document.clickhandlesub = function() {
        var picker = document.getElementsByClassName("options-picker subtitle-track-picker");
        if (picker && picker[0]) {
            picker[0].childNodes.forEach(function(child) {
                var element = child.childNodes[0];
                if (child.onclick == null) child.onclick = selectsub;
            });
        }
    }

    function selectsub(e) {
        debuglog("selectsub");
        var width = this.offsetWidth;
        // check click position
        if (e.layerX >= width - 30 && e.layerX <= width - 10 && e.layerY >= 5 && e.layerY <= 25) {
            var lang = this.childNodes[0].childNodes[1].innerHTML;
            if (lang == "Off") {
                // download all subs
                debuglog("Download all subs");
                document.zip = new JSZip();
                document.downloadall = true;
                document.downloadid =- 1;
                downloadnext();
            } else {
                // download one sub
                document.downloadall = false;
                download(lang);
            }
            // cancel selection
            return false;
        }
    }

    function downloadnext() {
        document.downloadid++;

        if (document.downloadid < document.langs.length) {
            document.styleSheets[0].addRule('#subtitleTrackPicker > div:first-child:before','padding-right:35px;content:"' + Math.round((document.downloadid / document.langs.length) * 100) + '%";');
            download(document.langs[document.downloadid].NAME,false,false);
        } else {
            debuglog("Subs downloaded");
            clearInterval(document.downloadinterval);
            document.styleSheets[0].addRule('#subtitleTrackPicker > div:first-child:before','padding-right:25px;content:"All";');

            debuglog("Save zip");
            document.zip.generateAsync({type:"blob"}).then(function(content) {
                var output = document.filename;
                if (document.releaseyear) output += "." + document.releaseyear;
                if (document.episode != "") output+= "." + document.episode.replace(':','');
                output += ".DSNP.WEB"
                saveAs(content, output + ".zip");
            });
        }
    }

    function download(langname, withForced = true, localized = true) {
        if (!document.wait) {
            debuglog("Download sub : " + langname);
            var language;
            var count = 0;
            document.forced = false;
            document.langs.forEach(function(lang) {
                if (lang.NAME == langname || (localized && lang.LOCALIZED && Object.values(lang.LOCALIZED.renditions).includes(langname) && lang.FORCED == "NO")) {
                    language = lang.LANGUAGE;
                    document.langid = count;
                    getpagecontent(m3u8loaded,document.baseurl + lang.URI);
                    document.wait = true;
                }
                count++;
            });
            if (withForced) {
                count = 0;
                var subid;
                document.langs.forEach(function(lang) {
                    if (lang.LANGUAGE == language && lang.NAME != langname && lang.FORCED == "YES") {
                        subid=count;
                        document.waitsub = true;
                        document.waitInterval = setInterval(function () {
                            if (!document.wait) {
                                debuglog("Download forced : " + langname);
                                clearInterval(document.waitInterval);
                                document.langid = subid;
                                getpagecontent(m3u8loaded,document.baseurl + lang.URI);
                                document.wait = true;
                            }
                        }, 10);
                    }
                    count++;
                });
            }

            if (count == 0) alert("An error has occurred, please reload the page.");
        }
    }

    function getSegments() {
        debuglog("Downloading all " + document.vttlist.length + " segments in parallel");

        var total = document.vttlist.length;
        var segments = new Array(total);
        var completed = 0;

        document.vttlist.forEach(function(url, index) {
            getpagecontent(function(response) {
                debuglog("Segment " + index + "/" + (total - 1) + " downloaded");
                segments[index] = response.substring(response.indexOf("-->") - 13);
                completed++;

                if (completed === total) {
                    debuglog("All segments downloaded");
                    var merged = segments.join('');
                    if (merged.length > 0) {
                        merged = merged.replace(/WEBVTT\s*STYLE\s*::cue\(\)\s*\{[\s\S]*?\}\s*/g, '');
                        exportfile(merged);
                    } else {
                        alert("Unknown error, please report a bug for this video.");
                    }
                    document.segments = "";
                    document.vttlist = [];
                    document.segid = 0;
                }
            }, url);
        });
    }

    function sanitizeString(input) {
        if (input == null) return '';
        const s = String(input);
        // remove commas and Windows-invalid characters
        let out = s.replace(/[:\\?\/\*"<>\|,]/g, '');
        // replace white space with '.' characters
        out = out.replace(/[ _]+/g, '.');
        // ollapse multiple '.' characters into one
        out = out.replace(/\.{2,}/g, '.');
        out = out.replace(".-.", ".");
        return out;
    }

    function exportfile(text) {
        debuglog("exportfile");
        var output = document.filename;
        if (document.releaseyear) output += "." + document.releaseyear;
        if (document.episode != "") output += "." + document.episode.replace(':','');
        output += ".DSNP.WEB"

        let lang = document.langs[document.langid].LANGUAGE;
        if (lang == "en") lang = "en-US";
        output += "." + lang;
        console.log(document.langs[document.langid]);

        if (document.langs[document.langid].FORCED == "YES") {
            output += "[forced]";
            document.waitsub = false;
        }
        if (document.langs[document.langid].NAME.includes("[CC]")) output += "[sdh]";

        output += ".vtt";
        output = sanitizeString(output);

        if (document.downloadall) {
            debuglog("Add to zip");
            document.zip.file(output, text);
            document.downloadinterval = setTimeout(function () {
                document.wait = false;
                if (!document.waitsub) downloadnext();
            }, 20);
        } else {
            debuglog("Save sub");
            var hiddenElement = document.createElement('a');

            hiddenElement.href = 'data:attachment/text,' + encodeURI(text).replace(/#/g, '%23');
            hiddenElement.target = '_blank';
            hiddenElement.download = output;
            hiddenElement.click();
            setTimeout(function () { document.wait = false; }, 50);
        }
    }

    function getpagecontent(callback,url) {
        debuglog("Downloading : " + url);
        var http = new XMLHttpRequest();
        http.open("GET", url, true);
        http.onloadend = function() {
            if (http.readyState == 4 && http.status == 200) {
                callback(http.responseText);
            } else if (http.status === 404) {
                debuglog("Not found");
                callback("");
            } else {
                debuglog("Unknown error, retrying");
                setTimeout(function () { getpagecontent(callback,url); },100);
            }
        }
        http.send();
    }

    String.prototype.lpad = function(padString, length) {
        var str = this;
        while (str.length < length) {
            str = padString + str;
        }
        return str;
    }

    function debuglog(message) {
        if (debug) console.log("%c [debug] " + message, 'background: #222; color: #bada55');
    }
})(XMLHttpRequest.prototype.open, XMLHttpRequest.prototype.send);

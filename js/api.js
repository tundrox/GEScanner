const GE = {
    // Wiki real-time prices API v2. Average prices (avgHighPrice/avgLowPrice in /5m, /1h, /24h and
    // /timeseries) can have up to two decimals, so round them wherever they're shown.
    BASE: 'https://prices.runescape.wiki/api/v2/osrs',
    WIKI_IMG: 'https://oldschool.runescape.wiki/w/Special:FilePath/',
    WIKI_PAGE: 'https://oldschool.runescape.wiki/w/',
    _cache: {},
    _mapping: null,
    CACHE_TTL: 5 * 60 * 1000,

    // --- SessionStorage persistence layer ---
    _ssGet(key) {
        try {
            const raw = sessionStorage.getItem('ge_' + key);
            if (!raw) return null;
            const p = JSON.parse(raw);
            if (Date.now() - p.t < this.CACHE_TTL) return p.d;
            sessionStorage.removeItem('ge_' + key);
        } catch (e) { /* ignore */ }
        return null;
    },
    _ssSet(key, data) {
        try { sessionStorage.setItem('ge_' + key, JSON.stringify({ d: data, t: Date.now() })); }
        catch (e) { /* quota */ }
    },

    async fetch(endpoint, params = {}, force = false) {
        const url = new URL(this.BASE + endpoint);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        const key = url.toString();

        if (!force) {
            // 1. In-memory cache (fastest)
            const c = this._cache[key];
            if (c && Date.now() - c.t < this.CACHE_TTL) return c.d;

            // 2. SessionStorage cache (survives page nav)
            const ss = this._ssGet(key);
            if (ss) { this._cache[key] = { d: ss, t: Date.now() }; return ss; }
        }

        // 3. Network fetch
        const data = await this._getJson(endpoint, params);
        this._cache[key] = { d: data, t: Date.now() };
        this._ssSet(key, data);
        return data;
    },

    // Plain request with no caching, for responses too big or too many to keep in sessionStorage
    async _getJson(endpoint, params = {}) {
        if (endpoint === '/timeseries') await this._tsSlot();
        const url = new URL(this.BASE + endpoint);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API ${res.status}`);
        return res.json();
    },

    // Timeseries requests go one per item, and bursts make the API answer 502 (with no CORS header, so the
    // browser reports a network error) for about a minute. So each page starts at most TS_RATE a second;
    // cached responses don't count.
    TS_RATE: 5,
    _tsNext: 0,
    _tsSlot() {
        const now = Date.now();
        const at = Math.max(now, this._tsNext);
        this._tsNext = at + 1000 / this.TS_RATE;
        return at > now ? new Promise(r => setTimeout(r, at - now)) : Promise.resolve();
    },

    async getMapping() {
        if (this._mapping) return this._mapping;
        const stored = localStorage.getItem('ge_map_v2');
        if (stored) {
            try {
                const p = JSON.parse(stored);
                if (Date.now() - p.t < 24 * 3600 * 1000) { this._mapping = p.d; return this._mapping; }
            } catch (e) { /* ignore */ }
        }
        // Use preloaded fetch if available (started in <head> before api.js loaded)
        let raw;
        if (window.__gePreload && window.__gePreload.mapping) {
            raw = await window.__gePreload.mapping;
            window.__gePreload.mapping = null; // consume once
        } else {
            raw = await this.fetch('/mapping');
        }
        const map = {};
        raw.forEach(i => map[i.id] = i);
        this._mapping = map;
        try { localStorage.setItem('ge_map_v2', JSON.stringify({ d: map, t: Date.now() })); } catch (e) { /* quota */ }
        return map;
    },

    async getLatest(force = false) {
        // Use preloaded fetch if available (skip when forcing a fresh pull)
        if (!force && window.__gePreload && window.__gePreload.latest) {
            const data = await window.__gePreload.latest;
            window.__gePreload.latest = null;
            const key = this.BASE + '/latest';
            this._cache[key] = { d: data, t: Date.now() };
            this._ssSet(key, data);
            return data;
        }
        return this.fetch('/latest', {}, force);
    },
    async get1h(ts)        { return ts ? this.fetch('/1h', { timestamp: ts }) : this.fetch('/1h'); },
    async get5m(ts)        { return ts ? this.fetch('/5m', { timestamp: ts }) : this.fetch('/5m'); },
    // Trades and average prices for the last full UTC day. The API's plain /24h lags a day
    // behind, so ask for yesterday explicitly and fall back if it isn't published yet.
    // (v2 still serves /24h, though its docs only list /5m and /1h.)
    async getDaily() {
        const today = Math.floor(Date.now() / 86400000) * 86400;
        const y = await this.fetch('/24h', { timestamp: today - 86400 });
        return y.data && Object.keys(y.data).length ? y : this.fetch('/24h');
    },
    // { data: [{ timestamp, avgHighPrice, ... }], timestep, startTimestamp, endTimestamp } for one of
    // the API's lookbacks (see lookbackForDays). Only periods with trades are listed.
    async getTimeseries(id, lookback, force = false) {
        // Use preloaded timeseries if available (item page only; skip when forcing)
        const pre = window.__gePreload;
        if (!force && pre && pre.timeseries && pre.lookback === lookback) {
            const data = await pre.timeseries;
            pre.timeseries = null;
            const url = new URL(this.BASE + '/timeseries');
            url.searchParams.set('id', id);
            url.searchParams.set('lookback', lookback);
            const key = url.toString();
            this._cache[key] = { d: data, t: Date.now() };
            this._ssSet(key, data);
            return data;
        }
        return this.fetch('/timeseries', { id, lookback }, force);
    },

    iconUrl(item) {
        if (!item || !item.id) return '';
        return 'icons/' + item.id + '.png';
    },

    wikiIconUrl(item) {
        if (!item || !item.icon) return '';
        return this.WIKI_IMG + item.icon.replace(/ /g, '_');
    },

    // Link to the item's OSRS Wiki page (spaces become underscores).
    // Useful for checking supply sources — shops, alt currencies, drop rates.
    wikiUrl(item) {
        const name = typeof item === 'string' ? item : (item && item.name);
        if (!name) return '';
        return this.WIKI_PAGE + encodeURIComponent(name.replace(/ /g, '_'));
    },

    // Small "w" badge that opens the wiki page in a new tab.
    wikiLink(item, label, extraClass) {
        const url = this.wikiUrl(item);
        if (!url) return '';
        const cls = 'wiki-link' + (extraClass ? ' ' + extraClass : '');
        return `<a href="${url}" class="${cls}" target="_blank" rel="noopener noreferrer" title="View on OSRS Wiki" onclick="event.stopPropagation()">${label || 'w'}</a>`;
    },

    onImgError(el) {
        const letter = el.dataset.letter || '?';
        const w = el.width || 28;
        const h = el.height || 28;
        // If local icon failed, try Wiki CDN as fallback
        if (el.dataset.wikiSrc && !el.dataset.triedWiki) {
            el.dataset.triedWiki = '1';
            el.src = el.dataset.wikiSrc;
            return;
        }
        el.outerHTML = `<span class="item-icon-fallback" style="width:${w}px;height:${h}px">${letter}</span>`;
    },

    imgTag(item, size) {
        size = size || 28;
        const src = this.iconUrl(item);
        const wikiSrc = this.wikiIconUrl(item);
        const letter = item && item.name ? item.name[0] : '?';
        if (!src) return `<span class="item-icon-fallback" style="width:${size}px;height:${size}px">${letter}</span>`;
        return `<img src="${src}" width="${size}" height="${size}" class="item-icon" loading="lazy" data-letter="${letter}" data-wiki-src="${wikiSrc}" onerror="GE.onImgError(this)" alt="">`;
    },

    parseGp(str) {
        if (typeof str === 'number') return str;
        str = String(str).trim().toLowerCase().replace(/,/g, '').replace(/gp$/, '').trim();
        const m = str.match(/^([0-9]*\.?[0-9]+)\s*(bil|b|mil|m|k)?$/);
        if (!m) return parseInt(str) || 0;
        const num = parseFloat(m[1]);
        const suffix = m[2];
        if (suffix === 'b' || suffix === 'bil') return Math.round(num * 1e9);
        if (suffix === 'm' || suffix === 'mil') return Math.round(num * 1e6);
        if (suffix === 'k') return Math.round(num * 1e3);
        return Math.round(num);
    },

    fmtGp(n) {
        if (n == null) return '—';
        if (n < 0) return '-' + this.fmtGp(-n);   // losses abbreviate the same way as gains
        if (n >= 1e9) { const v = n / 1e9; return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'B'; }
        if (n >= 1e6) { const v = n / 1e6; return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'M'; }
        if (n >= 1e3) { const v = n / 1e3; return (v % 1 === 0 ? v.toFixed(0) : v.toFixed(1)) + 'K'; }
        return n.toLocaleString();
    },

    fmtPct(n) {
        if (n == null || isNaN(n)) return '—';
        const sign = n > 0 ? '+' : '';
        return sign + n.toFixed(1) + '%';
    },

    pctClass(n) {
        if (n == null || isNaN(n)) return 'neutral';
        return n > 0 ? 'positive' : n < 0 ? 'negative' : 'neutral';
    },

    // Grand Exchange tax on a sale: 2% of the sell price, rounded down, capped at 5M gp.
    // (Sales under 50 gp round down to 0, so they're effectively exempt.)
    geTax(sellPrice) {
        if (!sellPrice || sellPrice <= 0) return 0;
        return Math.min(Math.floor(sellPrice * 0.02), 5000000);
    },

    navHTML(active) {
        const links = [
            ['index.html', 'Dashboard'],
            ['browse.html', 'Browse'],
            ['scanner.html', 'Scanner'],
            ['tools.html', 'Trading'],
            ['hiscores.html', 'Hiscores'],
            ['calculators.html', 'Calculators']
        ];
        return `<nav class="nav"><div class="nav-inner">
            <a href="index.html" class="nav-logo"><span class="logo-icon">⚔️</span><span>OSRS Hub</span></a>
            <div class="nav-links">${links.map(([h, t]) =>
                `<a href="${h}" class="nav-link${t === active ? ' active' : ''}">${t}</a>`
            ).join('')}</div>
            <div class="nav-search">
                <input type="text" placeholder="Search items..." id="navSearch" autocomplete="off">
                <div class="ac-dropdown" id="acDropdown"></div>
            </div>
        </div></nav>`;
    },

    initAutocomplete() {
        // On phones the nav links scroll sideways — keep the current page's link in view
        const activeLink = document.querySelector('.nav-link.active');
        if (activeLink) activeLink.scrollIntoView({ block: 'nearest', inline: 'center' });

        const input = document.getElementById('navSearch');
        const dropdown = document.getElementById('acDropdown');
        if (!input || !dropdown) return;

        let acIndex = -1;
        let acItems = [];

        const showResults = async (query) => {
            if (query.length < 2) { dropdown.style.display = 'none'; acItems = []; acIndex = -1; return; }
            const mapping = await GE.getMapping();
            const q = query.toLowerCase();
            const matches = Object.values(mapping)
                .filter(m => m.name.toLowerCase().includes(q))
                .sort((a, b) => {
                    const aStart = a.name.toLowerCase().startsWith(q) ? 0 : 1;
                    const bStart = b.name.toLowerCase().startsWith(q) ? 0 : 1;
                    if (aStart !== bStart) return aStart - bStart;
                    return a.name.localeCompare(b.name);
                })
                .slice(0, 8);

            if (!matches.length) {
                dropdown.innerHTML = '<div class="ac-empty">No items found</div>';
                dropdown.style.display = 'block';
                acItems = []; acIndex = -1;
                return;
            }

            acItems = matches;
            acIndex = -1;
            dropdown.innerHTML = matches.map((m, i) => {
                const icon = GE.iconUrl(m);
                const letter = m.name[0];
                const iconHtml = icon
                    ? `<img src="${icon}" width="24" height="24" loading="lazy" data-letter="${letter}" onerror="GE.onImgError(this)" alt="">`
                    : `<span class="item-icon-fallback" style="width:24px;height:24px;font-size:0.7rem">${letter}</span>`;
                const highlighted = m.name.replace(new RegExp('(' + q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'ig'), '<mark>$1</mark>');
                const meta = (m.members ? 'P2P' : 'F2P') + (m.limit ? ' · Lim: ' + GE.fmtGp(m.limit) : '');
                return `<a href="item.html?id=${m.id}" class="ac-item" data-idx="${i}">
                    <span class="ac-icon">${iconHtml}</span>
                    <span class="ac-info"><span class="ac-name">${highlighted}</span><span class="ac-meta">${meta}</span></span>
                </a>`;
            }).join('');
            dropdown.style.display = 'block';
        };

        let debounce = null;
        input.addEventListener('input', () => {
            clearTimeout(debounce);
            debounce = setTimeout(() => showResults(input.value.trim()), 120);
        });

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (acIndex >= 0 && acItems[acIndex]) {
                    location.href = 'item.html?id=' + acItems[acIndex].id;
                } else {
                    location.href = 'browse.html?q=' + encodeURIComponent(input.value);
                }
                e.preventDefault(); return;
            }
            if (e.key === 'Escape') { dropdown.style.display = 'none'; acIndex = -1; return; }
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                const items = dropdown.querySelectorAll('.ac-item');
                if (!items.length) return;
                if (e.key === 'ArrowDown') acIndex = Math.min(acIndex + 1, items.length - 1);
                else acIndex = Math.max(acIndex - 1, -1);
                items.forEach((el, i) => el.classList.toggle('ac-active', i === acIndex));
                if (acIndex >= 0) items[acIndex].scrollIntoView({ block: 'nearest' });
            }
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.nav-search')) dropdown.style.display = 'none';
        });

        input.addEventListener('focus', () => {
            if (input.value.trim().length >= 2) showResults(input.value.trim());
        });
    },

    // Shortest timeseries lookback that covers `days`. Measured steps: 7d hourly, 30d every 6 hours,
    // 6m and 1y daily. A day uses the hourly 7d series too (24h is 5-minute steps, mostly empty for
    // slower items), so 1D and 7D share a request. Keep the item page's <head> preload in step with this.
    lookbackForDays(days) {
        if (days <= 7)   return '7d';
        if (days <= 30)  return '30d';
        if (days <= 180) return '6m';
        return '1y';
    },

    // The points of a timeseries response from its last `days` days. Cut by time, not point count:
    // quiet periods have no points, so a count would reach further back for slow items.
    lastDays(ts, days) {
        const data = (ts && ts.data) || [];
        if (!data.length) return data;
        const cutoff = (ts.endTimestamp || data[data.length - 1].timestamp) - days * 86400;
        return data.filter(p => p.timestamp >= cutoff);
    },

    // --- Price history for the highs/lows views (dashboard Price Extremes, Browse Highs/Lows) ---
    // A year of daily average buy prices for the items that really trade, kept in localStorage so every tab
    // and both pages share it. Daily prices only change once a day, so a browser fetches each item's history
    // once (~260 requests at GE.TS_RATE a second, saved as it goes, so leaving the page mid-scan loses
    // nothing); after that a new UTC day costs one /24h snapshot (every item at once) plus a timeseries
    // request for the few items that newly qualify.
    // Stored as { day, partial, retryAt, s: { id: [price per day, oldest first, 0 = no trades] } },
    // where `day` is the timestamp of the last entry. Prices are rounded to whole gp, which keeps the
    // store small and matches what the v1 API returned.
    HL_KEY: 'ge_highlow_v3',
    HL_DAYS: 365,                  // length of the API's 1y timeseries (daily)
    HL_TOP_GP: 150,                // the items with the most gp traded yesterday...
    HL_TOP_VOL: 50,                // ...plus the most units traded
    HL_MIN_VOL: 24,                // ~one trade an hour, or a daily average is just a few odd trades
    HL_RARE_PRICE: 10000000,       // ...plus anything worth 10M+ that trades at all (rare, expensive items)
    HL_BATCH: 5,                   // timeseries requests in flight at once (GE.TS_RATE paces them)
    HL_RETRY: 2 * 60 * 1000,       // wait after a failed request before trying again
    HL_RECHECK: 15 * 60 * 1000,    // wait after finding yesterday isn't published yet

    // { id: [[timestamp_sec, avgHighPrice], ...] } for every candidate with 30+ days of trades, the shape
    // GE.windowExtreme takes. onProgress(done, total) follows the per-item requests when there are any.
    getHighLowHistory(onProgress) {
        // One load at a time: switching views mid-scan waits for the scan already running
        if (!this._hlPending) this._hlPending = this._hlGet(onProgress).finally(() => { this._hlPending = null; });
        return this._hlPending;
    },

    async _hlGet(onProgress) {
        const DAY = 86400;
        const latestDay = Math.floor(Date.now() / 1000 / DAY) * DAY - DAY;   // yesterday 00:00 UTC, the newest full day
        let store = this._hlLoad();
        const stale = !store || store.day < latestDay || store.partial;
        if (stale && !(store && Date.now() < store.retryAt)) {
            try {
                store = await this._hlRefresh(store, latestDay, onProgress);
            } catch (e) {
                store = this._hlLoad();
                if (!store) throw e;
                store.retryAt = Date.now() + this.HL_RETRY;     // keep showing the older data; try again later
                this._hlSave(store);
            }
        }
        const start = store.day - (this.HL_DAYS - 1) * DAY;
        const out = {};
        Object.keys(store.s).forEach(id => {
            const pts = [];
            store.s[id].forEach((p, k) => { if (p) pts.push([start + k * DAY, p]); });
            if (pts.length >= 30) out[id] = pts;
        });
        return out;
    },

    async _hlRefresh(store, latestDay, onProgress) {
        const DAY = 86400;
        // Newest published daily snapshot (same request and cache as the Trading page's GE.getDaily)
        let day = latestDay;
        let snap = (await this.fetch('/24h', { timestamp: day })).data || {};
        if (!Object.keys(snap).length) {
            day -= DAY;                         // yesterday isn't published yet
            if (store && store.day === day && !store.partial) {
                store.retryAt = Date.now() + this.HL_RECHECK;
                this._hlSave(store);
                return store;
            }
            snap = (await this.fetch('/24h', { timestamp: day })).data || {};
            if (!Object.keys(snap).length) throw new Error('No daily prices published');
        }
        if (store && (store.day > day || day - store.day > 7 * DAY)) store = null;    // too far behind: start over

        // Bring stored items up to date from the daily snapshots
        const snaps = { [day]: snap };
        const series = {};
        if (store) {
            for (let t = store.day + DAY; t < day; t += DAY) snaps[t] = (await this._getJson('/24h', { timestamp: t })).data || {};
            const shift = (day - store.day) / DAY;
            Object.keys(store.s).forEach(id => {
                const s = store.s[id].slice(shift);
                for (let t = store.day + DAY; t <= day; t += DAY) s.push(this._hlPrice(snaps[t], id));
                series[id] = s;
            });
        }

        // Fetch a year of history for candidates we don't have yet, a few at a time
        const ids = this._hlCandidates(snap, await this.getMapping(), series);
        const missing = ids.filter(id => !series[id]);
        const start = day - (this.HL_DAYS - 1) * DAY;
        const save = (partial, retryAt) => {
            const s = {};
            ids.forEach(id => { if (series[id]) s[id] = series[id]; });
            store = { day, partial, retryAt, s };
            this._hlSave(store);
        };
        const BATCH = this.HL_BATCH;
        let failed = false;
        for (let i = 0; i < missing.length && !failed; i += BATCH) {
            const batch = missing.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(id =>
                this._getJson('/timeseries', { id, lookback: '1y' }).catch(() => null)));
            results.forEach((ts, k) => {
                if (!ts) { failed = true; return; }    // likely rate-limited: stop, keep what we have, retry later
                const id = batch[k];
                const s = new Array(this.HL_DAYS).fill(0);
                (ts.data || []).forEach(p => {
                    const n = Math.round((p.timestamp - start) / DAY);
                    if (n >= 0 && n < this.HL_DAYS && p.avgHighPrice) s[n] = Math.round(p.avgHighPrice);
                });
                // A timeseries can trail the snapshots by a day; fill the gap from them
                Object.keys(snaps).forEach(t => { const n = (t - start) / DAY; if (!s[n]) s[n] = this._hlPrice(snaps[t], id); });
                series[id] = s;
            });
            if (onProgress) onProgress(Math.min(i + BATCH, missing.length), missing.length);
            if (!failed && i + BATCH < missing.length) save(true, 0);   // progress so far; the next page carries on
        }
        save(failed, failed ? Date.now() + this.HL_RETRY : 0);
        return store;
    },

    // Items with real trading on the snapshot's day: top by gp traded, plus top by units traded,
    // plus every 10M+ item that traded at all. 10M+ items already stored stay through days without
    // a trade, so rare items aren't dropped and re-downloaded every time they have a quiet day.
    _hlCandidates(snap, mapping, stored) {
        const rows = [];
        const ids = new Set();
        Object.keys(snap).forEach(id => {
            const d = snap[id];
            if (!mapping[id]) return;
            const price = d.avgHighPrice || d.avgLowPrice || 0;
            const vol = (d.highPriceVolume || 0) + (d.lowPriceVolume || 0);
            if (price >= 200 && vol >= this.HL_MIN_VOL) rows.push({ id, gp: price * vol, vol });
            if (price >= this.HL_RARE_PRICE && vol > 0) ids.add(id);
        });
        rows.sort((a, b) => b.gp - a.gp).slice(0, this.HL_TOP_GP).forEach(r => ids.add(r.id));
        rows.sort((a, b) => b.vol - a.vol).slice(0, this.HL_TOP_VOL).forEach(r => ids.add(r.id));
        Object.keys(stored || {}).forEach(id => {
            const s = stored[id];
            let last = 0;
            for (let k = s.length - 1; k >= 0 && !last; k--) last = s[k];
            if (last >= this.HL_RARE_PRICE && mapping[id]) ids.add(id);
        });
        return [...ids];
    },
    _hlPrice(snap, id) { return Math.round((snap[id] && snap[id].avgHighPrice) || 0); },
    _hlLoad() {
        try { return JSON.parse(localStorage.getItem(this.HL_KEY)); } catch (e) { return null; }
    },
    _hlSave(store) {
        try { localStorage.setItem(this.HL_KEY, JSON.stringify(store)); } catch (e) { /* quota */ }
    },

    // Highest/lowest avgHighPrice (and when) within the last `periodDays` of a point series.
    // pts: [[timestamp_sec, price], ...].  Returns null if no valid point in the window.
    windowExtreme(pts, periodDays, nowSec) {
        const cutoff = nowSec - periodDays * 86400;
        let hi = -Infinity, lo = Infinity, hiT = 0, loT = 0;
        for (let k = 0; k < pts.length; k++) {
            const t = pts[k][0], p = pts[k][1];
            if (!p || t < cutoff) continue;
            if (p >= hi) { hi = p; hiT = t; }
            if (p <= lo) { lo = p; loT = t; }
        }
        if (hi === -Infinity) return null;
        return { hi, lo, hiT, loT };
    },

    // --- Preload common data on every page ---
    _preloaded: null,
    preload() {
        if (!this._preloaded) {
            this._preloaded = Promise.all([
                this.getMapping(),
                this.getLatest()
            ]);
        }
        return this._preloaded;
    }
};

// Start preloading immediately when api.js loads
GE.preload();

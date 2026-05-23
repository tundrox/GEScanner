const GE = {
    BASE: 'https://prices.runescape.wiki/api/v1/osrs',
    WIKI_IMG: 'https://oldschool.runescape.wiki/w/Special:FilePath/',
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

    async fetch(endpoint, params = {}) {
        const url = new URL(this.BASE + endpoint);
        Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
        const key = url.toString();

        // 1. In-memory cache (fastest)
        const c = this._cache[key];
        if (c && Date.now() - c.t < this.CACHE_TTL) return c.d;

        // 2. SessionStorage cache (survives page nav)
        const ss = this._ssGet(key);
        if (ss) { this._cache[key] = { d: ss, t: Date.now() }; return ss; }

        // 3. Network fetch
        const res = await fetch(url);
        if (!res.ok) throw new Error(`API ${res.status}`);
        const data = await res.json();
        this._cache[key] = { d: data, t: Date.now() };
        this._ssSet(key, data);
        return data;
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

    async getLatest() {
        // Use preloaded fetch if available
        if (window.__gePreload && window.__gePreload.latest) {
            const data = await window.__gePreload.latest;
            window.__gePreload.latest = null;
            const key = this.BASE + '/latest';
            this._cache[key] = { d: data, t: Date.now() };
            this._ssSet(key, data);
            return data;
        }
        return this.fetch('/latest');
    },
    async get1h(ts)        { return ts ? this.fetch('/1h', { timestamp: ts }) : this.fetch('/1h'); },
    async get5m(ts)        { return ts ? this.fetch('/5m', { timestamp: ts }) : this.fetch('/5m'); },
    async getTimeseries(id, timestep) {
        // Use preloaded timeseries if available (item page only)
        if (window.__gePreload && window.__gePreload.timeseries) {
            const data = await window.__gePreload.timeseries;
            window.__gePreload.timeseries = null;
            const url = new URL(this.BASE + '/timeseries');
            url.searchParams.set('id', id);
            url.searchParams.set('timestep', timestep);
            const key = url.toString();
            this._cache[key] = { d: data, t: Date.now() };
            this._ssSet(key, data);
            return data;
        }
        return this.fetch('/timeseries', { id, timestep });
    },

    iconUrl(item) {
        if (!item || !item.id) return '';
        return 'icons/' + item.id + '.png';
    },

    wikiIconUrl(item) {
        if (!item || !item.icon) return '';
        return this.WIKI_IMG + item.icon.replace(/ /g, '_');
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

    navHTML(active) {
        const links = [
            ['index.html', 'Dashboard'],
            ['browse.html', 'Browse'],
            ['scanner.html', 'Scanner']
        ];
        return `<nav class="nav"><div class="nav-inner">
            <a href="index.html" class="nav-logo"><span class="logo-icon">⚔️</span><span>GE Scanner</span></a>
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

    timestepForDays(days) {
        if (days <= 15)  return '1h';
        if (days <= 90)  return '6h';
        return '24h';
    },

    pointsForDays(days, timestep) {
        const hoursPerStep = { '1h': 1, '6h': 6, '24h': 24 };
        return Math.min(365, Math.ceil((days * 24) / hoursPerStep[timestep]));
    },

    // --- 52-week scan cache (survives page navigation) ---
    save52WeekCache(data) {
        try {
            sessionStorage.setItem('ge_52week', JSON.stringify({ d: data, t: Date.now() }));
        } catch (e) { /* quota */ }
    },
    load52WeekCache() {
        try {
            const raw = sessionStorage.getItem('ge_52week');
            if (!raw) return null;
            const p = JSON.parse(raw);
            // 52-week data valid for 15 minutes
            if (Date.now() - p.t < 15 * 60 * 1000) return p.d;
            sessionStorage.removeItem('ge_52week');
        } catch (e) { /* ignore */ }
        return null;
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

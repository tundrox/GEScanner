// Skills, XP table and Wise Old Man client — shared by the Hiscores and Calculators pages.
// Jagex's hiscores endpoint sends no CORS headers, so a static site can't read it directly;
// Wise Old Man mirrors the same data with CORS open. Requires api.js (for GE._ssGet/_ssSet).
const OSRS = {
    WOM_API: 'https://api.wiseoldman.net/v2',
    WOM_SITE: 'https://wiseoldman.net/players/',

    // [Wise Old Man metric, display name] in official hiscores order
    SKILLS: [
        ['attack', 'Attack'], ['defence', 'Defence'], ['strength', 'Strength'], ['hitpoints', 'Hitpoints'],
        ['ranged', 'Ranged'], ['prayer', 'Prayer'], ['magic', 'Magic'], ['cooking', 'Cooking'],
        ['woodcutting', 'Woodcutting'], ['fletching', 'Fletching'], ['fishing', 'Fishing'], ['firemaking', 'Firemaking'],
        ['crafting', 'Crafting'], ['smithing', 'Smithing'], ['mining', 'Mining'], ['herblore', 'Herblore'],
        ['agility', 'Agility'], ['thieving', 'Thieving'], ['slayer', 'Slayer'], ['farming', 'Farming'],
        ['runecrafting', 'Runecrafting'], ['hunter', 'Hunter'], ['construction', 'Construction'], ['sailing', 'Sailing']
    ],

    // In-game skill tab layout, read row by row (3 columns)
    TAB_ORDER: [
        'attack', 'hitpoints', 'mining',
        'strength', 'agility', 'smithing',
        'defence', 'herblore', 'fishing',
        'ranged', 'thieving', 'cooking',
        'prayer', 'crafting', 'firemaking',
        'magic', 'fletching', 'woodcutting',
        'runecrafting', 'slayer', 'farming',
        'construction', 'hunter', 'sailing'
    ],

    // Trained by killing monsters rather than by recipe-style actions
    MONSTER_SKILLS: ['attack', 'strength', 'defence', 'hitpoints', 'ranged', 'slayer'],

    MAX_XP: 200000000,
    MAX_LEVEL: 126,

    skillName(key) {
        const s = this.SKILLS.find(([k]) => k === key);
        return s ? s[1] : key;
    },

    iconUrl(key) { return 'icons/skills/' + key + '.png'; },

    // "chambers_of_xeric_challenge_mode" -> "Chambers of Xeric Challenge Mode"
    metricName(key) {
        return key.split('_')
            .map((w, i) => i && ['of', 'the', 'and'].includes(w) ? w : w[0].toUpperCase() + w.slice(1))
            .join(' ');
    },

    // --- XP table (index = level) ---
    _xpTable: null,
    xpTable() {
        if (this._xpTable) return this._xpTable;
        const t = [0, 0];
        let points = 0;
        for (let lvl = 1; lvl < this.MAX_LEVEL; lvl++) {
            points += Math.floor(lvl + 300 * Math.pow(2, lvl / 7));
            t[lvl + 1] = Math.floor(points / 4);
        }
        return (this._xpTable = t);
    },
    xpForLevel(level) {
        return this.xpTable()[Math.max(1, Math.min(this.MAX_LEVEL, Math.floor(level)))];
    },
    // Virtual levels past 99 by default; pass max = 99 for the real level
    levelForXp(xp, max) {
        const t = this.xpTable();
        const cap = max || this.MAX_LEVEL;
        let lvl = 1;
        while (lvl < cap && t[lvl + 1] <= xp) lvl++;
        return lvl;
    },
    // Fraction of the way from the current level to the next (1 at max)
    levelProgress(xp) {
        const lvl = this.levelForXp(xp);
        if (lvl >= this.MAX_LEVEL) return 1;
        const lo = this.xpForLevel(lvl), hi = this.xpForLevel(lvl + 1);
        return (xp - lo) / (hi - lo);
    },

    // --- Wise Old Man client ---
    validRsn(name) { return /^[a-zA-Z0-9 _-]{1,12}$/.test(String(name).trim()); },
    _key(rsn) { return encodeURIComponent(String(rsn).trim().toLowerCase()); },

    async _wom(path, opts) {
        const res = await fetch(this.WOM_API + path, opts);
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            const err = new Error(body.message || 'Wise Old Man returned ' + res.status);
            err.status = res.status;
            err.code = body.code;
            throw err;
        }
        return body;
    },

    // Latest stats. The first lookup of a player WOM doesn't know yet starts tracking them.
    async getPlayer(rsn) {
        const cacheKey = 'wom_player_' + this._key(rsn);
        const cached = GE._ssGet(cacheKey);
        if (cached) return cached;
        let player;
        try { player = await this._wom('/players/' + this._key(rsn)); }
        catch (e) {
            if (e.status !== 404) throw e;
            return this.updatePlayer(rsn);
        }
        // WOM keeps a stats-less stub for names it once failed to find on the hiscores
        if (!player.latestSnapshot) return this.updatePlayer(rsn);
        GE._ssSet(cacheKey, player);
        return player;
    },

    // Pull fresh stats from the official hiscores. WOM allows one update per player per minute;
    // inside that window the stored stats are already current, so fall back to reading them.
    async updatePlayer(rsn) {
        let player;
        try { player = await this._wom('/players/' + this._key(rsn), { method: 'POST' }); }
        catch (e) {
            if (e.code !== 'PLAYER_IS_RATE_LIMITED') throw e;
            player = await this._wom('/players/' + this._key(rsn));
        }
        if (!player.latestSnapshot) {
            const err = new Error('Player not found on the hiscores');
            err.code = 'HISCORES_USERNAME_NOT_FOUND';
            throw err;
        }
        GE._ssSet('wom_player_' + this._key(rsn), player);
        return player;
    },

    // period: day | week | month | year
    async getGains(rsn, period) {
        const cacheKey = 'wom_gains_' + period + '_' + this._key(rsn);
        const cached = GE._ssGet(cacheKey);
        if (cached) return cached;
        const gains = await this._wom(`/players/${this._key(rsn)}/gained?period=${period}`);
        GE._ssSet(cacheKey, gains);
        return gains;
    },

    clearGainsCache(rsn) {
        for (const p of ['day', 'week', 'month', 'year']) {
            try { sessionStorage.removeItem('ge_wom_gains_' + p + '_' + this._key(rsn)); } catch (e) { /* ignore */ }
        }
    },

    errorText(e) {
        switch (e.code) {
            case 'INVALID_USERNAME': return 'That isn\'t a valid RuneScape name (1–12 letters, numbers, spaces, - or _).';
            case 'HISCORES_USERNAME_NOT_FOUND': return 'Player not found on the official hiscores. New or low-level accounts may not be ranked yet.';
            case 'PLAYER_NOT_FOUND': return 'Player not found.';
        }
        if (e.status === 429) return 'Too many lookups — Wise Old Man allows about 20 a minute. Try again shortly.';
        if (e.status >= 500 || e.status === 503) return 'The hiscores are unavailable right now (Jagex or Wise Old Man may be down).';
        return e.message || 'Lookup failed.';
    },

    // "3m ago", "2h ago", "4d ago"
    timeAgo(iso) {
        const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
        if (s < 60) return 'just now';
        if (s < 3600) return Math.floor(s / 60) + 'm ago';
        if (s < 86400) return Math.floor(s / 3600) + 'h ago';
        return Math.floor(s / 86400) + 'd ago';
    }
};

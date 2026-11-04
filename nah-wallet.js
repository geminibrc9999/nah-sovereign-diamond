// ============================================================================
// NAH-WALLET.JS: ZERO-DEPENDENCY BITCOIN & RUNES COLD/COOL ENGINE (v26.0)
// Design Philosophy: Forever Immutable + Zero-Keyboard + Zero-String RAM
// Standards: BIP-39 (SHA-256 Locked), BIP-32, BIP-84 (bc1q), BIP-86 (bc1p),
//            BIP-143, BIP-340 (Self-Verified Schnorr), BIP-341, Runes (6a5d),
//            PBKDF2-SHA256 (600,000 rounds) + AES-256-GCM + 5-Try Auto-Wipe.
// ============================================================================

(function () {
    "use strict";

    const webBtcApi = window.crypto;
    const SELF_SCRIPT_URL = (document.currentScript && document.currentScript.src) ? document.currentScript.src : "nah-wallet.js";

    function assertWebBtcSubtleReady() {
        if (!webBtcApi || !webBtcApi.subtle || typeof webBtcApi.getRandomValues !== "function") {
            throw new Error("Secure Context Required: Hardware WebCrypto API is unavailable. Please open this wallet over HTTPS (or localhost).");
        }
    }

    function discoverScriptUrl(filename, defaultFallback) {
        const scripts = document.querySelectorAll("script[src]");
        for (let i = 0; i < scripts.length; i++) {
            const src = scripts[i].getAttribute("src") || "";
            if (src.includes(filename)) return scripts[i].src || src;
        }
        return defaultFallback;
    }

    function discoverStyleUrl(filename, defaultFallback) {
        const links = document.querySelectorAll("link[rel='stylesheet'][href]");
        for (let i = 0; i < links.length; i++) {
            const href = links[i].getAttribute("href") || "";
            if (href.includes(filename)) return links[i].href || href;
        }
        return defaultFallback;
    }

    // --- 1. SECP256K1 MATHEMATICAL CONSTANTS & MODULAR ARITHMETIC ---
    const P = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2Fn;
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const HALF_N = N >> 1n;
    const GX = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
    const GY = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
    const OFFICIAL_BIP39_SHA256 = "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda";

    // NAH•SOVEREIGN•DIAMOND Rune ID & Supply Constants (946855:118)
    const NAH_RUNE_BLOCK = 946855n;
    const NAH_RUNE_TX = 118n;
    const MAX_NAH_SUPPLY = 85300000000000n;
    const MIN_SAFE_PACKET_SATS = 546n;
    const MIN_EXTERNAL_SAT_SATS = 600;           // Protects all 330-sat & 546-sat Rune/Ordinal UTXOs
    const MIN_BTC_CHANGE_SATS = 600n;            // Change outputs >= 600 sats remain spendable after reload
    const MAX_SAFE_MINER_FEE_SATS = 50000n;
    const PBKDF2_ROUNDS_V26 = 600000;
    const VAULT_AAD_BASE = "NAH-SOVEREIGN-VAULT-V6-PBKDF2-600000";
    const VAULT_AAD_TAPROOT_ONLY = "NAH-SOVEREIGN-VAULT-V6-PBKDF2-600000-TAPROOT";
    const MAX_UNLOCK_FAILURES = 5;               // Strict 5-try self-destruct guard
    const SESSION_IDLE_MS = 15 * 60 * 1000;      // 15m wall-clock idle limit
    const BACKGROUND_LOCK_MS = 3 * 60 * 1000;    // 3m hidden/screen-lock limit
    const GUARD_STORAGE_KEY = "nah_sovereign_guard_v6";
    const VAULT_STORAGE_KEY = "nah_sovereign_aes_vault_v1";

    const HUMAN_ENTROPY_POOL = new Uint8Array(64);
    let humanEntropyScore = 0;
    let entropyTapCounter = 0;
    let offlineWordlistReady = false;
    let isBtcBusy = false;
    let ramUnlockFailures = 0;
    let ramLockoutUntil = 0;

    const SESSION_SPENT_OUTPOINTS = new Set();
    const SESSION_GENERATED_NAH_UTXOS = new Map();
    const SESSION_GENERATED_SAT_UTXOS = new Map();
    const CACHED_FILE_HASHES = new Map();

    function mod(a, b = P) { const r = a % b; return r >= 0n ? r : b + r; }

    function modInv(a, m = P) {
        let [old_r, r] = [mod(a, m), m];
        if (old_r === 0n) throw new Error("Modular inverse of zero does not exist");
        let [old_s, s] = [1n, 0n];
        while (r !== 0n) {
            const q = old_r / r;
            [old_r, r] = [r, old_r - q * r];
            [old_s, s] = [s, old_s - q * s];
        }
        return mod(old_s, m);
    }

    function pointAdd(p1, p2) {
        if (!p1) return p2;
        if (!p2) return p1;
        const [x1, y1] = p1, [x2, y2] = p2;
        if (x1 === x2) {
            if (y1 !== y2 || y1 === 0n) return null;
            const lam = mod(3n * x1 * x1 * modInv(2n * y1));
            const x3 = mod(lam * lam - 2n * x1);
            const y3 = mod(lam * (x1 - x3) - y1);
            return [x3, y3];
        }
        const lam = mod((y2 - y1) * modInv(x2 - x1));
        const x3 = mod(lam * lam - x1 - x2);
        const y3 = mod(lam * (x1 - x3) - y1);
        return [x3, y3];
    }

    function pointMul(k, p = [GX, GY]) {
        let n = mod(k, N);
        if (n === 0n) return null;
        let res = null, addend = p;
        while (n > 0n) {
            if (n & 1n) res = pointAdd(res, addend);
            addend = pointAdd(addend, addend);
            n >>= 1n;
        }
        return res;
    }

    function bytesToBigInt(b) {
        let h = "0x";
        for (let i = 0; i < b.length; i++) h += b[i].toString(16).padStart(2, "0");
        return h === "0x" ? 0n : BigInt(h);
    }

    function bigIntTo32Bytes(num) {
        const hex = mod(num, 1n << 256n).toString(16).padStart(64, "0");
        const out = new Uint8Array(32);
        for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return out;
    }

    function bytesToHex(b) {
        return Array.from(b).map(x => x.toString(16).padStart(2, "0")).join("");
    }

    function hexToBytes(h) {
        const clean = String(h || "").trim().replace(/^0x/, "");
        if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) {
            throw new Error("Invalid hex string");
        }
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        return out;
    }

    function concatBytes(...arrays) {
        const total = arrays.reduce((acc, a) => acc + a.length, 0);
        const res = new Uint8Array(total);
        let off = 0;
        for (const a of arrays) { res.set(a, off); off += a.length; }
        return res;
    }

    function zeroize(...buffers) {
        for (const b of buffers) {
            if (b && typeof b.fill === "function") b.fill(0);
        }
    }

    function constantTimeEqual(strA, strB) {
        const a = String(strA || "");
        const b = String(strB || "");
        const len = Math.max(a.length, b.length);
        let diff = a.length ^ b.length;
        for (let i = 0; i < len; i++) {
            const ca = i < a.length ? a.charCodeAt(i) : 0;
            const cb = i < b.length ? b.charCodeAt(i) : 0;
            diff |= (ca ^ cb);
        }
        return diff === 0;
    }

    // Unbiased CSPRNG Integer Generator (Rejection Sampling eliminates Modulo Bias)
    function csprngRandomInt(maxExclusive) {
        assertWebBtcSubtleReady();
        const max = Math.floor(Number(maxExclusive));
        if (max <= 1) return 0;
        const limit = 0x100000000 - (0x100000000 % max);
        const buf = new Uint32Array(1);
        while (true) {
            webBtcApi.getRandomValues(buf);
            if (buf[0] < limit) return buf[0] % max;
        }
    }

    // --- 2. SANITIZERS, CANONICAL UTXO NORMALIZER & STORAGE HELPERS ---
    function escapeHtml(str) {
        return String(str || "")
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function sanitizeSeedInputString(rawStr) {
        return String(rawStr || "")
            .normalize("NFKD")
            .toLowerCase()
            .replace(/[^a-z\s]/g, " ");
    }

    function normalizePasswordString(rawPwd) {
        return String(rawPwd || "").normalize("NFC");
    }

    function parseStrictNahAmount(rawInput) {
        const cleaned = String(rawInput || "").replace(/[\s,_]/g, "");
        if (!/^\d+$/.test(cleaned) || cleaned.length > 14) return null;
        const val = BigInt(cleaned);
        return (val > 0n && val <= MAX_NAH_SUPPLY) ? val : null;
    }

    function parseStrictSatAmount(rawInput) {
        const cleaned = String(rawInput || "").replace(/[\s,_]/g, "");
        if (!/^\d+$/.test(cleaned) || cleaned.length > 15) return null;
        const val = BigInt(cleaned);
        return (val >= MIN_SAFE_PACKET_SATS && val <= 2100000000000000n) ? val : null;
    }

    // Forever Immutable Fee Rate Sanitizer (0.1 to 500 sat/vB, supports comma or dot decimals)
    function sanitizeFeeRate(rawRate) {
        const norm = typeof rawRate === "string" ? rawRate.replace(/,/g, ".").trim() : rawRate;
        const n = Number(norm);
        return (Number.isFinite(n) && n > 0) ? Math.min(500, Math.max(0.1, n)) : 1;
    }

    function isValidVaultObject(v) {
        if (!v || typeof v !== "object") return false;
        const ver = Number(v.v);
        const iters = Number(v.iterations);
        return Boolean(
            ver === 6 &&
            Number.isInteger(iters) && iters >= 100000 && iters <= 10000000 &&
            typeof v.salt === "string" && /^[0-9a-f]{32,128}$/i.test(v.salt) &&
            typeof v.iv === "string" && /^[0-9a-f]{24,32}$/i.test(v.iv) &&
            typeof v.ct === "string" && /^[0-9a-f]{32,}$/i.test(v.ct)
        );
    }

    async function saveAndVerifyVaultStorage(vaultObj) {
        try {
            if (navigator.storage && navigator.storage.persist) {
                await navigator.storage.persist().catch(() => {});
            }
            const serialized = JSON.stringify(vaultObj);
            localStorage.setItem(VAULT_STORAGE_KEY, serialized);
            return localStorage.getItem(VAULT_STORAGE_KEY) === serialized;
        } catch (e) {
            return false;
        }
    }

    function normalizeUtxoOutpoint(u) {
        if (!u) return null;
        let txid = u.txid;
        let vout = u.vout;
        if ((!txid || vout === undefined || vout === null) && typeof u.outpoint === "string" && u.outpoint.includes(":")) {
            const parts = u.outpoint.trim().split(":");
            txid = parts[0];
            vout = Number(parts[1]);
        }
        const cleanTxid = String(txid || "").trim().toLowerCase();
        const cleanVout = Number(vout);
        if (!/^[0-9a-f]{64}$/.test(cleanTxid) || !Number.isInteger(cleanVout) || cleanVout < 0) {
            return null;
        }
        return {
            ...u,
            txid: cleanTxid,
            vout: cleanVout,
            outpoint: `${cleanTxid}:${cleanVout}`
        };
    }

    function clearSessionUtxoLocks() {
        SESSION_SPENT_OUTPOINTS.clear();
        SESSION_GENERATED_NAH_UTXOS.clear();
        SESSION_GENERATED_SAT_UTXOS.clear();
    }

    function recordBroadcastedTxUtxoChanges(address, spentInputs, newNahOutputs, newBtcChangeUtxoOrList) {
        for (const inp of (spentInputs || [])) {
            const norm = normalizeUtxoOutpoint(inp);
            if (norm) SESSION_SPENT_OUTPOINTS.add(norm.outpoint);
        }

        const existingNah = (SESSION_GENERATED_NAH_UTXOS.get(address) || []).filter(
            u => !SESSION_SPENT_OUTPOINTS.has(u.outpoint)
        );
        const addedNah = [];
        if (Array.isArray(newNahOutputs) && newNahOutputs.length > 0) {
            for (const nh of newNahOutputs) {
                const normNh = normalizeUtxoOutpoint(nh);
                const cleanAmt = Math.min(Number(MAX_NAH_SUPPLY), Math.max(0, Math.floor(Number(nh && nh.nah) || 0)));
                if (normNh && cleanAmt > 0 && !SESSION_SPENT_OUTPOINTS.has(normNh.outpoint)) {
                    addedNah.push({
                        txid: normNh.txid,
                        vout: normNh.vout,
                        outpoint: normNh.outpoint,
                        nah: cleanAmt,
                        sats: Math.max(Number(MIN_SAFE_PACKET_SATS), Math.floor(Number(nh.sats) || Number(MIN_SAFE_PACKET_SATS))),
                        isPendingSplit: true
                    });
                }
            }
        }
        const combinedNah = [...addedNah, ...existingNah];
        if (combinedNah.length > 0) {
            SESSION_GENERATED_NAH_UTXOS.set(address, combinedNah);
        } else {
            SESSION_GENERATED_NAH_UTXOS.delete(address);
        }

        const existingSat = (SESSION_GENERATED_SAT_UTXOS.get(address) || []).filter(
            u => !SESSION_SPENT_OUTPOINTS.has(u.outpoint)
        );
        const changeCandidates = Array.isArray(newBtcChangeUtxoOrList)
            ? newBtcChangeUtxoOrList
            : (newBtcChangeUtxoOrList ? [newBtcChangeUtxoOrList] : []);

        for (const cand of changeCandidates) {
            if (cand && Number(cand.value) >= Number(MIN_BTC_CHANGE_SATS)) {
                const normChange = normalizeUtxoOutpoint(cand);
                if (normChange && !SESSION_SPENT_OUTPOINTS.has(normChange.outpoint)) {
                    existingSat.push({
                        txid: normChange.txid,
                        vout: normChange.vout,
                        outpoint: normChange.outpoint,
                        value: Math.floor(Number(cand.value)),
                        isSessionChange: true,
                        status: { confirmed: false }
                    });
                }
            }
        }
        if (existingSat.length > 0) {
            SESSION_GENERATED_SAT_UTXOS.set(address, existingSat);
        } else {
            SESSION_GENERATED_SAT_UTXOS.delete(address);
        }
    }

    function hydrateVaultUtxos(address, rawMempoolUtxos, rawNahUtxos, nahSyncedHeight = null) {
        const mempoolSatsByOutpoint = new Map();
        const confirmedMempoolOutpoints = new Set();
        const normalizedMempoolList = [];
        const rawHeight = Math.max(0, Math.floor(Number(nahSyncedHeight) || 0));
        const syncedBlockNum = (rawHeight > Number(NAH_RUNE_BLOCK) && Number.isSafeInteger(rawHeight)) ? rawHeight : 0;

        for (const rawU of (rawMempoolUtxos || [])) {
            const norm = normalizeUtxoOutpoint(rawU);
            if (!norm) continue;
            const val = Math.max(0, Math.floor(Number(rawU.value) || 0));
            if (val > 0) mempoolSatsByOutpoint.set(norm.outpoint, val);
            const utxoBlock = Number((rawU.status && rawU.status.block_height) || 0);
            if (rawU.status && rawU.status.confirmed && (syncedBlockNum === 0 || utxoBlock <= syncedBlockNum)) {
                confirmedMempoolOutpoints.add(norm.outpoint);
            }
            normalizedMempoolList.push({ ...norm, value: val, status: rawU.status || {} });
        }

        const nahOutpointSet = new Set();
        const indexedNahList = [];

        for (const rawNah of (rawNahUtxos || [])) {
            const norm = normalizeUtxoOutpoint(rawNah);
            if (!norm) continue;
            const cleanNahAmt = Math.min(Number(MAX_NAH_SUPPLY), Math.max(0, Math.floor(Number(rawNah.nah) || 0)));
            if (cleanNahAmt <= 0) continue;
            nahOutpointSet.add(norm.outpoint);
            if (SESSION_SPENT_OUTPOINTS.has(norm.outpoint)) continue;
            const isConfirmingInMempool = !confirmedMempoolOutpoints.has(norm.outpoint);
            const exactOnChainSats = mempoolSatsByOutpoint.get(norm.outpoint) || Math.max(546, Math.floor(Number(rawNah.sats) || 546));
            indexedNahList.push({
                ...norm,
                nah: cleanNahAmt,
                sats: exactOnChainSats,
                isConfirmingInMempool
            });
        }

        const pendingSessionNah = [];
        for (const pNh of (SESSION_GENERATED_NAH_UTXOS.get(address) || [])) {
            if (SESSION_SPENT_OUTPOINTS.has(pNh.outpoint)) continue;
            if (nahOutpointSet.has(pNh.outpoint)) continue;
            nahOutpointSet.add(pNh.outpoint);
            pendingSessionNah.push(pNh);
        }
        if (pendingSessionNah.length > 0) {
            SESSION_GENERATED_NAH_UTXOS.set(address, pendingSessionNah);
        } else {
            SESSION_GENERATED_NAH_UTXOS.delete(address);
        }

        const nahUtxos = [...pendingSessionNah, ...indexedNahList];
        const seenSatOutpoints = new Set();
        const cardinalUtxos = [];

        const activeSessionSat = [];
        for (const sc of (SESSION_GENERATED_SAT_UTXOS.get(address) || [])) {
            if (SESSION_SPENT_OUTPOINTS.has(sc.outpoint) || nahOutpointSet.has(sc.outpoint)) continue;
            if (confirmedMempoolOutpoints.has(sc.outpoint)) continue;
            const cleanVal = Math.max(0, Math.floor(Number(sc.value) || 0));
            if (cleanVal < Number(MIN_BTC_CHANGE_SATS)) continue;
            const cleanSc = { ...sc, value: cleanVal };
            seenSatOutpoints.add(cleanSc.outpoint);
            activeSessionSat.push(cleanSc);
            cardinalUtxos.push(cleanSc);
        }
        if (activeSessionSat.length > 0) {
            SESSION_GENERATED_SAT_UTXOS.set(address, activeSessionSat);
        } else {
            SESSION_GENERATED_SAT_UTXOS.delete(address);
        }

        let unconfirmedSatSats = 0;

        for (const mu of normalizedMempoolList) {
            const isConfirmed = Boolean(mu.status && mu.status.confirmed);
            const utxoBlock = Number((mu.status && mu.status.block_height) || 0);
            if (seenSatOutpoints.has(mu.outpoint)) continue;
            if (SESSION_SPENT_OUTPOINTS.has(mu.outpoint)) continue;
            if (nahOutpointSet.has(mu.outpoint)) continue;
            if (mu.value < MIN_EXTERNAL_SAT_SATS) continue;
            if (!isConfirmed || (syncedBlockNum > 0 && utxoBlock > syncedBlockNum)) {
                unconfirmedSatSats += mu.value;
                continue;
            }
            seenSatOutpoints.add(mu.outpoint);
            cardinalUtxos.push(mu);
        }

        cardinalUtxos.sort((a, b) => (a.value || 0) - (b.value || 0));
        const nahBalance = nahUtxos.reduce((acc, u) => acc + (u.nah || 0), 0);
        const cardinalSats = cardinalUtxos.reduce((acc, u) => acc + (u.value || 0), 0);

        return { nahUtxos, nahBalance, cardinalUtxos, cardinalSats, unconfirmedSatSats };
    }

    // --- 3. HASH FUNCTIONS (SHA-256, DOUBLE-SHA256, HMAC-SHA256/512, RIPEMD-160) ---
    async function sha256(bytes) {
        assertWebBtcSubtleReady();
        const hash = await webBtcApi.subtle.digest("SHA-256", bytes);
        return new Uint8Array(hash);
    }

    async function sha256d(bytes) {
        return await sha256(await sha256(bytes));
    }

    async function hmacSha256(keyBytes, dataBytes) {
        assertWebBtcSubtleReady();
        const k = await webBtcApi.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await webBtcApi.subtle.sign("HMAC", k, dataBytes);
        return new Uint8Array(sig);
    }

    async function hmacSha512(keyBytes, dataBytes) {
        assertWebBtcSubtleReady();
        const k = await webBtcApi.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
        const sig = await webBtcApi.subtle.sign("HMAC", k, dataBytes);
        return new Uint8Array(sig);
    }

    async function taggedHash(tag, msgBytes) {
        const tagBytes = new TextEncoder().encode(tag);
        const tagHash = await sha256(tagBytes);
        return await sha256(concatBytes(tagHash, tagHash, msgBytes));
    }

    function ripemd160(msg) {
        const zl = [0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,7,4,13,1,10,6,15,3,12,0,9,5,2,14,11,8,3,10,14,4,9,15,8,1,2,7,0,6,13,11,5,12,1,9,11,10,0,8,12,4,13,3,7,15,14,5,6,2,4,0,5,9,7,12,2,10,14,1,3,8,11,6,15,13];
        const zr = [5,14,7,0,9,2,11,4,13,6,15,8,1,10,3,12,6,11,3,7,0,13,5,10,14,15,8,12,4,9,1,2,15,5,1,3,7,14,6,9,11,8,12,2,10,0,4,13,8,6,4,1,3,11,15,0,5,12,2,13,9,7,10,14,12,15,10,4,1,5,8,7,6,2,13,14,0,3,9,11];
        const sl = [11,14,15,12,5,8,7,9,11,13,14,15,6,7,9,8,7,6,8,13,11,9,7,15,7,12,15,9,11,7,13,12,11,13,6,7,14,9,13,15,14,8,13,6,5,12,7,5,11,12,14,15,14,15,9,8,9,14,5,6,8,6,5,12,9,15,5,11,6,8,13,12,5,12,13,14,11,8,5,6];
        const sr = [8,9,9,11,13,15,15,5,7,7,8,11,14,14,12,6,9,13,15,7,12,8,9,11,7,7,12,7,6,15,13,11,9,7,15,11,8,6,6,14,12,13,5,14,13,13,7,5,15,5,8,11,14,14,6,14,6,9,12,9,12,5,15,8,8,5,12,9,12,5,14,6,8,13,6,5,15,13,11,11];
        const kl = [0x00000000, 0x5A827999, 0x6ED9EBA1, 0x8F1BBCDC, 0xA953FD4E];
        const kr = [0x50A28BE6, 0x5C4DD124, 0x6D703EF3, 0x7A6D76E9, 0x00000000];
        const rol = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
        const f = (j, x, y, z) => {
            if (j < 16) return (x ^ y ^ z) >>> 0;
            if (j < 32) return ((x & y) | (~x & z)) >>> 0;
            if (j < 48) return ((x | ~y) ^ z) >>> 0;
            if (j < 64) return ((x & z) | (y & ~z)) >>> 0;
            return (x ^ (y | ~z)) >>> 0;
        };
        const len = msg.length;
        const bitLen = len * 8;
        const padLen = ((len + 8) >>> 6 << 6) + 64;
        const buf = new Uint8Array(padLen);
        buf.set(msg);
        buf[len] = 0x80;
        const dv = new DataView(buf.buffer);
        dv.setUint32(padLen - 8, bitLen >>> 0, true);
        dv.setUint32(padLen - 4, Math.floor(bitLen / 0x100000000), true);
        let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
        const X = new Uint32Array(16);
        for (let i = 0; i < padLen; i += 64) {
            for (let j = 0; j < 16; j++) X[j] = dv.getUint32(i + j * 4, true);
            let al = h0, bl = h1, cl = h2, dl = h3, el = h4;
            let ar = h0, br = h1, cr = h2, dr = h3, er = h4;
            for (let j = 0; j < 80; j++) {
                const r = j >> 4;
                let t = (al + f(j, bl, cl, dl) + X[zl[j]] + kl[r]) >>> 0;
                t = (rol(t, sl[j]) + el) >>> 0;
                al = el; el = dl; dl = rol(cl, 10); cl = bl; bl = t;
                t = (ar + f(79 - j, br, cr, dr) + X[zr[j]] + kr[r]) >>> 0;
                t = (rol(t, sr[j]) + er) >>> 0;
                ar = er; er = dr; dr = rol(cr, 10); cr = br; br = t;
            }
            const t = (h1 + cl + dr) >>> 0;
            h1 = (h2 + dl + er) >>> 0;
            h2 = (h3 + el + ar) >>> 0;
            h3 = (h4 + al + br) >>> 0;
            h4 = (h0 + bl + cr) >>> 0;
            h0 = t;
        }
        const out = new Uint8Array(20);
        const odv = new DataView(out.buffer);
        odv.setUint32(0, h0, true); odv.setUint32(4, h1, true); odv.setUint32(8, h2, true);
        odv.setUint32(12, h3, true); odv.setUint32(16, h4, true);
        return out;
    }

    // --- 4. ZERO-KEYBOARD CSPRNG + COMMUTATIVE XOR HMAC-SHA512 ENTROPY EXTRACTOR ---
    async function feedHumanEntropy(inputStr = "") {
        assertWebBtcSubtleReady();
        const tapId = ++entropyTapCounter;
        const hwNoise = new Uint8Array(32);
        webBtcApi.getRandomValues(hwNoise);
        const timeBuf = new TextEncoder().encode(
            String(inputStr || "") + "|" + tapId + "|" + Date.now() + "|" + performance.now()
        );
        const poolSnapshot = new Uint8Array(HUMAN_ENTROPY_POOL);
        const mixed = await hmacSha512(poolSnapshot, concatBytes(hwNoise, timeBuf));
        for (let i = 0; i < 64; i++) {
            HUMAN_ENTROPY_POOL[i] ^= mixed[i];
        }
        zeroize(hwNoise, timeBuf, poolSnapshot, mixed);
        humanEntropyScore = Math.min(100, humanEntropyScore + 10);
        return humanEntropyScore;
    }

    function getHumanEntropyProgress() {
        return humanEntropyScore;
    }

    function resetHumanEntropyPool() {
        HUMAN_ENTROPY_POOL.fill(0);
        if (webBtcApi && typeof webBtcApi.getRandomValues === "function") {
            webBtcApi.getRandomValues(HUMAN_ENTROPY_POOL);
        }
        humanEntropyScore = 0;
        entropyTapCounter = 0;
    }
    resetHumanEntropyPool();

    // --- 5. BECH32 & BECH32M ENCODER / DECODER / SCRIPT_PUBKEY CONVERTER ---
    const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    function bech32Polymod(values) {
        const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
        let chk = 1;
        for (let p = 0; p < values.length; ++p) {
            const top = chk >> 25;
            chk = ((chk & 0x1ffffff) << 5) ^ values[p];
            for (let i = 0; i < 5; ++i) if ((top >> i) & 1) chk ^= GEN[i];
        }
        return chk;
    }

    function convertBits(data, fromBits, toBits, pad) {
        let acc = 0, bits = 0;
        const ret = [], maxv = (1 << toBits) - 1;
        for (let p = 0; p < data.length; ++p) {
            if (data[p] < 0 || (data[p] >> fromBits) !== 0) return null;
            acc = (acc << fromBits) | data[p];
            bits += fromBits;
            while (bits >= toBits) {
                bits -= toBits;
                ret.push((acc >> bits) & maxv);
            }
        }
        if (pad) {
            if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
        } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
            return null;
        }
        return ret;
    }

    function encodeBech32(hrp, witnessVer, witnessProg) {
        const isBech32m = witnessVer > 0;
        const CONST = isBech32m ? 0x2bc830a3 : 1;
        const words = [witnessVer, ...convertBits(witnessProg, 8, 5, true)];
        const hrpExp = [];
        for (let i = 0; i < hrp.length; ++i) hrpExp.push(hrp.charCodeAt(i) >> 5);
        hrpExp.push(0);
        for (let i = 0; i < hrp.length; ++i) hrpExp.push(hrp.charCodeAt(i) & 31);
        const modVal = bech32Polymod([...hrpExp, ...words, 0, 0, 0, 0, 0, 0]) ^ CONST;
        const chk = [];
        for (let p = 0; p < 6; ++p) chk.push((modVal >> (5 * (5 - p))) & 31);
        return hrp + "1" + [...words, ...chk].map(d => CHARSET[d]).join("");
    }

    function decodeBech32Address(addr) {
        if (!addr || typeof addr !== "string") return null;
        const clean = addr.trim();
        if (!clean || (clean !== clean.toLowerCase() && clean !== clean.toUpperCase())) return null;
        const low = clean.toLowerCase();
        if (!low.startsWith("bc1")) return null;
        const dataPart = low.slice(3);
        if (dataPart.length < 6 || dataPart.length > 90) return null;
        const words = [];
        for (let i = 0; i < dataPart.length; i++) {
            const idx = CHARSET.indexOf(dataPart[i]);
            if (idx === -1) return null;
            words.push(idx);
        }
        const hrpExp = [3, 3, 0, 2, 3];
        const ver = words[0];
        if (ver > 16) return null;
        const expectedConst = ver === 0 ? 1 : 0x2bc830a3;
        if (bech32Polymod([...hrpExp, ...words]) !== expectedConst) return null;
        const prog = convertBits(words.slice(1, -6), 5, 8, false);
        if (!prog || prog.length < 2 || prog.length > 40) return null;
        if (ver === 0 && prog.length !== 20 && prog.length !== 32) return null;
        if (ver === 1 && prog.length !== 32) return null;
        return { version: ver, program: new Uint8Array(prog) };
    }

    function isValidBitcoinAddress(addr) {
        return decodeBech32Address(addr) !== null;
    }

    function addressToScriptPubKey(addr) {
        const dec = decodeBech32Address(addr);
        if (!dec) throw new Error("Invalid Bitcoin Bech32/Bech32m address: " + addr);
        const opVer = dec.version === 0 ? 0x00 : (0x50 + dec.version);
        return concatBytes(new Uint8Array([opVer, dec.program.length]), dec.program);
    }

    // --- 6. SHA-256 PINNED & FROZEN BIP-39 WORDLIST + PREDICTIVE DEAD-KEY MATCHER ---
    let WORDLIST = null;
    let wordlistLoadPromise = null;
    const WORDLIST_MIRRORS = [
        "https://raw.githubusercontent.com/bitcoin/bips/master/bip-0039/english.txt",
        "https://cdn.jsdelivr.net/gh/bitcoin/bips@master/bip-0039/english.txt"
    ];

    async function getVerifiedWordlist() {
        if (WORDLIST && WORDLIST.length === 2048) {
            offlineWordlistReady = true;
            return WORDLIST;
        }
        if (wordlistLoadPromise) return await wordlistLoadPromise;

        wordlistLoadPromise = (async () => {
            let rawText = null;
            try { rawText = localStorage.getItem("nah_bip39_verified_wordlist_v1"); } catch (e) {}

            if (rawText) {
                const normCached = rawText.replace(/\r\n/g, "\n").trim() + "\n";
                const cachedHash = bytesToHex(await sha256(new TextEncoder().encode(normCached)));
                if (cachedHash === OFFICIAL_BIP39_SHA256) {
                    WORDLIST = Object.freeze(normCached.trim().split("\n"));
                    offlineWordlistReady = true;
                    return WORDLIST;
                }
            }

            for (const url of WORDLIST_MIRRORS) {
                try {
                    const res = await fetch(url);
                    if (!res.ok) continue;
                    const txt = await res.text();
                    const normalized = txt.replace(/\r\n/g, "\n").trim() + "\n";
                    const digest = await sha256(new TextEncoder().encode(normalized));
                    if (bytesToHex(digest) === OFFICIAL_BIP39_SHA256) {
                        try { localStorage.setItem("nah_bip39_verified_wordlist_v1", normalized); } catch (e) {}
                        WORDLIST = Object.freeze(normalized.trim().split("\n"));
                        offlineWordlistReady = true;
                        return WORDLIST;
                    }
                } catch (e) {}
            }
            throw new Error("Unable to load BIP-39 dictionary. Please connect to the internet once before turning on Airplane Mode.");
        })();

        try {
            return await wordlistLoadPromise;
        } finally {
            wordlistLoadPromise = null;
        }
    }

    function isOfflineReady() {
        return offlineWordlistReady && Array.isArray(WORDLIST) && WORDLIST.length === 2048;
    }

    function matchBip39WordsByPrefix(rawPrefix, maxResults = 10) {
        if (!Array.isArray(WORDLIST) || WORDLIST.length !== 2048) return [];
        const clean = String(rawPrefix || "").toLowerCase().replace(/[^a-z]/g, "");
        if (!clean) return [];
        const out = [];
        for (let i = 0; i < WORDLIST.length; i++) {
            if (WORDLIST[i].startsWith(clean)) {
                out.push(WORDLIST[i]);
                if (out.length >= maxResults) break;
            }
        }
        return out;
    }

    function getValidNextBip39Letters(rawPrefix) {
        if (!Array.isArray(WORDLIST) || WORDLIST.length !== 2048) {
            return "abcdefghijklmnopqrstuvwxyz".split("");
        }
        const clean = String(rawPrefix || "").toLowerCase().replace(/[^a-z]/g, "");
        if (!clean) {
            return "abcdefghijklmnopqrstuvwxyz".split("");
        }
        const nextSet = new Set();
        const pLen = clean.length;
        for (let i = 0; i < WORDLIST.length; i++) {
            const w = WORDLIST[i];
            if (w.length > pLen && w.startsWith(clean)) {
                nextSet.add(w[pLen]);
            }
        }
        return Array.from(nextSet);
    }

    // --- 7. PASSWORD STRENGTH SHIELD (WITH LENGTH & EDGE-SPACE DETECTOR) ---
    function evaluatePasswordStrength(pwd) {
        const s = normalizePasswordString(pwd);
        if (s.length > 128) {
            return { valid: false, score: 1, label: "Too Long (Max 128 chars)", color: "#e76f51", hint: "Password must not exceed 128 characters." };
        }
        const spaceWarn = (s.length > 0 && s !== s.trim()) ? " ⚠️ Note: Password starts or ends with a space!" : "";
        if (s.length < 8) {
            return { valid: false, score: 1, label: "Too Short (Min 8 chars)", color: "#e76f51", hint: "Please use at least 8 characters to protect your wallet." + spaceWarn };
        }
        if (/^(.)\1+$/.test(s) || /^(01234567|12345678|123456789|87654321|password|qwertyui|bitcoin1)/i.test(s)) {
            return { valid: false, score: 1, label: "Too Common / Unsafe", color: "#e76f51", hint: "Avoid simple sequences like 12345678 or repeated characters." + spaceWarn };
        }
        let variety = 0;
        if (/[a-z]/.test(s)) variety++;
        if (/[A-Z]/.test(s)) variety++;
        if (/[0-9]/.test(s)) variety++;
        if (/[^a-zA-Z0-9]/.test(s)) variety++;

        if (s.length >= 12 && variety >= 3) {
            return { valid: true, score: 3, label: "🛡️ Strong Fortress Password", color: "#2a9d8f", hint: "Protected by 600,000 rounds of PBKDF2-SHA256 + AES-256-GCM." + spaceWarn };
        }
        return { valid: true, score: 2, label: "✓ Good Password", color: "#f4a261", hint: "Valid password (tip: 12+ characters with numbers/symbols is even stronger)." + spaceWarn };
    }

    // --- 8. ZERO-LEAK SEED GENERATION & ZERO-KEYBOARD 3-WORD TOUCH QUIZ ---
    let PENDING_SEED_WORDS = null;
    let PENDING_QUIZ_INDICES = [1, 5, 10];

    function clearPendingSeed() {
        if (Array.isArray(PENDING_SEED_WORDS)) {
            PENDING_SEED_WORDS.fill("");
            PENDING_SEED_WORDS = null;
        }
    }

    // Excludes all 12 words of the user's paper seed from distractors so only 1 button per row is on the user's paper
    function buildShuffledQuizOptionsForWord(correctWord) {
        const pool = (Array.isArray(WORDLIST) && WORDLIST.length === 2048) ? WORDLIST : [];
        const userWords = Array.isArray(PENDING_SEED_WORDS) ? PENDING_SEED_WORDS : [];
        const choices = [correctWord];
        while (choices.length < 4 && pool.length === 2048) {
            const cand = pool[csprngRandomInt(2048)];
            if (!choices.includes(cand) && !userWords.includes(cand)) {
                choices.push(cand);
            }
        }
        for (let i = choices.length - 1; i > 0; i--) {
            const j = csprngRandomInt(i + 1);
            const tmp = choices[i];
            choices[i] = choices[j];
            choices[j] = tmp;
        }
        return choices;
    }

    function rollFreshSeedQuizChallenge() {
        assertWebBtcSubtleReady();
        if (!PENDING_SEED_WORDS || PENDING_SEED_WORDS.length !== 12) {
            throw new Error("No active 12-word seed in memory. Please generate a fresh seed.");
        }
        const idx1 = csprngRandomInt(4);          // Word #1 to #4
        const idx2 = 4 + csprngRandomInt(4);      // Word #5 to #8
        const idx3 = 8 + csprngRandomInt(4);      // Word #9 to #12
        PENDING_QUIZ_INDICES = [idx1, idx2, idx3];

        const w1 = PENDING_SEED_WORDS[idx1];
        const w2 = PENDING_SEED_WORDS[idx2];
        const w3 = PENDING_SEED_WORDS[idx3];

        return {
            firstWordNumber: idx1 + 1,
            secondWordNumber: idx2 + 1,
            thirdWordNumber: idx3 + 1,
            options1: buildShuffledQuizOptionsForWord(w1),
            options2: buildShuffledQuizOptionsForWord(w2),
            options3: buildShuffledQuizOptionsForWord(w3)
        };
    }

    async function generateMnemonic12() {
        assertWebBtcSubtleReady();
        if (humanEntropyScore < 100) {
            throw new Error("Please complete Step 2 (tap 🎲 ROLL DICE 10 times until 100% MIXED) before generating your 12 words.");
        }
        const words = await getVerifiedWordlist();
        const hwRand = new Uint8Array(32);
        webBtcApi.getRandomValues(hwRand);
        const hmacDigest = await hmacSha512(HUMAN_ENTROPY_POOL, hwRand);
        const entropy = hmacDigest.slice(0, 16);

        const hash = await sha256(entropy);
        let bits = "";
        for (let i = 0; i < 16; i++) bits += entropy[i].toString(2).padStart(8, "0");
        bits += hash[0].toString(2).padStart(8, "0").slice(0, 4);
        zeroize(hwRand, hmacDigest, entropy, hash);

        const outWords = [];
        for (let i = 0; i < 12; i++) {
            const idx = parseInt(bits.slice(i * 11, (i + 1) * 11), 2);
            outWords.push(words[idx]);
        }
        PENDING_SEED_WORDS = outWords.slice();
        refreshSessionTimeout();
        const quiz = rollFreshSeedQuizChallenge();

        return {
            wordsList: outWords.slice(),
            quiz
        };
    }

    function getPendingWordsForPeek() {
        if (!PENDING_SEED_WORDS || PENDING_SEED_WORDS.length !== 12) return null;
        refreshSessionTimeout();
        return PENDING_SEED_WORDS.slice();
    }

    function verifyPendingSeedQuizDetailed(word1Input, word2Input, word3Input) {
        if (!PENDING_SEED_WORDS || PENDING_SEED_WORDS.length !== 12) {
            return { passed: false, wrongBoxes: [1, 2, 3], message: "No active seed phrase found. Please generate a fresh 12-word seed." };
        }
        const w1 = sanitizeSeedInputString(word1Input).trim();
        const w2 = sanitizeSeedInputString(word2Input).trim();
        const w3 = sanitizeSeedInputString(word3Input).trim();

        const ok1 = constantTimeEqual(w1, PENDING_SEED_WORDS[PENDING_QUIZ_INDICES[0]]);
        const ok2 = constantTimeEqual(w2, PENDING_SEED_WORDS[PENDING_QUIZ_INDICES[1]]);
        const ok3 = constantTimeEqual(w3, PENDING_SEED_WORDS[PENDING_QUIZ_INDICES[2]]);

        const wrongBoxes = [];
        const wrongLabels = [];
        if (!ok1) { wrongBoxes.push(1); wrongLabels.push("Word #" + (PENDING_QUIZ_INDICES[0] + 1)); }
        if (!ok2) { wrongBoxes.push(2); wrongLabels.push("Word #" + (PENDING_QUIZ_INDICES[1] + 1)); }
        if (!ok3) { wrongBoxes.push(3); wrongLabels.push("Word #" + (PENDING_QUIZ_INDICES[2] + 1)); }

        if (wrongBoxes.length === 0) {
            return { passed: true, wrongBoxes: [], message: "✓ All 3 words verified!" };
        }
        return {
            passed: false,
            wrongBoxes,
            message: `⚠️ ${wrongLabels.join(" & ")} did not match your written paper backup. A fresh 3-word challenge has been rolled — please check your paper!`
        };
    }

    function verifyPendingSeedQuiz(word1Input, word2Input, word3Input) {
        return verifyPendingSeedQuizDetailed(word1Input, word2Input, word3Input).passed;
    }

    async function validateMnemonic(phrase) {
        const words = await getVerifiedWordlist();
        const list = sanitizeSeedInputString(phrase).trim().split(/\s+/);
        if (list.length !== 12 && list.length !== 24) return false;
        let bits = "";
        for (const w of list) {
            const idx = words.indexOf(w);
            if (idx === -1) return false;
            bits += idx.toString(2).padStart(11, "0");
        }
        const entBits = (list.length * 11 * 32) / 33;
        const csBits = list.length * 11 - entBits;
        const entBytes = new Uint8Array(entBits / 8);
        for (let i = 0; i < entBytes.length; i++) {
            entBytes[i] = parseInt(bits.slice(i * 8, (i + 1) * 8), 2);
        }
        const hash = await sha256(entBytes);
        const hashBits = hash[0].toString(2).padStart(8, "0").slice(0, csBits);
        zeroize(entBytes, hash);
        return bits.slice(entBits) === hashBits;
    }

    // Zero-String RAM BIP-39 Seed Derivation (Operates directly on UTF-8 Uint8Array bytes)
    async function mnemonicBytesToSeed(utf8PhraseBytes, passphrase = "") {
        assertWebBtcSubtleReady();
        const normPass = String(passphrase || "").normalize("NFKD");
        const enc = new TextEncoder();
        const keyMat = await webBtcApi.subtle.importKey("raw", utf8PhraseBytes, "PBKDF2", false, ["deriveBits"]);
        const salt = enc.encode("mnemonic" + normPass);
        const bits = await webBtcApi.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 2048, hash: "SHA-512" }, keyMat, 512);
        return new Uint8Array(bits);
    }

    async function mnemonicToSeed(phrase, passphrase = "") {
        const normPhrase = sanitizeSeedInputString(phrase).trim().split(/\s+/).join(" ");
        const rawBytes = new TextEncoder().encode(normPhrase);
        try {
            return await mnemonicBytesToSeed(rawBytes, passphrase);
        } finally {
            zeroize(rawBytes);
        }
    }

    // --- 9. BIP-32 HD DERIVATION & HARDENED BIP-86 (TAPROOT) / BIP-84 (SEGWIT) ENGINE ---
    function compressedPubkey(privBytes) {
        const d = bytesToBigInt(privBytes);
        const [x, y] = pointMul(d);
        const prefix = (y & 1n) ? 0x03 : 0x02;
        return concatBytes(new Uint8Array([prefix]), bigIntTo32Bytes(x));
    }

    async function deriveChild(priv, chainCode, index) {
        const idxBuf = new Uint8Array(4);
        new DataView(idxBuf.buffer).setUint32(0, index >>> 0, false);
        const data = (index >= 0x80000000)
            ? concatBytes(new Uint8Array([0x00]), priv, idxBuf)
            : concatBytes(compressedPubkey(priv), idxBuf);
        const I = await hmacSha512(chainCode, data);
        zeroize(data);
        const IL = bytesToBigInt(I.slice(0, 32));
        if (IL >= N) throw new Error("Invalid BIP-32 child key IL >= N");
        const childPriv = mod(IL + bytesToBigInt(priv), N);
        if (childPriv === 0n) throw new Error("Invalid BIP-32 child key == 0");
        const outPriv = bigIntTo32Bytes(childPriv);
        const outChain = I.slice(32);
        zeroize(I);
        return { priv: outPriv, chainCode: outChain };
    }

    async function derivePath(seed, pathIndices) {
        const I = await hmacSha512(new TextEncoder().encode("Bitcoin seed"), seed);
        let node = { priv: I.slice(0, 32), chainCode: I.slice(32) };
        zeroize(I);
        for (const idx of pathIndices) {
            const nextNode = await deriveChild(node.priv, node.chainCode, idx);
            zeroize(node.priv, node.chainCode);
            node = nextNode;
        }
        zeroize(node.chainCode);
        return node.priv;
    }

    async function derivePublicAccountsFromSeed(seed, taprootOnly = false) {
        const H = 0x80000000;
        let privTaproot = null, privSegwit = null;
        try {
            privTaproot = await derivePath(seed, [86 + H, 0 + H, 0 + H, 0, 0]);
            const dTap = bytesToBigInt(privTaproot);
            const [px, py] = pointMul(dTap);
            const internalXOnly = bigIntTo32Bytes(px);
            const tweakBytes = await taggedHash("TapTweak", internalXOnly);
            const t = bytesToBigInt(tweakBytes);
            if (t >= N) throw new Error("Invalid TapTweak >= N");
            const tweakedPt = pointAdd([px, (py & 1n) === 0n ? py : (P - py)], pointMul(t));
            if (!tweakedPt) throw new Error("Invalid TapTweak: point at infinity");
            const [qx] = tweakedPt;
            const taprootOutputKey = bigIntTo32Bytes(qx);
            const taprootAddr = encodeBech32("bc", 1, taprootOutputKey);

            let segwitObj = null;
            if (!taprootOnly) {
                privSegwit = await derivePath(seed, [84 + H, 0 + H, 0 + H, 0, 0]);
                const pubSegwit = compressedPubkey(privSegwit);
                const shaPub = await sha256(pubSegwit);
                const hash160 = ripemd160(shaPub);
                const segwitAddr = encodeBech32("bc", 0, hash160);
                segwitObj = {
                    type: "NATIVE SEGWIT (BIP-84)",
                    address: segwitAddr,
                    pubkeyHex: bytesToHex(pubSegwit),
                    hash160Hex: bytesToHex(hash160)
                };
            }

            return {
                taprootOnly: Boolean(taprootOnly),
                taproot: {
                    type: "TAPROOT (BIP-86)",
                    address: taprootAddr,
                    pubkeyHex: bytesToHex(internalXOnly),
                    outputPubkeyHex: bytesToHex(taprootOutputKey)
                },
                segwit: segwitObj
            };
        } finally {
            zeroize(seed, privTaproot, privSegwit);
        }
    }

    async function derivePublicAccountsFromBytes(utf8PhraseBytes, taprootOnly = false) {
        const seed = await mnemonicBytesToSeed(utf8PhraseBytes);
        return await derivePublicAccountsFromSeed(seed, taprootOnly);
    }

    async function derivePublicAccountsOnly(phrase, taprootOnly = false) {
        const seed = await mnemonicToSeed(phrase);
        return await derivePublicAccountsFromSeed(seed, taprootOnly);
    }

    // --- 10. WALL-CLOCK SESSION GUARD + 600,000-ROUND PBKDF2 VAULT + 5-TRY AUTO-WIPE ---
    let SESSION_AES_KEY = null;
    let SESSION_VAULT_IV = null;
    let SESSION_VAULT_CT = null;
    let SESSION_VAULT_AAD = null;
    let ACTIVE_ENCRYPTED_VAULT_OBJ = null;
    let SESSION_TIMER = null;
    let SESSION_EXPIRES_AT = 0;
    let TAB_HIDDEN_AT = 0;
    let AUTO_LOCK_CALLBACK = null;

    function getVaultAadBytes(taprootOnly) {
        const label = taprootOnly ? VAULT_AAD_TAPROOT_ONLY : VAULT_AAD_BASE;
        return new TextEncoder().encode(label);
    }

    function getBruteForceGuardState() {
        let storFailures = 0;
        let storLockout = 0;
        try {
            const raw = localStorage.getItem(GUARD_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                storFailures = Math.max(0, Math.floor(Number(parsed.failures) || 0));
                storLockout = Math.max(0, Math.floor(Number(parsed.lockoutUntil) || 0));
            }
        } catch (e) {}
        const failures = Math.max(ramUnlockFailures, storFailures);
        const lockoutUntil = Math.max(ramLockoutUntil, storLockout);
        ramUnlockFailures = failures;
        ramLockoutUntil = lockoutUntil;
        return { failures, lockoutUntil };
    }

    function setBruteForceGuardState(failures, lockoutUntil) {
        const cleanF = Math.max(0, Math.floor(Number(failures) || 0));
        const cleanL = Math.max(0, Math.floor(Number(lockoutUntil) || 0));
        ramUnlockFailures = cleanF;
        ramLockoutUntil = cleanL;
        try {
            if (cleanF === 0 && cleanL === 0) {
                localStorage.removeItem(GUARD_STORAGE_KEY);
            } else {
                localStorage.setItem(GUARD_STORAGE_KEY, JSON.stringify({ failures: cleanF, lockoutUntil: cleanL }));
            }
        } catch (e) {}
    }

    function lockSessionRamKey() {
        SESSION_AES_KEY = null;
        zeroize(SESSION_VAULT_IV, SESSION_VAULT_CT, SESSION_VAULT_AAD);
        SESSION_VAULT_IV = null;
        SESSION_VAULT_CT = null;
        SESSION_VAULT_AAD = null;
        ACTIVE_ENCRYPTED_VAULT_OBJ = null;
        SESSION_EXPIRES_AT = 0;
        TAB_HIDDEN_AT = 0;
        clearPendingSeed();
        if (SESSION_TIMER) { clearTimeout(SESSION_TIMER); SESSION_TIMER = null; }
    }

    function isSessionUnlocked() {
        if (!SESSION_AES_KEY || !SESSION_VAULT_IV || !SESSION_VAULT_CT) return false;
        if (Date.now() > SESSION_EXPIRES_AT) {
            lockSessionRamKey();
            if (typeof AUTO_LOCK_CALLBACK === "function") AUTO_LOCK_CALLBACK();
            return false;
        }
        return true;
    }

    function refreshSessionTimeout(onAutoLockCallback) {
        if (typeof onAutoLockCallback === "function") {
            AUTO_LOCK_CALLBACK = onAutoLockCallback;
        }
        SESSION_EXPIRES_AT = Date.now() + SESSION_IDLE_MS;
        if (SESSION_TIMER) clearTimeout(SESSION_TIMER);
        SESSION_TIMER = setTimeout(() => {
            lockSessionRamKey();
            if (typeof AUTO_LOCK_CALLBACK === "function") AUTO_LOCK_CALLBACK();
        }, SESSION_IDLE_MS);
    }

    document.addEventListener("visibilitychange", () => {
        if (!SESSION_AES_KEY && !PENDING_SEED_WORDS && SESSION_EXPIRES_AT === 0) return;
        if (document.hidden) {
            TAB_HIDDEN_AT = Date.now();
        } else {
            const now = Date.now();
            const sessionExpired = Boolean(SESSION_EXPIRES_AT > 0 && now > SESSION_EXPIRES_AT);
            const bgExpired = Boolean(TAB_HIDDEN_AT > 0 && (now - TAB_HIDDEN_AT) > BACKGROUND_LOCK_MS);
            if (sessionExpired || bgExpired) {
                lockSessionRamKey();
                if (typeof AUTO_LOCK_CALLBACK === "function") AUTO_LOCK_CALLBACK();
            }
            TAB_HIDDEN_AT = 0;
        }
    });

    window.addEventListener("pagehide", () => {
        lockSessionRamKey();
        if (typeof AUTO_LOCK_CALLBACK === "function") AUTO_LOCK_CALLBACK();
    });

    async function encryptSeedBytesWithPassword(plainSeedBytes, password, taprootOnly = false) {
        assertWebBtcSubtleReady();
        const normPwd = normalizePasswordString(password);
        const pwdCheck = evaluatePasswordStrength(normPwd);
        if (!pwdCheck.valid) throw new Error(pwdCheck.label + ": " + pwdCheck.hint);

        const enc = new TextEncoder();
        const salt = webBtcApi.getRandomValues(new Uint8Array(32));
        const iv = webBtcApi.getRandomValues(new Uint8Array(12));
        const pwdBytes = enc.encode(normPwd);
        const aadBytes = getVaultAadBytes(taprootOnly);
        try {
            const baseKey = await webBtcApi.subtle.importKey("raw", pwdBytes, "PBKDF2", false, ["deriveKey"]);
            const aesKey = await webBtcApi.subtle.deriveKey(
                { name: "PBKDF2", salt, iterations: PBKDF2_ROUNDS_V26, hash: "SHA-256" },
                baseKey,
                { name: "AES-GCM", length: 256 },
                false,
                ["encrypt", "decrypt"]
            );
            const cipherBuf = await webBtcApi.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: aadBytes },
                aesKey,
                plainSeedBytes
            );
            const ctBytes = new Uint8Array(cipherBuf);
            SESSION_AES_KEY = aesKey;
            SESSION_VAULT_IV = new Uint8Array(iv);
            SESSION_VAULT_CT = new Uint8Array(ctBytes);
            SESSION_VAULT_AAD = new Uint8Array(aadBytes);
            SESSION_EXPIRES_AT = Date.now() + SESSION_IDLE_MS;
            setBruteForceGuardState(0, 0);
            clearPendingSeed();

            const vaultObj = {
                v: 6,
                kdf: "PBKDF2-SHA256",
                iterations: PBKDF2_ROUNDS_V26,
                cipher: "AES-256-GCM",
                taprootOnly: Boolean(taprootOnly),
                salt: bytesToHex(salt),
                iv: bytesToHex(iv),
                ct: bytesToHex(ctBytes)
            };
            ACTIVE_ENCRYPTED_VAULT_OBJ = vaultObj;
            return vaultObj;
        } finally {
            zeroize(pwdBytes);
        }
    }

    async function encryptSeedWithPassword(mnemonic, password, taprootOnly = false) {
        const cleanPhrase = sanitizeSeedInputString(mnemonic).trim().split(/\s+/).join(" ");
        const plainBytes = new TextEncoder().encode(cleanPhrase);
        try {
            return await encryptSeedBytesWithPassword(plainBytes, password, taprootOnly);
        } finally {
            zeroize(plainBytes);
        }
    }

    // Pure Cold Wallet Finalizer: Verifies 3-word quiz, derives Taproot bc1p address, and IMMEDIATELY wipes all seed/key bytes from RAM
    async function finalizeColdWalletAddressAndWipe(w1, w2, w3) {
        if (isBtcBusy) throw new Error("Operation in progress. Please wait...");
        if (!PENDING_SEED_WORDS || PENDING_SEED_WORDS.length !== 12) {
            throw new Error("No pending 12-word seed found. Please generate your seed first.");
        }
        const quizCheck = verifyPendingSeedQuizDetailed(w1, w2, w3);
        if (!quizCheck.passed) {
            throw new Error(quizCheck.message);
        }
        isBtcBusy = true;
        let plainBytes = null;
        try {
            await runStartupBtcSelfTest();
            const phrase = PENDING_SEED_WORDS.join(" ");
            const isChecksumValid = await validateMnemonic(phrase);
            if (!isChecksumValid) {
                throw new Error("Pending seed checksum verification failed.");
            }
            plainBytes = new TextEncoder().encode(phrase);
            const accounts = await derivePublicAccountsFromBytes(plainBytes, true);
            clearPendingSeed();
            lockSessionRamKey();
            clearSessionUtxoLocks();
            return { taproot: accounts.taproot, taprootOnly: true };
        } finally {
            isBtcBusy = false;
            zeroize(plainBytes);
        }
    }

    // Cool Wallet Creator: New wallets are 100% Pure Taproot (taprootOnly = true)
    async function createAndEncryptPendingWallet(password) {
        if (isBtcBusy) throw new Error("Encryption in progress. Please wait a moment...");
        if (!PENDING_SEED_WORDS || PENDING_SEED_WORDS.length !== 12) {
            throw new Error("No pending 12-word seed found. Please generate your seed first.");
        }
        isBtcBusy = true;
        let plainBytes = null;
        try {
            await runStartupBtcSelfTest();
            const phrase = PENDING_SEED_WORDS.join(" ");
            const isChecksumValid = await validateMnemonic(phrase);
            if (!isChecksumValid) {
                throw new Error("Pending seed checksum verification failed. Please generate a fresh 12-word seed.");
            }
            plainBytes = new TextEncoder().encode(phrase);
            clearSessionUtxoLocks();
            const accounts = await derivePublicAccountsFromBytes(plainBytes, true);
            const vaultObj = await encryptSeedBytesWithPassword(plainBytes, password, true);
            clearPendingSeed();
            return { vaultObj, accounts };
        } finally {
            isBtcBusy = false;
            zeroize(plainBytes);
        }
    }

    // Cool Wallet Importer: Restores both Taproot (bc1p) and Native SegWit (bc1q) (taprootOnly = false)
    async function importAndEncryptWallet(wordsOrPhrase, password) {
        if (isBtcBusy) throw new Error("Encryption in progress. Please wait a moment...");
        isBtcBusy = true;
        let plainBytes = null;
        try {
            const rawStr = Array.isArray(wordsOrPhrase) ? wordsOrPhrase.join(" ") : String(wordsOrPhrase || "");
            const normPhrase = sanitizeSeedInputString(rawStr).trim().split(/\s+/).filter(Boolean).join(" ");
            const wordCount = normPhrase ? normPhrase.split(" ").length : 0;
            if (wordCount !== 12 && wordCount !== 24) {
                throw new Error(`Incomplete seed phrase (${wordCount} words selected). Please select all 12 (or 24) words.`);
            }
            const isChecksumOk = await validateMnemonic(normPhrase);
            if (!isChecksumOk) {
                throw new Error("❌ The selected words do not match the Bitcoin BIP-39 security checksum. Please check the exact word order on your paper backup!");
            }
            await runStartupBtcSelfTest();
            plainBytes = new TextEncoder().encode(normPhrase);
            clearSessionUtxoLocks();
            const accounts = await derivePublicAccountsFromBytes(plainBytes, false);
            const vaultObj = await encryptSeedBytesWithPassword(plainBytes, password, false);
            return { vaultObj, accounts };
        } finally {
            isBtcBusy = false;
            zeroize(plainBytes);
        }
    }

    // Zero-String RAM Vault Decryptor (Returns raw Uint8Array bytes; caller must zeroize)
    async function decryptVaultToBytes(vaultObj, password) {
        assertWebBtcSubtleReady();
        if (isBtcBusy) throw new Error("Unlock in progress. Please wait a moment...");
        const targetVault = vaultObj || ACTIVE_ENCRYPTED_VAULT_OBJ;
        if (!isValidVaultObject(targetVault)) {
            throw new Error("Saved wallet vault data is missing or corrupted. Please import your 12 paper backup words.");
        }
        const normPwd = normalizePasswordString(password);
        if (!normPwd) {
            throw new Error("Please enter your wallet password.");
        }
        if (normPwd.length > 128) {
            throw new Error("Password must not exceed 128 characters.");
        }
        const guard = getBruteForceGuardState();
        const now = Date.now();
        if (now < guard.lockoutUntil) {
            const waitSec = Math.ceil((guard.lockoutUntil - now) / 1000);
            throw new Error(`Security cooldown active. Please wait ${waitSec}s before trying again.`);
        }

        isBtcBusy = true;
        let salt = null, iv = null, ct = null, pwdBytes = null;
        try {
            const enc = new TextEncoder();
            salt = hexToBytes(targetVault.salt);
            iv = hexToBytes(targetVault.iv);
            ct = hexToBytes(targetVault.ct);
            pwdBytes = enc.encode(normPwd);
            const rounds = Number(targetVault.iterations);
            const isTapOnly = Boolean(targetVault.taprootOnly);
            const aadBytes = getVaultAadBytes(isTapOnly);

            const baseKey = await webBtcApi.subtle.importKey("raw", pwdBytes, "PBKDF2", false, ["deriveKey"]);
            const aesKey = await webBtcApi.subtle.deriveKey(
                { name: "PBKDF2", salt, iterations: rounds, hash: "SHA-256" },
                baseKey,
                { name: "AES-GCM", length: 256 },
                false,
                ["decrypt"]
            );
            const plainBuf = await webBtcApi.subtle.decrypt(
                { name: "AES-GCM", iv, additionalData: aadBytes },
                aesKey,
                ct
            );
            const plainArr = new Uint8Array(plainBuf);

            setBruteForceGuardState(0, 0);
            SESSION_AES_KEY = aesKey;
            SESSION_VAULT_IV = new Uint8Array(iv);
            SESSION_VAULT_CT = new Uint8Array(ct);
            SESSION_VAULT_AAD = new Uint8Array(aadBytes);
            ACTIVE_ENCRYPTED_VAULT_OBJ = targetVault;
            SESSION_EXPIRES_AT = Date.now() + SESSION_IDLE_MS;
            return plainArr;
        } catch (err) {
            const newFailures = guard.failures + 1;
            const remaining = MAX_UNLOCK_FAILURES - newFailures;

            if (remaining <= 0) {
                try { localStorage.removeItem(VAULT_STORAGE_KEY); } catch (e) {}
                setBruteForceGuardState(0, 0);
                lockSessionRamKey();
                clearSessionUtxoLocks();
                const wipeErr = new Error("🚨 5 failed password attempts reached! For your protection, the encrypted vault on this browser has been self-destructed. Please re-import your wallet using your 12 paper backup words.");
                wipeErr.vaultWiped = true;
                throw wipeErr;
            }

            let penaltyMs = 0;
            if (newFailures >= 2) {
                penaltyMs = Math.min(60000, Math.pow(2, newFailures - 1) * 2000);
            }
            setBruteForceGuardState(newFailures, Date.now() + penaltyMs);
            throw new Error(`Incorrect password (${remaining} ${remaining === 1 ? 'attempt' : 'attempts'} remaining before browser vault self-destructs).`);
        } finally {
            isBtcBusy = false;
            zeroize(pwdBytes, salt, iv, ct);
        }
    }

    async function decryptSeedWithPassword(vaultObj, password) {
        const plainBytes = await decryptVaultToBytes(vaultObj, password);
        try {
            return new TextDecoder().decode(plainBytes);
        } finally {
            zeroize(plainBytes);
        }
    }

    // Zero-String RAM Unlock (Never creates a JS String of the 12 words in RAM)
    async function unlockVaultToPublicAccounts(vaultObj, password) {
        const targetVault = vaultObj || ACTIVE_ENCRYPTED_VAULT_OBJ;
        const isTapOnly = Boolean(targetVault && targetVault.taprootOnly);
        const plainBytes = await decryptVaultToBytes(targetVault, password);
        try {
            return await derivePublicAccountsFromBytes(plainBytes, isTapOnly);
        } finally {
            zeroize(plainBytes);
        }
    }

    async function revealSeedWordsWithFreshPassword(vaultObj, password) {
        const phrase = await decryptSeedWithPassword(vaultObj || ACTIVE_ENCRYPTED_VAULT_OBJ, password);
        return phrase.trim().split(/\s+/);
    }

    // --- 11. SELF-VERIFIED SCHNORR (BIP-340) & ECDSA (RFC-6979 LOW-S) SIGNING ---
    async function signSchnorrBip340(msg32Bytes, priv32Bytes) {
        assertWebBtcSubtleReady();
        let d0 = bytesToBigInt(priv32Bytes);
        if (d0 === 0n || d0 >= N) throw new Error("Invalid Schnorr private scalar");
        const [px, py] = pointMul(d0);
        const evenPy = (py & 1n) === 0n ? py : (P - py);
        const d = (py & 1n) === 0n ? d0 : (N - d0);
        const aux = webBtcApi.getRandomValues(new Uint8Array(32));
        const tHash = await taggedHash("BIP0340/aux", aux);
        const dBytes = bigIntTo32Bytes(d);
        const tXor = new Uint8Array(32);
        for (let i = 0; i < 32; i++) tXor[i] = dBytes[i] ^ tHash[i];
        const pBytes = bigIntTo32Bytes(px);
        const randHash = await taggedHash("BIP0340/nonce", concatBytes(tXor, pBytes, msg32Bytes));
        zeroize(aux, tHash, dBytes, tXor);
        const k0 = mod(bytesToBigInt(randHash), N);
        if (k0 === 0n) throw new Error("BIP-340 nonce k0 == 0");
        const [rx, ry] = pointMul(k0);
        const evenRy = (ry & 1n) === 0n ? ry : (P - ry);
        const k = (ry & 1n) === 0n ? k0 : (N - k0);
        const rBytes = bigIntTo32Bytes(rx);
        const eHash = await taggedHash("BIP0340/challenge", concatBytes(rBytes, pBytes, msg32Bytes));
        const e = mod(bytesToBigInt(eHash), N);
        const s = mod(k + e * d, N);

        // Mathematical Self-Verification (s*G == R + e*P)
        const lhs = pointMul(s);
        const rhs = pointAdd([rx, evenRy], pointMul(e, [px, evenPy]));
        if (!lhs || !rhs || lhs[0] !== rhs[0] || lhs[1] !== rhs[1]) {
            throw new Error("Hardware fault detected: Schnorr signature self-verification failed");
        }
        return concatBytes(rBytes, bigIntTo32Bytes(s));
    }

    async function rfc6979Nonce(msg32Bytes, priv32Bytes) {
        let v = new Uint8Array(32).fill(1);
        let k = new Uint8Array(32).fill(0);
        k = await hmacSha256(k, concatBytes(v, new Uint8Array([0x00]), priv32Bytes, msg32Bytes));
        v = await hmacSha256(k, v);
        k = await hmacSha256(k, concatBytes(v, new Uint8Array([0x01]), priv32Bytes, msg32Bytes));
        v = await hmacSha256(k, v);
        while (true) {
            v = await hmacSha256(k, v);
            const candidate = bytesToBigInt(v);
            if (candidate >= 1n && candidate < N) return candidate;
            k = await hmacSha256(k, concatBytes(v, new Uint8Array([0x00])));
            v = await hmacSha256(k, v);
        }
    }

    function encodeDerSignature(rBig, sBig) {
        const toDerInt = (val) => {
            let b = Array.from(bigIntTo32Bytes(val));
            while (b.length > 1 && b[0] === 0 && (b[1] & 0x80) === 0) b.shift();
            if (b[0] & 0x80) b.unshift(0x00);
            return new Uint8Array([0x02, b.length, ...b]);
        };
        const rDer = toDerInt(rBig);
        const sDer = toDerInt(sBig);
        return concatBytes(new Uint8Array([0x30, rDer.length + sDer.length]), rDer, sDer);
    }

    async function signEcdsaLowS(msg32Bytes, priv32Bytes) {
        const d = bytesToBigInt(priv32Bytes);
        if (d === 0n || d >= N) throw new Error("Invalid ECDSA private scalar");
        const z = bytesToBigInt(msg32Bytes);
        const k = await rfc6979Nonce(msg32Bytes, priv32Bytes);
        const [rx] = pointMul(k);
        const r = mod(rx, N);
        if (r === 0n) throw new Error("ECDSA r == 0");
        let s = mod(modInv(k, N) * (z + r * d), N);
        if (s === 0n) throw new Error("ECDSA s == 0");
        if (s > HALF_N) s = N - s;

        // Mathematical Self-Verification (u1*G + u2*Q).x == r (mod N)
        const sInv = modInv(s, N);
        const vPt = pointAdd(pointMul(mod(z * sInv, N)), pointMul(mod(r * sInv, N), pointMul(d)));
        if (!vPt || mod(vPt[0], N) !== r) {
            throw new Error("Hardware fault detected: ECDSA signature self-verification failed");
        }
        return encodeDerSignature(r, s);
    }

    // Ephemeral ~3ms Zero-String RAM Signing (Decrypts directly to Uint8Array -> derives scalar -> signs -> zeroizes)
    async function signDigestWithActiveSession(mode, sighash32Bytes, sighashType = null) {
        assertWebBtcSubtleReady();
        if (isBtcBusy) throw new Error("Signing operation in progress. Please wait...");
        if (!isSessionUnlocked()) {
            throw new Error("Wallet session has expired or is locked. Please unlock with your password.");
        }
        isBtcBusy = true;
        const effectiveHashType = (sighashType === null || sighashType === undefined)
            ? (mode === "segwit" ? 0x01 : 0x00)
            : sighashType;

        let plainArr = null, seed = null, privTaproot = null, privSegwit = null, tweakedPrivBytes = null;
        try {
            const aadBytes = SESSION_VAULT_AAD || getVaultAadBytes(false);
            const plainBuf = await webBtcApi.subtle.decrypt(
                { name: "AES-GCM", iv: SESSION_VAULT_IV, additionalData: aadBytes },
                SESSION_AES_KEY,
                SESSION_VAULT_CT
            );
            plainArr = new Uint8Array(plainBuf);
            seed = await mnemonicBytesToSeed(plainArr);
            zeroize(plainArr);
            const H = 0x80000000;

            if (mode === "segwit") {
                const ht = effectiveHashType === 0x00 ? 0x01 : effectiveHashType;
                privSegwit = await derivePath(seed, [84 + H, 0 + H, 0 + H, 0, 0]);
                const derSig = await signEcdsaLowS(sighash32Bytes, privSegwit);
                return concatBytes(derSig, new Uint8Array([ht]));
            } else {
                privTaproot = await derivePath(seed, [86 + H, 0 + H, 0 + H, 0, 0]);
                const dTap = bytesToBigInt(privTaproot);
                const [px, py] = pointMul(dTap);
                const dEven = (py & 1n) === 0n ? dTap : (N - dTap);
                const internalXOnly = bigIntTo32Bytes(px);
                const tweakBytes = await taggedHash("TapTweak", internalXOnly);
                const t = bytesToBigInt(tweakBytes);
                if (t >= N) throw new Error("Invalid TapTweak >= N");
                const tweakedPt = pointAdd([px, (py & 1n) === 0n ? py : (P - py)], pointMul(t));
                if (!tweakedPt) throw new Error("Invalid TapTweak: point at infinity");
                const [qx, qy] = tweakedPt;
                let tweakedScalar = mod(dEven + t, N);
                if ((qy & 1n) !== 0n) tweakedScalar = N - tweakedScalar;
                tweakedPrivBytes = bigIntTo32Bytes(tweakedScalar);
                const schnorrSig = await signSchnorrBip340(sighash32Bytes, tweakedPrivBytes);
                return effectiveHashType === 0x00 ? schnorrSig : concatBytes(schnorrSig, new Uint8Array([effectiveHashType]));
            }
        } finally {
            isBtcBusy = false;
            zeroize(plainArr, seed, privTaproot, privSegwit, tweakedPrivBytes);
        }
    }

    // --- 12. ANTI-CENOTAPH RUNESTONE ENCODER, UNIFIED PLANNER & TX BUILDER (SPLIT + SEND nah + SEND sat) ---
    function writeU32LE(val) {
        const b = new Uint8Array(4);
        new DataView(b.buffer).setUint32(0, val >>> 0, true);
        return b;
    }

    function writeU64LE(valBig) {
        const b = new Uint8Array(8);
        const dv = new DataView(b.buffer);
        const big = BigInt(valBig);
        dv.setUint32(0, Number(big & 0xFFFFFFFFn) >>> 0, true);
        dv.setUint32(4, Number((big >> 32n) & 0xFFFFFFFFn) >>> 0, true);
        return b;
    }

    function encodeVarInt(n) {
        if (n < 0xfd) return new Uint8Array([n]);
        if (n <= 0xffff) {
            const b = new Uint8Array(3);
            b[0] = 0xfd;
            new DataView(b.buffer).setUint16(1, n, true);
            return b;
        }
        const b = new Uint8Array(5);
        b[0] = 0xfe;
        new DataView(b.buffer).setUint32(1, n >>> 0, true);
        return b;
    }

    function encodeLeb128(numBig) {
        let v = BigInt(numBig);
        if (v < 0n) throw new Error("Runestone LEB128 cannot encode negative integer");
        const out = [];
        while (true) {
            let byte = Number(v & 0x7Fn);
            v >>= 7n;
            if (v !== 0n) byte |= 0x80;
            out.push(byte);
            if (v === 0n) break;
        }
        return new Uint8Array(out);
    }

    function encodeNahRunestoneScript(edictsList, defaultPointerOut = null, totalTxOutputs = null, opReturnIndex = 0) {
        const chunks = [];
        if (defaultPointerOut !== null && defaultPointerOut !== undefined) {
            const ptr = Number(defaultPointerOut);
            if (ptr < 0 || ptr === opReturnIndex || (totalTxOutputs !== null && ptr >= totalTxOutputs)) {
                throw new Error("Anti-Cenotaph Firewall: Runestone pointer targets invalid or OP_RETURN output.");
            }
            chunks.push(encodeLeb128(22n), encodeLeb128(BigInt(ptr)));
        }
        if (Array.isArray(edictsList) && edictsList.length > 0) {
            chunks.push(encodeLeb128(0n)); // Tag 0 = Edict Body
            let prevBlock = 0n, prevTx = 0n;
            for (const ed of edictsList) {
                const amtBig = BigInt(ed.amount);
                const outIdx = Number(ed.outputIndex);
                if (amtBig <= 0n) throw new Error("Runestone edict amount must be > 0");
                if (outIdx < 0 || outIdx === opReturnIndex || (totalTxOutputs !== null && outIdx >= totalTxOutputs)) {
                    throw new Error("Anti-Cenotaph Firewall: Runestone edict targets invalid or OP_RETURN output.");
                }
                const dBlock = NAH_RUNE_BLOCK - prevBlock;
                const dTx = (dBlock === 0n) ? (NAH_RUNE_TX - prevTx) : NAH_RUNE_TX;
                prevBlock = NAH_RUNE_BLOCK;
                prevTx = NAH_RUNE_TX;
                chunks.push(
                    encodeLeb128(dBlock),
                    encodeLeb128(dTx),
                    encodeLeb128(amtBig),
                    encodeLeb128(BigInt(outIdx))
                );
            }
        }
        const payload = concatBytes(...chunks);
        if (payload.length > 80) {
            throw new Error("Runestone payload exceeds 80-byte standard OP_RETURN relay limit");
        }
        let pushPrefix = payload.length < 76
            ? new Uint8Array([payload.length])
            : new Uint8Array([0x4c, payload.length]);
        return concatBytes(new Uint8Array([0x6a, 0x5d]), pushPrefix, payload);
    }

    async function computeInputSighash({ mode, version = 2, locktime = 0, inputs, outputs, inputIndex, hashType = null, segwitHash160Hex = "" }) {
        const serializedOutputs = outputs.map(o => concatBytes(writeU64LE(o.value), encodeVarInt(o.scriptPubKey.length), o.scriptPubKey));

        if (mode === "segwit") {
            const ht = (hashType === null || hashType === undefined || hashType === 0x00) ? 0x01 : hashType;
            const anyoneCanPay = (ht & 0x80) !== 0;
            const baseType = ht & 0x1f;

            const hashPrevouts = anyoneCanPay
                ? new Uint8Array(32)
                : await sha256d(concatBytes(...inputs.map(inp => concatBytes(hexToBytes(inp.txid).reverse(), writeU32LE(inp.vout)))));

            const hashSequence = (anyoneCanPay || baseType === 2 || baseType === 3)
                ? new Uint8Array(32)
                : await sha256d(concatBytes(...inputs.map(inp => writeU32LE(inp.sequence ?? 0xfffffffd))));

            let hashOutputs = new Uint8Array(32);
            if (baseType !== 2 && baseType !== 3) {
                hashOutputs = await sha256d(concatBytes(...serializedOutputs));
            } else if (baseType === 3 && inputIndex < serializedOutputs.length) {
                hashOutputs = await sha256d(serializedOutputs[inputIndex]);
            }

            const curIn = inputs[inputIndex];
            const outpoint = concatBytes(hexToBytes(curIn.txid).reverse(), writeU32LE(curIn.vout));
            const scriptCode = concatBytes(new Uint8Array([0x19, 0x76, 0xa9, 0x14]), hexToBytes(segwitHash160Hex), new Uint8Array([0x88, 0xac]));
            const preimage = concatBytes(
                writeU32LE(version),
                hashPrevouts,
                hashSequence,
                outpoint,
                scriptCode,
                writeU64LE(curIn.value),
                writeU32LE(curIn.sequence ?? 0xfffffffd),
                hashOutputs,
                writeU32LE(locktime),
                writeU32LE(ht)
            );
            return await sha256d(preimage);
        }

        // BIP-341 Taproot Key-Path Sighash
        const ht = (hashType === null || hashType === undefined) ? 0x00 : hashType;
        if (ht === 0x80) throw new Error("Invalid BIP-341 Taproot hashType 0x80");
        const anyoneCanPay = (ht & 0x80) !== 0;
        const baseType = ht & 0x03;
        const parts = [
            new Uint8Array([0x00, ht]),
            writeU32LE(version),
            writeU32LE(locktime)
        ];

        if (!anyoneCanPay) {
            const shaPrevouts = await sha256(concatBytes(...inputs.map(inp => concatBytes(hexToBytes(inp.txid).reverse(), writeU32LE(inp.vout)))));
            const shaAmounts = await sha256(concatBytes(...inputs.map(inp => writeU64LE(inp.value))));
            const shaScriptPubKeys = await sha256(concatBytes(...inputs.map(inp => concatBytes(encodeVarInt(inp.scriptPubKey.length), inp.scriptPubKey))));
            const shaSequences = await sha256(concatBytes(...inputs.map(inp => writeU32LE(inp.sequence ?? 0xfffffffd))));
            parts.push(shaPrevouts, shaAmounts, shaScriptPubKeys, shaSequences);
        }

        if (baseType !== 2 && baseType !== 3) {
            parts.push(await sha256(concatBytes(...serializedOutputs)));
        }

        parts.push(new Uint8Array([0x00])); // spend_type = 0

        const curIn = inputs[inputIndex];
        if (anyoneCanPay) {
            parts.push(
                concatBytes(hexToBytes(curIn.txid).reverse(), writeU32LE(curIn.vout)),
                writeU64LE(curIn.value),
                concatBytes(encodeVarInt(curIn.scriptPubKey.length), curIn.scriptPubKey),
                writeU32LE(curIn.sequence ?? 0xfffffffd)
            );
        } else {
            parts.push(writeU32LE(inputIndex));
        }

        if (baseType === 3 && inputIndex < serializedOutputs.length) {
            parts.push(await sha256(serializedOutputs[inputIndex]));
        }

        return await taggedHash("TapSighash", concatBytes(...parts));
    }

    function computeExactTxVsize(mode, numInputs, outputsList) {
        const serializedOutputsLen = outputsList.reduce((acc, o) => acc + 8 + encodeVarInt(o.scriptPubKey.length).length + o.scriptPubKey.length, 0);
        const baseLen = 4 + encodeVarInt(numInputs).length + (numInputs * 41) + encodeVarInt(outputsList.length).length + serializedOutputsLen + 4;
        const perInputWitnessLen = mode === "segwit" ? (1 + 1 + 72 + 1 + 33) : (1 + 1 + 64);
        const witnessLen = baseLen + 2 + (numInputs * perInputWitnessLen);
        const weight = baseLen * 3 + witnessLen;
        return Math.ceil(weight / 4);
    }

    function filterSafeCardinals(allNahUtxos, cardinalUtxos, extraProtectedOutpoint = null) {
        const protectedOutpoints = new Set();
        if (extraProtectedOutpoint) protectedOutpoints.add(extraProtectedOutpoint);
        for (const nu of (allNahUtxos || [])) {
            const normNu = normalizeUtxoOutpoint(nu);
            if (normNu) protectedOutpoints.add(normNu.outpoint);
        }
        const safeCardinals = [];
        for (const cu of (cardinalUtxos || [])) {
            const normCu = normalizeUtxoOutpoint(cu);
            if (!normCu || protectedOutpoints.has(normCu.outpoint) || SESSION_SPENT_OUTPOINTS.has(normCu.outpoint)) continue;
            const val = Math.floor(Number(cu.value || 0));
            if (cu.isSessionChange) {
                if (val >= Number(MIN_BTC_CHANGE_SATS)) safeCardinals.push({ ...normCu, value: val, isSessionChange: true });
            } else if (Boolean(cu.status && cu.status.confirmed) && val >= MIN_EXTERNAL_SAT_SATS) {
                safeCardinals.push({ ...normCu, value: val });
            }
        }
        return safeCardinals;
    }

    // Smallest-Sufficient-First Sat UTXO Selector with Exact Step-Marginal Effective-Value Guard
    function selectOptimalSatUtxos({ mode, safeCardinals, baseOutputsNoChange, baseOutputsWithChange, initialInSats, requiredPacketSats, rate, baseInputCount = 1 }) {
        const feeAtInputs = (numIn, outputs) => BigInt(Math.ceil(computeExactTxVsize(mode, numIn, outputs) * rate));
        const stepMarginalFee = (currentNumIn, outputs) => {
            if (currentNumIn <= 0) return 0n;
            return feeAtInputs(currentNumIn + 1, outputs) - feeAtInputs(currentNumIn, outputs);
        };
        const isWithChangeOk = (numIn, totalIn) => {
            if (numIn <= 0) return false;
            return totalIn >= requiredPacketSats + feeAtInputs(numIn, baseOutputsWithChange) + MIN_BTC_CHANGE_SATS;
        };
        const isNoChangeOk = (numIn, totalIn) => {
            if (numIn <= 0) return false;
            return totalIn >= requiredPacketSats + feeAtInputs(numIn, baseOutputsNoChange);
        };

        if (baseInputCount > 0 && (isWithChangeOk(baseInputCount, initialInSats) || (safeCardinals.length === 0 && isNoChangeOk(baseInputCount, initialInSats)))) {
            return { chosenCardinals: [], totalInSats: initialInSats };
        }

        const asc = safeCardinals.slice().sort((a, b) => (a.value || 0) - (b.value || 0));
        for (const cu of asc) {
            const candTotal = initialInSats + BigInt(cu.value);
            if (isWithChangeOk(baseInputCount + 1, candTotal)) {
                return { chosenCardinals: [cu], totalInSats: candTotal };
            }
        }

        const desc = safeCardinals.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
        const chosenWithChange = [];
        let totalWithChange = initialInSats;
        for (const cu of desc) {
            const uVal = BigInt(cu.value);
            const curInCount = baseInputCount + chosenWithChange.length;
            if (curInCount >= 1 && uVal <= stepMarginalFee(curInCount, baseOutputsWithChange)) continue;
            chosenWithChange.push(cu);
            totalWithChange += uVal;
            if (isWithChangeOk(baseInputCount + chosenWithChange.length, totalWithChange)) {
                return { chosenCardinals: chosenWithChange, totalInSats: totalWithChange };
            }
        }

        if (baseInputCount > 0 && isNoChangeOk(baseInputCount, initialInSats)) {
            return { chosenCardinals: [], totalInSats: initialInSats };
        }
        for (const cu of asc) {
            const candTotal = initialInSats + BigInt(cu.value);
            if (isNoChangeOk(baseInputCount + 1, candTotal)) {
                return { chosenCardinals: [cu], totalInSats: candTotal };
            }
        }
        const chosenNoChange = [];
        let totalNoChange = initialInSats;
        for (const cu of desc) {
            const uVal = BigInt(cu.value);
            const curInCount = baseInputCount + chosenNoChange.length;
            if (curInCount >= 1 && uVal <= stepMarginalFee(curInCount, baseOutputsNoChange)) continue;
            chosenNoChange.push(cu);
            totalNoChange += uVal;
            if (isNoChangeOk(baseInputCount + chosenNoChange.length, totalNoChange)) break;
        }
        return { chosenCardinals: chosenNoChange, totalInSats: totalNoChange };
    }

    function planNahSplitTransaction({ mode = "taproot", userSpk, selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], splitAmounts = [], feeRateSatVb = 1 }) {
        const normSelected = normalizeUtxoOutpoint(selectedNahUtxo);
        if (!normSelected) throw new Error("Please select a valid nah UTXO packet to split.");
        if (selectedNahUtxo.isPendingSplit || selectedNahUtxo.isConfirmingInMempool || SESSION_SPENT_OUTPOINTS.has(normSelected.outpoint)) {
            throw new Error("⏳ This packet is currently waiting for block confirmation in the Bitcoin mempool. Please wait ~10 mins for the next block before splitting it again.");
        }

        const totalNah = BigInt(normSelected.nah || 0);
        if (!Array.isArray(splitAmounts) || splitAmounts.length === 0) {
            throw new Error("Please enter at least one split amount.");
        }
        const cleanSplits = splitAmounts.map(a => {
            const parsed = typeof a === "bigint" ? a : parseStrictNahAmount(a);
            if (!parsed || parsed <= 0n) throw new Error("Each split packet amount must be a whole number greater than 0 nah.");
            return parsed;
        });

        const sumRequested = cleanSplits.reduce((acc, a) => acc + a, 0n);
        if (sumRequested >= totalNah) {
            throw new Error("Split amounts must be smaller than the total nah inside this packet.");
        }
        const remainderNah = totalNah - sumRequested;
        const finalPacketBigInts = [...cleanSplits, remainderNah];
        const nahPacketOutputsCount = finalPacketBigInts.length;

        if (nahPacketOutputsCount < 2 || nahPacketOutputsCount > 10) {
            throw new Error("Splitting must create between 2 and 10 nah packets.");
        }
        if (finalPacketBigInts.reduce((acc, a) => acc + a, 0n) !== totalNah) {
            throw new Error("Conservation of Mass Error: Output nah total does not equal Input nah total.");
        }

        const edicts = finalPacketBigInts.map((amt, i) => ({ amount: amt, outputIndex: i + 1 }));
        const safeCardinals = filterSafeCardinals(allNahUtxos, cardinalUtxos, normSelected.outpoint);

        const spk = userSpk || (mode === "segwit" ? new Uint8Array(22) : new Uint8Array(34));
        const runestoneScript = encodeNahRunestoneScript(edicts, null, 1 + nahPacketOutputsCount, 0);
        const baseOutputsNoChange = [{ value: 0n, scriptPubKey: runestoneScript }];
        for (let i = 0; i < nahPacketOutputsCount; i++) {
            baseOutputsNoChange.push({ value: MIN_SAFE_PACKET_SATS, scriptPubKey: spk });
        }
        const baseOutputsWithChange = [...baseOutputsNoChange, { value: MIN_BTC_CHANGE_SATS, scriptPubKey: spk }];

        const initialInSats = BigInt(normSelected.sats || 546);
        const requiredPacketSats = BigInt(nahPacketOutputsCount) * MIN_SAFE_PACKET_SATS;
        const rate = sanitizeFeeRate(feeRateSatVb);

        const { chosenCardinals, totalInSats } = selectOptimalSatUtxos({
            mode,
            safeCardinals,
            baseOutputsNoChange,
            baseOutputsWithChange,
            initialInSats,
            requiredPacketSats,
            rate,
            baseInputCount: 1
        });

        const actualNumIn = 1 + chosenCardinals.length;
        const singleInFeeNoChange = BigInt(Math.ceil(computeExactTxVsize(mode, 1, baseOutputsNoChange) * rate));
        const selfSufficientSingleIn = (chosenCardinals.length === 0) && (initialInSats >= requiredPacketSats + singleInFeeNoChange);
        const estNumIn = selfSufficientSingleIn ? 1 : Math.max(2, actualNumIn);

        const exactVsizeWithChange = computeExactTxVsize(mode, estNumIn, baseOutputsWithChange);
        const exactFeeWithChange = BigInt(Math.ceil(exactVsizeWithChange * rate));
        const exactVsizeNoChange = computeExactTxVsize(mode, estNumIn, baseOutputsNoChange);
        const exactFeeNoChange = BigInt(Math.ceil(exactVsizeNoChange * rate));

        const remAfterChangeFee = totalInSats - requiredPacketSats - exactFeeWithChange;
        const hasBtcChangeOut = remAfterChangeFee >= MIN_BTC_CHANGE_SATS;
        const hasEnoughSat = totalInSats >= (requiredPacketSats + exactFeeNoChange);

        const fundedNumIn = actualNumIn + 1;
        const vsizeWhenFunded = computeExactTxVsize(mode, fundedNumIn, baseOutputsNoChange);
        const feeWhenFunded = BigInt(Math.ceil(vsizeWhenFunded * rate));

        const activeVsize = hasBtcChangeOut
            ? exactVsizeWithChange
            : (hasEnoughSat ? exactVsizeNoChange : vsizeWhenFunded);
        const activeMinerFeeSats = hasBtcChangeOut
            ? Number(exactFeeWithChange)
            : (hasEnoughSat ? Number(totalInSats - requiredPacketSats) : Number(feeWhenFunded));
        const sub600MergedSats = (!hasBtcChangeOut && hasEnoughSat)
            ? Math.max(0, Number(totalInSats - requiredPacketSats - exactFeeNoChange))
            : 0;
        const extraPacketSats = Math.max(0, Number(requiredPacketSats - initialInSats));
        const totalSatNeededSats = extraPacketSats + activeMinerFeeSats;
        const deficitSats = hasEnoughSat
            ? 0
            : Math.max(MIN_EXTERNAL_SAT_SATS, Number((requiredPacketSats + feeWhenFunded) - totalInSats));
        const exceedsMaxFeeCap = BigInt(activeMinerFeeSats) > MAX_SAFE_MINER_FEE_SATS;

        return {
            normSelected,
            initialInSats,
            chosenCardinals,
            totalInSats,
            finalPacketBigInts,
            nahPacketOutputsCount,
            edicts,
            runestoneScript,
            hasBtcChangeOut,
            remAfterChangeFee,
            hasEnoughSat,
            exceedsMaxFeeCap,
            sub600MergedSats,
            deficitSats,
            estVsize: activeVsize,
            estMinerFeeSats: activeMinerFeeSats,
            extraPacketSats,
            totalSatNeededSats
        };
    }

    function estimateNahSplitCost({ mode = "taproot", selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], splitAmounts = [], feeRateSatVb = 1 }) {
        try {
            return planNahSplitTransaction({ mode, userSpk: null, selectedNahUtxo, allNahUtxos, cardinalUtxos, splitAmounts, feeRateSatVb });
        } catch (e) {
            return null;
        }
    }

    // Unified SEND nah Planner (Defaults to 34-byte Taproot recipient scriptPubKey when address is not yet pasted)
    function planNahSendTransaction({ mode = "taproot", userSpk, recipientAddress, selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], sendAmount, feeRateSatVb = 1 }) {
        const normSelected = normalizeUtxoOutpoint(selectedNahUtxo);
        if (!normSelected) throw new Error("Please select a valid nah UTXO packet to send from.");
        if (selectedNahUtxo.isPendingSplit || selectedNahUtxo.isConfirmingInMempool || SESSION_SPENT_OUTPOINTS.has(normSelected.outpoint)) {
            throw new Error("⏳ This packet is currently waiting for block confirmation in the Bitcoin mempool.");
        }

        const totalNah = BigInt(normSelected.nah || 0);
        const sendBig = typeof sendAmount === "bigint" ? sendAmount : parseStrictNahAmount(sendAmount);
        if (!sendBig || sendBig <= 0n || sendBig > totalNah) {
            throw new Error(`Send amount must be between 1 and ${totalNah.toLocaleString("en-US")} nah.`);
        }

        const cleanRecip = String(recipientAddress || "").trim();
        const recipSpk = cleanRecip ? addressToScriptPubKey(cleanRecip) : new Uint8Array(34);
        const senderSpk = userSpk || (mode === "segwit" ? new Uint8Array(22) : new Uint8Array(34));

        const remainderNah = totalNah - sendBig;
        const hasNahChange = remainderNah > 0n;
        const nahPacketOutputsCount = hasNahChange ? 2 : 1;

        const edicts = hasNahChange
            ? [{ amount: sendBig, outputIndex: 1 }, { amount: remainderNah, outputIndex: 2 }]
            : [{ amount: sendBig, outputIndex: 1 }];

        const safeCardinals = filterSafeCardinals(allNahUtxos, cardinalUtxos, normSelected.outpoint);
        const runestoneScript = encodeNahRunestoneScript(edicts, null, 1 + nahPacketOutputsCount, 0);

        const baseOutputsNoChange = [
            { value: 0n, scriptPubKey: runestoneScript },
            { value: MIN_SAFE_PACKET_SATS, scriptPubKey: recipSpk }
        ];
        if (hasNahChange) {
            baseOutputsNoChange.push({ value: MIN_SAFE_PACKET_SATS, scriptPubKey: senderSpk });
        }
        const baseOutputsWithChange = [...baseOutputsNoChange, { value: MIN_BTC_CHANGE_SATS, scriptPubKey: senderSpk }];

        const initialInSats = BigInt(normSelected.sats || 546);
        const requiredPacketSats = BigInt(nahPacketOutputsCount) * MIN_SAFE_PACKET_SATS;
        const rate = sanitizeFeeRate(feeRateSatVb);

        const { chosenCardinals, totalInSats } = selectOptimalSatUtxos({
            mode,
            safeCardinals,
            baseOutputsNoChange,
            baseOutputsWithChange,
            initialInSats,
            requiredPacketSats,
            rate,
            baseInputCount: 1
        });

        const actualNumIn = 1 + chosenCardinals.length;
        const singleInFeeNoChange = BigInt(Math.ceil(computeExactTxVsize(mode, 1, baseOutputsNoChange) * rate));
        const selfSufficientSingleIn = (chosenCardinals.length === 0) && (initialInSats >= requiredPacketSats + singleInFeeNoChange);
        const estNumIn = selfSufficientSingleIn ? 1 : Math.max(2, actualNumIn);

        const exactVsizeWithChange = computeExactTxVsize(mode, estNumIn, baseOutputsWithChange);
        const exactFeeWithChange = BigInt(Math.ceil(exactVsizeWithChange * rate));
        const exactVsizeNoChange = computeExactTxVsize(mode, estNumIn, baseOutputsNoChange);
        const exactFeeNoChange = BigInt(Math.ceil(exactVsizeNoChange * rate));

        const remAfterChangeFee = totalInSats - requiredPacketSats - exactFeeWithChange;
        const hasBtcChangeOut = remAfterChangeFee >= MIN_BTC_CHANGE_SATS;
        const hasEnoughSat = totalInSats >= (requiredPacketSats + exactFeeNoChange);

        const fundedNumIn = actualNumIn + 1;
        const vsizeWhenFunded = computeExactTxVsize(mode, fundedNumIn, baseOutputsNoChange);
        const feeWhenFunded = BigInt(Math.ceil(vsizeWhenFunded * rate));

        const activeVsize = hasBtcChangeOut
            ? exactVsizeWithChange
            : (hasEnoughSat ? exactVsizeNoChange : vsizeWhenFunded);
        const activeMinerFeeSats = hasBtcChangeOut
            ? Number(exactFeeWithChange)
            : (hasEnoughSat ? Number(totalInSats - requiredPacketSats) : Number(feeWhenFunded));
        const sub600MergedSats = (!hasBtcChangeOut && hasEnoughSat)
            ? Math.max(0, Number(totalInSats - requiredPacketSats - exactFeeNoChange))
            : 0;
        const extraPacketSats = Math.max(0, Number(requiredPacketSats - initialInSats));
        const totalSatNeededSats = extraPacketSats + activeMinerFeeSats;
        const deficitSats = hasEnoughSat
            ? 0
            : Math.max(MIN_EXTERNAL_SAT_SATS, Number((requiredPacketSats + feeWhenFunded) - totalInSats));
        const exceedsMaxFeeCap = BigInt(activeMinerFeeSats) > MAX_SAFE_MINER_FEE_SATS;

        return {
            normSelected,
            initialInSats,
            chosenCardinals,
            totalInSats,
            sendBig,
            remainderNah,
            hasNahChange,
            nahPacketOutputsCount,
            edicts,
            runestoneScript,
            recipSpk,
            hasBtcChangeOut,
            remAfterChangeFee,
            hasEnoughSat,
            exceedsMaxFeeCap,
            sub600MergedSats,
            deficitSats,
            estVsize: activeVsize,
            estMinerFeeSats: activeMinerFeeSats,
            extraPacketSats,
            totalSatNeededSats
        };
    }

    function estimateNahSendCost({ mode = "taproot", recipientAddress = "", selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], sendAmount, feeRateSatVb = 1 }) {
        try {
            const validAddr = isValidBitcoinAddress(recipientAddress) ? recipientAddress.trim() : "";
            return planNahSendTransaction({ mode, userSpk: null, recipientAddress: validAddr, selectedNahUtxo, allNahUtxos, cardinalUtxos, sendAmount, feeRateSatVb });
        } catch (e) {
            return null;
        }
    }

    // Pure BTC (sat) Max Sweep Calculator Synchronized 100% with Step-Marginal Effective-Value Selector
    function computeMaxSendableSats({ mode = "taproot", recipientAddress = "", allNahUtxos = [], cardinalUtxos = [], feeRateSatVb = 1 }) {
        const safeCardinals = filterSafeCardinals(allNahUtxos, cardinalUtxos, null);
        if (safeCardinals.length === 0) return 0;
        const cleanRecip = isValidBitcoinAddress(recipientAddress) ? recipientAddress.trim() : "";
        const recipSpk = cleanRecip ? addressToScriptPubKey(cleanRecip) : new Uint8Array(34);
        const rate = sanitizeFeeRate(feeRateSatVb);
        const oneOutList = [{ value: MIN_SAFE_PACKET_SATS, scriptPubKey: recipSpk }];
        const feeAtInputs = (numIn) => BigInt(Math.ceil(computeExactTxVsize(mode, numIn, oneOutList) * rate));

        const desc = safeCardinals.slice().sort((a, b) => (b.value || 0) - (a.value || 0));
        let runningTotal = 0n;
        let count = 0;
        let bestMaxSend = 0n;

        for (const cu of desc) {
            const uVal = BigInt(cu.value);
            const nextCount = count + 1;
            const nextFee = feeAtInputs(nextCount);
            if (nextFee > MAX_SAFE_MINER_FEE_SATS) break;
            if (count >= 1) {
                const prevFee = feeAtInputs(count);
                if (uVal <= (nextFee - prevFee)) continue;
            }
            runningTotal += uVal;
            count = nextCount;
            if (runningTotal > nextFee) {
                const candidateSend = runningTotal - nextFee;
                if (candidateSend > bestMaxSend) {
                    bestMaxSend = candidateSend;
                }
            }
        }
        return bestMaxSend >= MIN_SAFE_PACKET_SATS ? Number(bestMaxSend) : 0;
    }

    function planBtcSendTransaction({ mode = "taproot", userSpk, recipientAddress = "", allNahUtxos = [], cardinalUtxos = [], sendSats, feeRateSatVb = 1 }) {
        const sendBig = typeof sendSats === "bigint" ? sendSats : parseStrictSatAmount(sendSats);
        if (!sendBig || sendBig < MIN_SAFE_PACKET_SATS) {
            throw new Error(`Send amount must be at least ${MIN_SAFE_PACKET_SATS} sats.`);
        }
        const safeCardinals = filterSafeCardinals(allNahUtxos, cardinalUtxos, null);
        const cleanRecip = String(recipientAddress || "").trim();
        const recipSpk = cleanRecip ? addressToScriptPubKey(cleanRecip) : new Uint8Array(34);
        const senderSpk = userSpk || (mode === "segwit" ? new Uint8Array(22) : new Uint8Array(34));

        const baseOutputsNoChange = [{ value: sendBig, scriptPubKey: recipSpk }];
        const baseOutputsWithChange = [...baseOutputsNoChange, { value: MIN_BTC_CHANGE_SATS, scriptPubKey: senderSpk }];
        const rate = sanitizeFeeRate(feeRateSatVb);

        const { chosenCardinals, totalInSats } = selectOptimalSatUtxos({
            mode,
            safeCardinals,
            baseOutputsNoChange,
            baseOutputsWithChange,
            initialInSats: 0n,
            requiredPacketSats: sendBig,
            rate,
            baseInputCount: 0
        });

        const actualNumIn = chosenCardinals.length;
        const estNumIn = Math.max(1, actualNumIn);
        const exactVsizeWithChange = computeExactTxVsize(mode, estNumIn, baseOutputsWithChange);
        const exactFeeWithChange = BigInt(Math.ceil(exactVsizeWithChange * rate));
        const exactVsizeNoChange = computeExactTxVsize(mode, estNumIn, baseOutputsNoChange);
        const exactFeeNoChange = BigInt(Math.ceil(exactVsizeNoChange * rate));

        const remAfterChangeFee = totalInSats - sendBig - exactFeeWithChange;
        const hasBtcChangeOut = remAfterChangeFee >= MIN_BTC_CHANGE_SATS;
        const hasEnoughSat = actualNumIn > 0 && totalInSats >= (sendBig + exactFeeNoChange);

        const fundedNumIn = actualNumIn + 1;
        const vsizeWhenFunded = computeExactTxVsize(mode, fundedNumIn, baseOutputsNoChange);
        const feeWhenFunded = BigInt(Math.ceil(vsizeWhenFunded * rate));

        const activeVsize = hasBtcChangeOut
            ? exactVsizeWithChange
            : (hasEnoughSat ? exactVsizeNoChange : vsizeWhenFunded);
        const activeMinerFeeSats = hasBtcChangeOut
            ? Number(exactFeeWithChange)
            : (hasEnoughSat ? Number(totalInSats - sendBig) : Number(feeWhenFunded));
        const sub600MergedSats = (!hasBtcChangeOut && hasEnoughSat)
            ? Math.max(0, Number(totalInSats - sendBig - exactFeeNoChange))
            : 0;
        const totalSatNeededSats = Number(sendBig) + activeMinerFeeSats;
        const deficitSats = hasEnoughSat
            ? 0
            : Math.max(MIN_EXTERNAL_SAT_SATS, Number((sendBig + feeWhenFunded) - totalInSats));
        const exceedsMaxFeeCap = BigInt(activeMinerFeeSats) > MAX_SAFE_MINER_FEE_SATS;

        return {
            chosenCardinals,
            totalInSats,
            sendBig,
            recipSpk,
            hasBtcChangeOut,
            remAfterChangeFee,
            hasEnoughSat,
            exceedsMaxFeeCap,
            sub600MergedSats,
            deficitSats,
            estVsize: activeVsize,
            estMinerFeeSats: activeMinerFeeSats,
            totalSatNeededSats
        };
    }

    function estimateBtcSendCost({ mode = "taproot", recipientAddress = "", allNahUtxos = [], cardinalUtxos = [], sendSats, feeRateSatVb = 1 }) {
        try {
            const validAddr = isValidBitcoinAddress(recipientAddress) ? recipientAddress.trim() : "";
            return planBtcSendTransaction({ mode, userSpk: null, recipientAddress: validAddr, allNahUtxos, cardinalUtxos, sendSats, feeRateSatVb });
        } catch (e) {
            return null;
        }
    }

    async function buildSignedTransaction({ mode, account, inputs, outputs, version = 2, locktime = 0, hashType = null }) {
        if (!Array.isArray(inputs) || inputs.length === 0) throw new Error("Transaction requires at least 1 input");
        if (!Array.isArray(outputs) || outputs.length === 0) throw new Error("Transaction requires at least 1 output");

        const inputScriptPubKey = addressToScriptPubKey(account.address);
        const normalizedInputs = inputs.map(inp => {
            const norm = normalizeUtxoOutpoint(inp);
            if (!norm) throw new Error("Invalid transaction input outpoint");
            return {
                txid: norm.txid,
                vout: norm.vout,
                value: BigInt(inp.value),
                sequence: inp.sequence ?? 0xfffffffd,
                scriptPubKey: inp.scriptPubKey || inputScriptPubKey
            };
        });
        const normalizedOutputs = outputs.map(out => {
            const spk = out.scriptPubKey || addressToScriptPubKey(out.address);
            const val = BigInt(out.value);
            const isOpReturn = spk[0] === 0x6a;
            if (!isOpReturn && val < MIN_SAFE_PACKET_SATS) {
                throw new Error(`Output value (${val} sats) is below the ${MIN_SAFE_PACKET_SATS}-sat safety limit.`);
            }
            if (isOpReturn && val !== 0n) {
                throw new Error("OP_RETURN output must have 0 sats value.");
            }
            return { value: val, scriptPubKey: spk };
        });

        const totalInSats = normalizedInputs.reduce((acc, i) => acc + i.value, 0n);
        const totalOutSats = normalizedOutputs.reduce((acc, o) => acc + o.value, 0n);
        const minerFeeSats = totalInSats - totalOutSats;

        if (minerFeeSats <= 0n) {
            throw new Error("Insufficient sat balance to cover network transaction fee.");
        }
        if (minerFeeSats > MAX_SAFE_MINER_FEE_SATS) {
            throw new Error(`Safety Circuit Breaker: Network fee (${minerFeeSats} sats) exceeds maximum safe limit (${MAX_SAFE_MINER_FEE_SATS} sats).`);
        }

        const witnesses = [];
        for (let i = 0; i < normalizedInputs.length; i++) {
            const digest = await computeInputSighash({
                mode,
                version,
                locktime,
                inputs: normalizedInputs,
                outputs: normalizedOutputs,
                inputIndex: i,
                hashType,
                segwitHash160Hex: account.hash160Hex || ""
            });
            const sigBytes = await signDigestWithActiveSession(mode, digest, hashType);
            if (mode === "segwit") {
                const pubBytes = hexToBytes(account.pubkeyHex);
                witnesses.push(concatBytes(
                    new Uint8Array([0x02]),
                    encodeVarInt(sigBytes.length), sigBytes,
                    encodeVarInt(pubBytes.length), pubBytes
                ));
            } else {
                witnesses.push(concatBytes(
                    new Uint8Array([0x01]),
                    encodeVarInt(sigBytes.length), sigBytes
                ));
            }
        }

        const serializedInputs = normalizedInputs.map(inp => concatBytes(
            hexToBytes(inp.txid).reverse(),
            writeU32LE(inp.vout),
            new Uint8Array([0x00]),
            writeU32LE(inp.sequence)
        ));
        const serializedOutputs = normalizedOutputs.map(out => concatBytes(
            writeU64LE(out.value),
            encodeVarInt(out.scriptPubKey.length),
            out.scriptPubKey
        ));

        const baseTxBytes = concatBytes(
            writeU32LE(version),
            encodeVarInt(serializedInputs.length),
            ...serializedInputs,
            encodeVarInt(serializedOutputs.length),
            ...serializedOutputs,
            writeU32LE(locktime)
        );

        const witnessTxBytes = concatBytes(
            writeU32LE(version),
            new Uint8Array([0x00, 0x01]),
            encodeVarInt(serializedInputs.length),
            ...serializedInputs,
            encodeVarInt(serializedOutputs.length),
            ...serializedOutputs,
            ...witnesses,
            writeU32LE(locktime)
        );

        const txidHash = await sha256d(baseTxBytes);
        const txid = bytesToHex(new Uint8Array(txidHash).reverse());
        const weight = baseTxBytes.length * 3 + witnessTxBytes.length;
        const vsize = Math.ceil(weight / 4);

        return {
            txid,
            vsize,
            weight,
            feeSats: Number(minerFeeSats),
            rawHex: bytesToHex(witnessTxBytes)
        };
    }

    async function buildNahSplitTransaction({ mode, account, selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], splitAmounts, feeRateSatVb = 1 }) {
        const userSpk = addressToScriptPubKey(account.address);
        const plan = planNahSplitTransaction({
            mode,
            userSpk,
            selectedNahUtxo,
            allNahUtxos,
            cardinalUtxos,
            splitAmounts,
            feeRateSatVb
        });

        if (!plan.hasEnoughSat) {
            const satErr = new Error(`Need ~${plan.deficitSats.toLocaleString("en-US")} more sats in your Basic sat Balance to split this packet.`);
            satErr.insufficientSat = true;
            satErr.neededSats = plan.deficitSats;
            throw satErr;
        }

        const inputs = [
            { txid: plan.normSelected.txid, vout: plan.normSelected.vout, value: plan.initialInSats },
            ...plan.chosenCardinals.map(c => ({ txid: c.txid, vout: c.vout, value: BigInt(c.value) }))
        ];

        const totalOutputsCount = 1 + plan.nahPacketOutputsCount + (plan.hasBtcChangeOut ? 1 : 0);

        const outputs = [{ value: 0n, scriptPubKey: plan.runestoneScript }];
        for (let i = 0; i < plan.nahPacketOutputsCount; i++) {
            outputs.push({ value: MIN_SAFE_PACKET_SATS, scriptPubKey: userSpk });
        }
        if (plan.hasBtcChangeOut) {
            outputs.push({ value: plan.remAfterChangeFee, scriptPubKey: userSpk });
        }

        const signedTx = await buildSignedTransaction({ mode, account, inputs, outputs });
        const finalPacketAmounts = plan.finalPacketBigInts.map(x => Number(x));

        const newNahUtxoObjects = finalPacketAmounts.map((amt, idx) => ({
            txid: signedTx.txid,
            vout: idx + 1,
            outpoint: `${signedTx.txid}:${idx + 1}`,
            nah: amt,
            sats: Number(MIN_SAFE_PACKET_SATS),
            isPendingSplit: true
        }));

        const newBtcChangeObject = plan.hasBtcChangeOut
            ? {
                txid: signedTx.txid,
                vout: totalOutputsCount - 1,
                outpoint: `${signedTx.txid}:${totalOutputsCount - 1}`,
                value: Number(plan.remAfterChangeFee),
                isSessionChange: true,
                status: { confirmed: false }
            }
            : null;

        return {
            ...signedTx,
            actionType: "split_nah",
            spentInputs: inputs.map(i => ({ txid: i.txid, vout: i.vout, outpoint: `${i.txid}:${i.vout}` })),
            createdPacketAmounts: finalPacketAmounts,
            newNahUtxoObjects,
            newBtcChangeObject
        };
    }

    async function buildNahSendTransaction({ mode, account, recipientAddress, selectedNahUtxo, allNahUtxos = [], cardinalUtxos = [], sendAmount, feeRateSatVb = 1 }) {
        const cleanRecip = String(recipientAddress || "").trim();
        if (!isValidBitcoinAddress(cleanRecip)) {
            throw new Error("Please enter a valid Bitcoin receiving address (bc1p... or bc1q...).");
        }
        const userSpk = addressToScriptPubKey(account.address);
        const plan = planNahSendTransaction({
            mode,
            userSpk,
            recipientAddress: cleanRecip,
            selectedNahUtxo,
            allNahUtxos,
            cardinalUtxos,
            sendAmount,
            feeRateSatVb
        });

        if (!plan.hasEnoughSat) {
            const satErr = new Error(`Need ~${plan.deficitSats.toLocaleString("en-US")} more sats in your Basic sat Balance to send this nah packet.`);
            satErr.insufficientSat = true;
            satErr.neededSats = plan.deficitSats;
            throw satErr;
        }

        const inputs = [
            { txid: plan.normSelected.txid, vout: plan.normSelected.vout, value: plan.initialInSats },
            ...plan.chosenCardinals.map(c => ({ txid: c.txid, vout: c.vout, value: BigInt(c.value) }))
        ];

        const outputs = [
            { value: 0n, scriptPubKey: plan.runestoneScript },
            { value: MIN_SAFE_PACKET_SATS, scriptPubKey: plan.recipSpk }
        ];
        if (plan.hasNahChange) {
            outputs.push({ value: MIN_SAFE_PACKET_SATS, scriptPubKey: userSpk });
        }
        if (plan.hasBtcChangeOut) {
            outputs.push({ value: plan.remAfterChangeFee, scriptPubKey: userSpk });
        }

        const signedTx = await buildSignedTransaction({ mode, account, inputs, outputs });
        const isSelfSend = cleanRecip.toLowerCase() === account.address.trim().toLowerCase();
        const newNahUtxoObjects = [];

        if (isSelfSend) {
            newNahUtxoObjects.push({
                txid: signedTx.txid,
                vout: 1,
                outpoint: `${signedTx.txid}:1`,
                nah: Number(plan.sendBig),
                sats: Number(MIN_SAFE_PACKET_SATS),
                isPendingSplit: true
            });
        }
        if (plan.hasNahChange) {
            newNahUtxoObjects.push({
                txid: signedTx.txid,
                vout: 2,
                outpoint: `${signedTx.txid}:2`,
                nah: Number(plan.remainderNah),
                sats: Number(MIN_SAFE_PACKET_SATS),
                isPendingSplit: true
            });
        }

        const totalOutputsCount = outputs.length;
        const newBtcChangeObject = plan.hasBtcChangeOut
            ? {
                txid: signedTx.txid,
                vout: totalOutputsCount - 1,
                outpoint: `${signedTx.txid}:${totalOutputsCount - 1}`,
                value: Number(plan.remAfterChangeFee),
                isSessionChange: true,
                status: { confirmed: false }
            }
            : null;

        return {
            ...signedTx,
            actionType: "send_nah",
            recipientAddress: cleanRecip,
            sentNahAmount: Number(plan.sendBig),
            changeNahAmount: Number(plan.remainderNah),
            spentInputs: inputs.map(i => ({ txid: i.txid, vout: i.vout, outpoint: `${i.txid}:${i.vout}` })),
            createdPacketAmounts: newNahUtxoObjects.map(o => o.nah),
            newNahUtxoObjects,
            newBtcChangeObject
        };
    }

    async function buildBtcSendTransaction({ mode, account, recipientAddress, allNahUtxos = [], cardinalUtxos = [], sendSats, feeRateSatVb = 1 }) {
        const cleanRecip = String(recipientAddress || "").trim();
        if (!isValidBitcoinAddress(cleanRecip)) {
            throw new Error("Please enter a valid Bitcoin receiving address (bc1p... or bc1q...).");
        }
        const userSpk = addressToScriptPubKey(account.address);
        const plan = planBtcSendTransaction({
            mode,
            userSpk,
            recipientAddress: cleanRecip,
            allNahUtxos,
            cardinalUtxos,
            sendSats,
            feeRateSatVb
        });

        if (!plan.hasEnoughSat) {
            const satErr = new Error(`Need ~${plan.deficitSats.toLocaleString("en-US")} more spendable sats in your Basic sat Balance.`);
            satErr.insufficientSat = true;
            satErr.neededSats = plan.deficitSats;
            throw satErr;
        }

        const inputs = plan.chosenCardinals.map(c => ({ txid: c.txid, vout: c.vout, value: BigInt(c.value) }));
        const outputs = [{ value: plan.sendBig, scriptPubKey: plan.recipSpk }];
        if (plan.hasBtcChangeOut) {
            outputs.push({ value: plan.remAfterChangeFee, scriptPubKey: userSpk });
        }

        const signedTx = await buildSignedTransaction({ mode, account, inputs, outputs });
        const isSelfSend = cleanRecip.toLowerCase() === account.address.trim().toLowerCase();
        const sessionSatChanges = [];

        if (isSelfSend && Number(plan.sendBig) >= Number(MIN_BTC_CHANGE_SATS)) {
            sessionSatChanges.push({
                txid: signedTx.txid,
                vout: 0,
                outpoint: `${signedTx.txid}:0`,
                value: Number(plan.sendBig),
                isSessionChange: true,
                status: { confirmed: false }
            });
        }
        if (plan.hasBtcChangeOut) {
            sessionSatChanges.push({
                txid: signedTx.txid,
                vout: 1,
                outpoint: `${signedTx.txid}:1`,
                value: Number(plan.remAfterChangeFee),
                isSessionChange: true,
                status: { confirmed: false }
            });
        }

        return {
            ...signedTx,
            actionType: "send_sat",
            recipientAddress: cleanRecip,
            sentSatAmount: Number(plan.sendBig),
            spentInputs: inputs.map(i => ({ txid: i.txid, vout: i.vout, outpoint: `${i.txid}:${i.vout}` })),
            createdPacketAmounts: [],
            newNahUtxoObjects: [],
            newBtcChangeObject: sessionSatChanges
        };
    }

    // --- 13. STARTUP MATHEMATICAL SELF-TEST & 6-MODULE OFFLINE SHA-256 VERIFIER ---
    async function fetchAuditResourceWithTimeout(url, cacheMode = "no-store", timeoutMs = 5000) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            return await fetch(url, { cache: cacheMode, signal: ctrl.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async function hashFileUrlSha256(url, cacheKeyAlias = null) {
        if (!navigator.onLine) {
            if (cacheKeyAlias && CACHED_FILE_HASHES.has(cacheKeyAlias)) {
                return CACHED_FILE_HASHES.get(cacheKeyAlias);
            }
            if (CACHED_FILE_HASHES.has(url)) {
                return CACHED_FILE_HASHES.get(url);
            }
        }

        const candidateUrls = [url];
        if (cacheKeyAlias === "index.html") {
            const locPath = (typeof window !== "undefined" && window.location && window.location.pathname) ? window.location.pathname : "";
            if (locPath && !candidateUrls.includes(locPath)) candidateUrls.push(locPath);
            if (!candidateUrls.includes("index.html")) candidateUrls.push("index.html");
        }

        for (const candUrl of candidateUrls) {
            let res = null;
            if (navigator.onLine) {
                try { res = await fetchAuditResourceWithTimeout(candUrl, "no-store", 5000); } catch (e) {}
            }
            if (!res || !res.ok) {
                try { res = await fetchAuditResourceWithTimeout(candUrl, "force-cache", 3000); } catch (e) {}
            }
            if (!res || !res.ok) {
                try { res = await fetchAuditResourceWithTimeout(candUrl, "default", 3000); } catch (e) {}
            }
            if (res && res.ok) {
                const rawBytes = new Uint8Array(await res.arrayBuffer());
                const digest = await sha256(rawBytes);
                const result = { sha256: bytesToHex(digest), sizeBytes: rawBytes.length };
                CACHED_FILE_HASHES.set(candUrl, result);
                if (cacheKeyAlias) CACHED_FILE_HASHES.set(cacheKeyAlias, result);
                return result;
            }
        }

        if (cacheKeyAlias && CACHED_FILE_HASHES.has(cacheKeyAlias)) {
            return CACHED_FILE_HASHES.get(cacheKeyAlias);
        }
        for (const candUrl of candidateUrls) {
            if (CACHED_FILE_HASHES.has(candUrl)) return CACHED_FILE_HASHES.get(candUrl);
        }
        if (cacheKeyAlias === "index.html" && typeof document !== "undefined" && document.documentElement) {
            const domBytes = new TextEncoder().encode(document.documentElement.outerHTML);
            const domDigest = await sha256(domBytes);
            return { sha256: bytesToHex(domDigest), sizeBytes: domBytes.length };
        }
        throw new Error("Unable to read source file: " + url);
    }

    async function runStartupBtcSelfTest() {
        assertWebBtcSubtleReady();
        await getVerifiedWordlist();
        const testVectorPhrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
        const derived = await derivePublicAccountsOnly(testVectorPhrase, false);
        const expectedBip86 = "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr";
        const expectedBip84 = "bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu";
        if (derived.taproot.address !== expectedBip86 || !derived.segwit || derived.segwit.address !== expectedBip84) {
            throw new Error("FATAL CRYPTOGRAPHIC SELF-TEST FAILURE: BIP-86/84 vector mismatch!");
        }
        return true;
    }

    async function computeSelfCodeAuditHash() {
        const setupUrl = discoverScriptUrl("nah-wallet-setup.js", "nah-wallet-setup.js");
        const vaultUrl = discoverScriptUrl("nah-wallet-vault.js", "nah-wallet-vault.js");
        const styleUrl = discoverStyleUrl("nah-style.css", "nah-style.css");
        const explorerUrl = discoverScriptUrl("nah-explorer.js", "nah-explorer.js");
        const [walletAudit, setupAudit, vaultAudit, indexAudit, styleAudit, explorerAudit, selfTestOk] = await Promise.all([
            hashFileUrlSha256(SELF_SCRIPT_URL, "nah-wallet.js"),
            hashFileUrlSha256(setupUrl, "nah-wallet-setup.js"),
            hashFileUrlSha256(vaultUrl, "nah-wallet-vault.js"),
            hashFileUrlSha256("index.html", "index.html"),
            hashFileUrlSha256(styleUrl, "nah-style.css"),
            hashFileUrlSha256(explorerUrl, "nah-explorer.js"),
            runStartupBtcSelfTest()
        ]);
        return {
            walletUrl: SELF_SCRIPT_URL,
            setupUrl,
            vaultUrl,
            styleUrl,
            explorerUrl,
            sha256: walletAudit.sha256,
            sizeBytes: walletAudit.sizeBytes,
            setupSha256: setupAudit.sha256,
            setupSizeBytes: setupAudit.sizeBytes,
            vaultSha256: vaultAudit.sha256,
            vaultSizeBytes: vaultAudit.sizeBytes,
            indexSha256: indexAudit.sha256,
            indexSizeBytes: indexAudit.sizeBytes,
            styleSha256: styleAudit.sha256,
            styleSizeBytes: styleAudit.sizeBytes,
            explorerSha256: explorerAudit.sha256,
            explorerSizeBytes: explorerAudit.sizeBytes,
            pbkdf2Rounds: PBKDF2_ROUNDS_V26,
            bip39WordlistSha256: OFFICIAL_BIP39_SHA256,
            vectorsVerified: selfTestOk
        };
    }

    // Pre-warm BIP-39 dictionary & test vectors immediately; wait for DOMContentLoaded before hashing all 6 DOM script URLs
    runStartupBtcSelfTest()
        .then(() => {
            if (typeof document !== "undefined" && document.readyState === "loading") {
                document.addEventListener("DOMContentLoaded", () => {
                    computeSelfCodeAuditHash().catch(() => {});
                }, { once: true });
            } else {
                computeSelfCodeAuditHash().catch(() => {});
            }
        })
        .catch(e => console.error("Btc self-test notice:", e));

    const api = {
        escapeHtml,
        feedHumanEntropy,
        getHumanEntropyProgress,
        resetHumanEntropyPool,
        isOfflineReady,
        ensureWordlistReady: getVerifiedWordlist,
        matchBip39WordsByPrefix,
        getValidNextBip39Letters,
        sanitizeSeedInputString,
        parseStrictNahAmount,
        parseStrictSatAmount,
        isValidVaultObject,
        saveAndVerifyVaultStorage,
        normalizeUtxoOutpoint,
        hydrateVaultUtxos,
        clearSessionUtxoLocks,
        recordBroadcastedTxUtxoChanges,
        evaluatePasswordStrength,
        generateMnemonic12,
        rollFreshSeedQuizChallenge,
        getPendingWordsForPeek,
        verifyPendingSeedQuiz,
        verifyPendingSeedQuizDetailed,
        clearPendingSeed,
        finalizeColdWalletAddressAndWipe,
        validateMnemonic,
        derivePublicAccountsOnly,
        encryptSeedWithPassword,
        createAndEncryptPendingWallet,
        importAndEncryptWallet,
        decryptSeedWithPassword,
        unlockVaultToPublicAccounts,
        revealSeedWordsWithFreshPassword,
        isSessionUnlocked,
        lockSessionRamKey,
        refreshSessionTimeout,
        signDigestWithActiveSession,
        encodeNahRunestoneScript,
        addressToScriptPubKey,
        computeInputSighash,
        estimateNahSplitCost,
        estimateNahSendCost,
        computeMaxSendableSats,
        estimateBtcSendCost,
        buildSignedTransaction,
        buildNahSplitTransaction,
        buildNahSendTransaction,
        buildBtcSendTransaction,
        isValidBitcoinAddress,
        runStartupBtcSelfTest,
        computeSelfCodeAuditHash,
        bytesToHex,
        hexToBytes
    };

    Object.freeze(api);
    window.NahSovereignBtc = api;
})();

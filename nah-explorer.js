// ============================================================================
// NAH-EXPLORER.JS: IMMUTABLE INFRASTRUCTURE MODULE
// (Header, Stacker News, Market Cap, Explorer with Live Mempool & Est. 1st Conf, Timechain, Omni Converter, Footer)
// ============================================================================

(function () {
    const headerHtml = `
        <div class="terminal" style="margin-bottom: 0; padding-bottom: 20px; border-bottom: none; border-radius: 15px 15px 0 0;">
            <div class="title-container">
                <div class="title">NAH SOVEREIGN DIAMOND <span class="diamond">💎</span></div>
                <div class="slogan-1">digital diamond etched on digital gold</div>
            </div>
        </div>
    `

    const stackerBoxHtml = `
        <div class="info-text" style="font-size: 11px; text-align: center; margin-bottom: 20px; color: #0b4594; border: 2px dashed #0b4594; background: #e8f4f8; padding: 12px 6px; border-radius: 8px; font-weight: 700; width: 100%; box-sizing: border-box;">
            <strong style="white-space: nowrap;">nah-core Pruned Indexer (&lt;10MB) OPEN SOURCED:</strong> <br>
            <a href="https://stacker.news/items/1600596" target="_blank" style="color: #e76f51; text-decoration: underline; font-weight: 900; display: inline-block; margin-top: 6px; font-size: 12px;">https://stacker.news/items/1600596</a>
        </div>
    `;

    const bottomWidgetsHtml = `
        <!-- NAH MARKET CAP & TOKENOMICS -->
        <div class="sub-section">
            <div class="sub-title">NAH MARKET CAP &amp; TOKENOMICS</div>
            <div class="sub-row"><span class="label">MAX SUPPLY</span><span class="value">148.3 TRILLION nahs</span></div>
            <div class="sub-row"><span class="label">HELD BY SATOSHI NAKAMOTO</span><span class="value">63 TRILLION nahs</span></div>
            <div class="sub-row"><span class="label">MAX CIRCULATING SUPPLY</span><span class="value">85.3 TRILLION nahs</span></div>
            <div class="sub-row"><span class="label">MARKET CAP (btc)</span><span class="value" id="mcap-btc">LOADING...</span></div>
            <div class="sub-row"><span class="label">MARKET CAP (usd)</span><span class="value" id="mcap-usd">LOADING...</span></div>
            <div class="sub-row">
                <span class="label">LIST OF CURRENT NAH HODLERS (<span id="nah-holders-count">18</span>)</span>
                <span class="value"><a href="javascript:void(0)" onclick="toggleHoldersList()" id="holders-toggle-btn" style="color: #0b4594; font-weight: 900;">VIEW LIST ▼</a></span>
            </div>
        </div>

        <!-- BITCOIN SAT NAH SOVEREIGN EXPLORER -->
        <div class="converter-section" style="background: #fdf6d8; margin-bottom: 18px;">
            <div class="sub-title" style="margin-bottom: 8px;">🔍 BITCOIN SAT NAH SOVEREIGN EXPLORER</div>
            <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                <input type="text" id="wallet-search-input" placeholder="Paste Bitcoin Address or TxID" style="flex: 1; padding: 10px; border: 2px solid #0b4594; border-radius: 8px; font-family: 'Quicksand', sans-serif; font-size: 12px; font-weight: 700; color: #0b4594; outline: none; background: #ffffff;">
                <button onclick="lookupNahWallet()" style="background: #0b4594; color: #fceea7; border: 2px solid #0b4594; border-radius: 8px; padding: 0 14px; font-family: 'Quicksand', sans-serif; font-weight: 900; font-size: 12px; cursor: pointer;">SEARCH</button>
            </div>
            <div id="wallet-search-result" style="display: none; background: #ffffff; border: 2px solid #0b4594; border-radius: 8px; padding: 10px; font-size: 11px; font-weight: 700; color: #0b4594; word-break: break-all;"></div>

            <div id="holders-leaderboard" style="display: none; margin-top: 12px; background: #ffffff; border: 2px solid #0b4594; border-radius: 8px; padding: 10px; max-height: 300px; overflow-y: auto;">
                <div style="font-size: 11px; font-weight: 900; color: #e76f51; text-align: center; margin-bottom: 8px; text-transform: uppercase;">TAP ADDRESS TO VIEW HISTORY</div>
                <div id="holders-list-body" style="font-size: 11px; font-weight: 700;">LOADING...</div>
            </div>

            <div style="margin-top: 10px; padding-top: 8px; border-top: 1.5px dashed #e9c46a; display: flex; justify-content: space-between; align-items: center; font-size: 11px; font-weight: 900; color: #0b4594;">
                <span>TOTAL NAH TRANSACTIONS COUNT:</span>
                <span id="nah-total-tx-count" style="color: #e76f51; font-size: 12px;">609</span>
            </div>
        </div>

        <!-- BITCOIN TIMECHAIN LIVE BLOCKS (3 PENDING + 5 MINED BLOCKS) -->
        <div class="sub-section" style="background: #ffffff; margin-top: 0; margin-bottom: 18px; padding: 10px;">
            <div class="sub-title" style="font-size: 11px; margin-bottom: 6px;">⛓️ BITCOIN TIMECHAIN: 3 PENDING &amp; 5 MINED BLOCKS</div>
            <div id="block-ticker" class="mempool-strip">
                <div style="font-size: 10px; color: #888; text-align: center; width: 100%; padding: 6px;">Loading live blocks...</div>
            </div>
        </div>

        <!-- REAL-TIME OMNI CONVERTER (ĐẶT DƯỚI CÙNG, NGAY DƯỚI BITCOIN TIMECHAIN) -->
        <div class="converter-section" style="margin-bottom: 18px;">
            <div class="sub-title">REAL-TIME OMNI CONVERTER</div>
            <div class="converter-row">
                <span class="converter-label">vnd</span>
                <input type="number" step="any" id="conv-vnd" class="converter-input" style="color: #2a9d8f;" placeholder="0">
            </div>
            <div class="converter-row">
                <span class="converter-label">usd</span>
                <input type="number" step="any" id="conv-usd" class="converter-input" style="color: #e76f51;" placeholder="0">
            </div>
            <div class="converter-row">
                <span class="converter-label">btc</span>
                <input type="number" step="any" id="conv-btc" class="converter-input" style="color: #f4a261;" placeholder="0">
            </div>
            <div class="converter-row">
                <span class="converter-label">sat</span>
                <input type="number" step="any" id="conv-sat" class="converter-input" style="color: #0b4594;" placeholder="0">
            </div>
            <div class="converter-row">
                <span class="converter-label">nah</span>
                <input type="number" step="any" id="conv-nah" class="converter-input" style="color: #00ccff; text-shadow: 0 0 2px rgba(0, 204, 255, 0.4);" placeholder="0">
            </div>
        </div>

        <div class="info-text" style="font-size: 12px; font-weight: 700; text-align: center; margin-top: 10px;">
            * Nah Sovereign Diamond was created by Bemp Research Corporation. For more info visit our <a href="https://facebook.com/bempresearch" target="_blank" class="link-blue">Facebook</a> or <a href="https://www.linkedin.com/company/bemp-research-corporation" target="_blank" class="link-blue">LinkedIn</a>.
        </div>

        <div class="status" id="last-update" style="color: #888; font-size: 11px; text-align: right; margin-top: 15px; font-weight: bold;">CONNECTING...</div>
    `;

    const footerHtml = `
        <div class="secret-menu">
            <button class="secret-btn" onclick="openTab('tab-wp')">BRC WHITEPAPER</button>
            <button class="secret-btn" onclick="openTab('tab-bp')">BRC BLACKPAPER</button>
            <button class="secret-btn" onclick="openTab('tab-exhibit')">62ND EXHIBIT A</button>
        </div>
        <div class="footer">WEBSITE ĐƯỢC BẢO TRỢ BỞI MIN'S KITCHEN &amp; BRC</div>
    `;

    const hSlot = document.getElementById("nah-header-slot");
    if (hSlot) hSlot.innerHTML = headerHtml;

    const stSlot = document.getElementById("nah-stacker-slot");
    if (stSlot) stSlot.innerHTML = stackerBoxHtml;

    const botSlot = document.getElementById("nah-bottom-slot");
    if (botSlot) botSlot.innerHTML = bottomWidgetsHtml;

    const fSlot = document.getElementById("nah-footer-slot");
    if (fSlot) fSlot.innerHTML = footerHtml;
})();

const NAH_NODE_API = "https://api.nahkahmotors.com/api/v1";
const MEMPOOL_API = "https://mempool.space/api";

window.liveMempoolBlocks = [];
let currentLookupAddr = "";
let lastSeenSatTxid = "";
let loadedSatRawTxs = [];

function openTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
    document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.secret-btn').forEach(el => el.classList.remove('active'));
    
    const target = document.getElementById(tabId);
    if (target) target.style.display = 'flex';
    
    const btn = document.querySelector(`[onclick="openTab('${tabId}')"]`);
    if (btn) btn.classList.add('active');
}

function fmtUnit(n, singular, plural) {
    return Number(n) === 1 ? singular : plural;
}

function formatLocalDate(ts) {
    if (!ts) return "Confirmed";
    try {
        const d = new Date(ts * 1000);
        return d.toLocaleString([], { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    } catch(e) {
        return String(ts);
    }
}

function fmtFeeRate(v) {
    if (!v || v <= 0) return "0.1";
    return v < 1 ? v.toFixed(1) : Math.round(v).toString();
}

function estimateFirstConfWait(feeRateSatVb) {
    const rate = Number(feeRateSatVb || 0);
    const mp = window.liveMempoolBlocks || [];
    if (!mp || mp.length === 0) {
        return "~10 mins (Next Block)";
    }
    for (let i = 0; i < mp.length; i++) {
        const b = mp[i];
        const minF = (b.feeRange && b.feeRange.length) ? b.feeRange[0] : (b.medianFee || 0.1);
        const isNotFull = (i === 0 && (b.blockVSize || 0) < 980000);
        if (isNotFull || rate >= minF) {
            const mins = (i + 1) * 10;
            return i === 0 ? "~10 mins (Next Block)" : `~${mins} mins (${i + 1} Blocks)`;
        }
    }
    const maxWait = (mp.length + 1) * 10;
    return `~${maxWait}+ mins (Low Fee Queue)`;
}

async function loadBlockTicker() {
    try {
        const [mpRes, minedRes] = await Promise.all([
            fetch(`${MEMPOOL_API}/v1/fees/mempool-blocks`),
            fetch(`${MEMPOOL_API}/v1/blocks`)
        ]);
        const mpBlocks = await mpRes.json();
        const minedBlocks = await minedRes.json();

        if (Array.isArray(mpBlocks)) {
            window.liveMempoolBlocks = mpBlocks;
        }

        let pendingCards = [];
        for (let i = 2; i >= 0; i--) {
            const b = mpBlocks[i];
            const waitMin = (i + 1) * 10;
            if (b) {
                const minF = b.feeRange && b.feeRange.length ? fmtFeeRate(b.feeRange[0]) : fmtFeeRate(b.medianFee || 1);
                const maxF = b.feeRange && b.feeRange.length ? fmtFeeRate(b.feeRange[b.feeRange.length - 1]) : minF;
                pendingCards.push(`
                    <div class="mp-card pending">
                        <div style="font-size:8px; color:#f4a261; font-weight:900;">Pending ~${waitMin}m</div>
                        <div style="font-size:9px; color:#fff; font-weight:900; margin:2px 0;">${minF}–${maxF} sat/vB</div>
                        <div style="font-size:8px; color:#ccc;">${b.nTx.toLocaleString('en-US')} txs</div>
                    </div>
                `);
            } else {
                pendingCards.push(`
                    <div class="mp-card pending" style="opacity:0.65;">
                        <div style="font-size:8px; color:#f4a261; font-weight:900;">Pending ~${waitMin}m</div>
                        <div style="font-size:9px; color:#fff; font-weight:900; margin:2px 0;">~1 sat/vB</div>
                        <div style="font-size:8px; color:#ccc;">Open Queue</div>
                    </div>
                `);
            }
        }

        let minedCards = (minedBlocks || []).slice(0, 5).map(b => {
            const minsAgo = Math.max(1, Math.round((Date.now() / 1000 - b.timestamp) / 60));
            const medFee = b.extras && b.extras.medianFee ? fmtFeeRate(b.extras.medianFee) : "1";
            return `
                <div class="mp-card mined">
                    <div style="font-size:9px; color:#00ccff; font-weight:900;">#${b.height.toLocaleString('en-US')}</div>
                    <div style="font-size:9px; color:#fceea7; font-weight:900; margin:2px 0;">~${medFee} sat/vB</div>
                    <div style="font-size:8px; color:#aaa;">${minsAgo}m ago</div>
                </div>
            `;
        });

        document.getElementById("block-ticker").innerHTML = pendingCards.join("") + minedCards.join("");
    } catch(e) {
        console.error("Block ticker error:", e);
    }
}

async function syncNahCoreNode() {
    try {
        const res = await fetch(`${NAH_NODE_API}/status`);
        const data = await res.json();
        if (data.holders_count) {
            document.getElementById("nah-holders-count").innerText = data.holders_count;
        }
        if (data.indexed_nah_txs) {
            document.getElementById("nah-total-tx-count").innerText = data.indexed_nah_txs.toLocaleString('en-US');
        }
    } catch (e) {
        console.error("nah-core API sync error:", e);
    }
}

function shortAddress(addr) {
    if (!addr) return "";
    return addr.length > 20 ? addr.slice(0, 8) + "..." + addr.slice(-6) : addr;
}

async function toggleHoldersList() {
    const box = document.getElementById("holders-leaderboard");
    const btn = document.getElementById("holders-toggle-btn");
    if (box.style.display === "block") {
        box.style.display = "none";
        btn.innerText = "VIEW LIST ▼";
        return;
    }
    box.style.display = "block";
    btn.innerText = "HIDE LIST ▲";
    const body = document.getElementById("holders-list-body");
    body.innerHTML = "LOADING...";
    try {
        const res = await fetch(`${NAH_NODE_API}/holders`);
        const data = await res.json();
        body.innerHTML = data.holders.map(h => {
            let rawPct = (h.balance / 148300000000000) * 100;
            let pctStr = (h.balance > 0 && rawPct < 0.0001) ? "<0.0001%" : rawPct.toFixed(4) + "%";
            const unit = fmtUnit(h.balance, "nah", "nahs");
            return `<div style="display:flex; justify-content:space-between; align-items:center; gap:6px; padding:7px 0; border-bottom:1px dotted #e9c46a; cursor:pointer;" onclick="document.getElementById('wallet-search-input').value='${h.address}'; lookupNahWallet();">
                <span style="color:#0b4594; text-decoration:underline; white-space:nowrap;">#${h.rank} ${shortAddress(h.address)}</span>
                <span style="color:#e76f51; text-align:right; white-space:nowrap;">${h.balance.toLocaleString('en-US')} ${unit} (${pctStr})</span>
            </div>`;
        }).join("");
    } catch (e) {
        body.innerHTML = "Unable to load holder list.";
    }
}

function isDustOrSelfFeeOnly(tx, addr) {
    let sent = 0, recv = 0;
    (tx.vin || []).forEach(v => {
        if (v.prevout && v.prevout.scriptpubkey_address === addr) sent += (v.prevout.value || 0);
    });
    (tx.vout || []).forEach(v => {
        if (v.scriptpubkey_address === addr) recv += (v.value || 0);
    });
    const net = recv - sent;
    const fee = tx.fee || 0;

    if (net === 0) return true;
    if (Math.abs(net) <= 600) return true;
    if (net < 0 && Math.abs(net) <= (fee + 600)) return true;
    return false;
}

function renderSatTxsList(txs, addr) {
    const cleanTxs = txs.filter(tx => !isDustOrSelfFeeOnly(tx, addr));
    if (cleanTxs.length === 0) {
        return '<div style="color:#777; font-size:11px; padding:6px 0;">No sat transactions found for this address.</div>';
    }
    return cleanTxs.map(tx => {
        let sent = 0, recv = 0;
        (tx.vin || []).forEach(v => {
            if (v.prevout && v.prevout.scriptpubkey_address === addr) sent += (v.prevout.value || 0);
        });
        (tx.vout || []).forEach(v => {
            if (v.scriptpubkey_address === addr) recv += (v.value || 0);
        });
        const net = recv - sent;
        const isSent = net < 0;
        const amt = Math.abs(net);
        const badgeColor = isSent ? "#e76f51" : "#2a9d8f";
        const sign = isSent ? "-" : "+";
        const peerLabel = isSent ? "To" : "From";
        const txUnit = fmtUnit(amt, "sat", "sats");

        let peer = "Bitcoin Network";
        if (isSent) {
            const other = (tx.vout || []).find(v => v.scriptpubkey_address && v.scriptpubkey_address !== addr && (v.value || 0) > 600);
            const fallbackOther = (tx.vout || []).find(v => v.scriptpubkey_address && v.scriptpubkey_address !== addr);
            peer = other ? other.scriptpubkey_address : (fallbackOther ? fallbackOther.scriptpubkey_address : addr);
        } else {
            const other = (tx.vin || []).find(v => v.prevout && v.prevout.scriptpubkey_address && v.prevout.scriptpubkey_address !== addr && (v.prevout.value || 0) > 600);
            const fallbackOther = (tx.vin || []).find(v => v.prevout && v.prevout.scriptpubkey_address && v.prevout.scriptpubkey_address !== addr);
            peer = other ? other.prevout.scriptpubkey_address : (fallbackOther ? fallbackOther.prevout.scriptpubkey_address : "Coinbase / Network");
        }
        const canClickPeer = peer && !peer.includes("Network") && !peer.includes("Coinbase");
        const peerHtml = canClickPeer
            ? `<a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${peer}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(peer)}</a>`
            : `<span style="color:#777;">${peer}</span>`;

        const isConfirmed = Boolean(tx.status && tx.status.confirmed);
        const vsize = tx.weight ? (tx.weight / 4.0) : (tx.size || 1);
        const feeRate = tx.fee ? (tx.fee / vsize) : 0;
        const cleanRate = feeRate > 0 ? feeRate.toFixed(2).replace(/\.00$/, "") : "";

        const statusBadge = isConfirmed
            ? `<span style="color:${badgeColor}; font-weight:900;">${isSent ? 'SENT' : 'RECEIVED'}</span>`
            : `<span style="background:#f4a261; color:#111; padding:1px 5px; border-radius:4px; font-size:9px; font-weight:900; white-space:nowrap;">⏳ UNCONFIRMED / PENDING</span>`;

        const timeOrWaitHtml = isConfirmed
            ? `<span style="white-space:nowrap;">${formatLocalDate(tx.status.block_time)}</span>`
            : `<span style="color:#e76f51; font-weight:900; white-space:nowrap;">⏳ 1st conf: ${estimateFirstConfWait(feeRate)}</span>`;

        const feeStr = tx.fee
            ? `tx fee: ${tx.fee.toLocaleString('en-US')} sats${cleanRate ? ` (${cleanRate} sat/vB)` : ''}`
            : "";

        const rowStyle = isConfirmed
            ? "padding:7px 0; border-bottom:1px dotted #ccc; font-size:10px;"
            : "padding:8px; margin-bottom:6px; background:#fff3e0; border:2px dashed #f4a261; border-radius:6px; font-size:10px;";

        return `<div style="${rowStyle}">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                ${statusBadge}
                <span style="color:${badgeColor}; font-size:11px; font-weight:900; white-space:nowrap;">${sign}${amt.toLocaleString('en-US')} ${txUnit}</span>
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; color:#666; margin-bottom:2px;">
                <span style="white-space:nowrap;">${peerLabel}: ${peerHtml}</span>
                ${timeOrWaitHtml}
            </div>
            <div style="display:flex; justify-content:space-between; align-items:center; color:#888; font-size:9px;">
                <span>Tx: <a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${tx.txid}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${tx.txid.slice(0,8)}...${tx.txid.slice(-6)}</a></span>
                <span style="white-space:nowrap;">${feeStr}</span>
            </div>
        </div>`;
    }).join("");
}

async function loadMoreSatTxs() {
    if (!currentLookupAddr || !lastSeenSatTxid) return;
    const btn = document.getElementById("load-more-sat-btn");
    if (btn) btn.innerText = "LOADING OLDER TRANSACTIONS...";
    try {
        const res = await fetch(`${MEMPOOL_API}/address/${encodeURIComponent(currentLookupAddr)}/txs/chain/${lastSeenSatTxid}`);
        const more = res.ok ? await res.json() : [];
        if (Array.isArray(more) && more.length > 0) {
            loadedSatRawTxs = loadedSatRawTxs.concat(more);
            lastSeenSatTxid = more[more.length - 1].txid;
            document.getElementById("sat-tx-list-container").innerHTML = renderSatTxsList(loadedSatRawTxs, currentLookupAddr);
            if (more.length < 25 && btn) btn.style.display = "none";
            else if (btn) btn.innerText = "LOAD OLDER SAT TRANSACTIONS ▼";
        } else if (btn) {
            btn.style.display = "none";
        }
    } catch(e) {
        if (btn) btn.innerText = "LOAD OLDER SAT TRANSACTIONS ▼";
    }
}

async function lookupNahWallet() {
    const query = document.getElementById("wallet-search-input").value.trim();
    const resBox = document.getElementById("wallet-search-result");
    if (!query) return;
    resBox.style.display = "block";
    resBox.innerHTML = "LOADING DETAILS...";

    const btcUsd = window.globalLiveBtcPrice || 80000;

    if (/^[0-9a-fA-F]{64}$/.test(query)) {
        try {
            const txRes = await fetch(`${NAH_NODE_API}/tx/${query}`);
            const d = await txRes.json();
            if (!d || d.error) {
                resBox.innerHTML = "Transaction not found.";
                return;
            }

            const isConfirmed = Boolean(d.height && d.height > 0);
            const feeUsd = ((d.fee / 100000000) * btcUsd).toFixed(2);
            const cleanFeeRate = Number(d.fee_rate || 0).toFixed(2).replace(/\.00$/, "");
            const timeStr = isConfirmed ? formatLocalDate(d.ts) : `⏳ 1st conf: ${estimateFirstConfWait(d.fee_rate)}`;
            const blkStr = isConfirmed ? "#" + d.height.toLocaleString('en-US') : "⏳ Unconfirmed";
            const inputs = d.inputs || [];
            const outputs = d.outputs || [];

            const nahSenders = inputs.filter(i => i.nah > 0);
            const nahReceivers = outputs.filter(o => o.nah > 0);
            let nahSummaryHtml = "";
            if (nahReceivers.length > 0) {
                const fromAddr = nahSenders.length ? nahSenders[0].address : "NAH Protocol Genesis";
                const fromHtml = (!fromAddr.includes("Genesis"))
                    ? `<a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${fromAddr}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(fromAddr)}</a>`
                    : `<span>${fromAddr}</span>`;

                const externalReceivers = nahReceivers.filter(r => r.address !== fromAddr);
                const summaryTargets = externalReceivers.length > 0 ? externalReceivers : nahReceivers;

                nahSummaryHtml = summaryTargets.map(r => {
                    const isSelf = r.address === fromAddr;
                    const badge = !isConfirmed ? "⏳ UNCONFIRMED / 💎 PENDING" : (isSelf ? "💎 SPLIT / CONSOLIDATE" : "💎 SENT");
                    const badgeBg = !isConfirmed ? "#f4a261" : (isSelf ? "#2a9d8f" : "#e76f51");
                    const badgeCol = !isConfirmed ? "#111" : "#fff";
                    return `<div style="padding:6px; margin-bottom:4px; background:#ffffff; border:1.5px solid #0b4594; border-radius:6px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:2px;">
                            <span style="background:${badgeBg}; color:${badgeCol}; padding:1px 5px; border-radius:4px; font-size:8px; font-weight:900;">${badge}</span>
                            <span style="color:#0b4594; font-size:11px; font-weight:900; white-space:nowrap;">${r.nah.toLocaleString('en-US')} ${fmtUnit(r.nah, 'nah', 'nahs')}</span>
                        </div>
                        <div style="display:flex; justify-content:space-between; font-size:9px; color:#555;">
                            <span>From: ${fromHtml}</span>
                            <span>➔ To: <a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${r.address}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(r.address)}</a></span>
                        </div>
                    </div>`;
                }).join("");
            }

            const addrSatNet = {};
            inputs.forEach(i => { if (i.address) addrSatNet[i.address] = (addrSatNet[i.address] || 0) - (i.sats || 0); });
            outputs.forEach(o => { if (o.address) addrSatNet[o.address] = (addrSatNet[o.address] || 0) + (o.sats || 0); });
            const meaningfulSatMoves = Object.entries(addrSatNet).filter(([_, net]) => Math.abs(net) > 600 && !(net < 0 && Math.abs(net) <= (d.fee + 600)));
            let satSummaryHtml = "";
            if (meaningfulSatMoves.length > 0) {
                satSummaryHtml = meaningfulSatMoves.map(([a, net]) => {
                    const isGain = net > 0;
                    const col = isGain ? "#2a9d8f" : "#e76f51";
                    const sign = isGain ? "+" : "-";
                    return `<div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px dotted #ccc; font-size:10px;">
                        <a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${a}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(a)}</a>
                        <span style="color:${col}; font-weight:900; white-space:nowrap;">${sign}${Math.abs(net).toLocaleString('en-US')} sats</span>
                    </div>`;
                }).join("");
            }

            const inputsHtml = inputs.map(i => {
                const nahBadge = i.nah > 0
                    ? `<div style="margin-top:4px; margin-left:10px; padding:4px 8px; background:#111; border:1px solid #00ccff; border-radius:5px; color:#00ccff; font-size:9px; font-weight:900; display:flex; justify-content:space-between;">
                        <span>💎 NAH•SOVEREIGN•DIAMOND</span>
                        <span style="white-space:nowrap;">${i.nah.toLocaleString('en-US')} ${fmtUnit(i.nah, 'nah', 'nahs')}</span>
                       </div>`
                    : "";
                return `<div style="padding:6px 0; border-bottom:1px dotted #e9c46a;">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px;">
                        <span>➔ <a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${i.address}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(i.address)}</a></span>
                        <span style="color:#555; font-weight:900; white-space:nowrap;">${(i.sats || 0).toLocaleString('en-US')} sats</span>
                    </div>
                    ${nahBadge}
                </div>`;
            }).join("");

            const outputsHtml = outputs.map(o => {
                if (o.is_op_return) {
                    return `<div style="padding:6px 0; border-bottom:1px dotted #e9c46a; display:flex; justify-content:space-between; align-items:center; font-size:10px;">
                        <span style="background:#0b4594; color:#fceea7; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:900;">OP_RETURN: ${o.op_label}</span>
                        <span style="color:#777; white-space:nowrap;">0 sats</span>
                    </div>`;
                }
                const nahBadge = o.nah > 0
                    ? `<div style="margin-top:4px; margin-left:10px; padding:4px 8px; background:#111; border:1px solid #00ccff; border-radius:5px; color:#00ccff; font-size:9px; font-weight:900; display:flex; justify-content:space-between;">
                        <span>💎 NAH•SOVEREIGN•DIAMOND</span>
                        <span style="white-space:nowrap;">${o.nah.toLocaleString('en-US')} ${fmtUnit(o.nah, 'nah', 'nahs')}</span>
                       </div>`
                    : "";
                return `<div style="padding:6px 0; border-bottom:1px dotted #e9c46a;">
                    <div style="display:flex; justify-content:space-between; align-items:center; font-size:10px;">
                        <span><a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${o.address}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(o.address)}</a> ➔</span>
                        <span style="color:#2a9d8f; font-weight:900; white-space:nowrap;">${(o.sats || 0).toLocaleString('en-US')} sats</span>
                    </div>
                    ${nahBadge}
                </div>`;
            }).join("");

            const backBtn = currentLookupAddr
                ? `<div style="margin-bottom:8px;"><a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${currentLookupAddr}'; lookupNahWallet();" style="color:#0b4594; font-size:10px; font-weight:900; text-decoration:underline;">← BACK TO ADDRESS (${shortAddress(currentLookupAddr)})</a></div>`
                : "";

            resBox.innerHTML = `
                ${backBtn}
                <div style="background:#111; color:#fff; padding:10px; border-radius:8px; margin-bottom:10px; font-size:10px; box-sizing:border-box; width:100%; overflow:hidden;">
                    <div style="color:#00ccff; font-weight:900; margin-bottom:6px; word-break:break-all;">TXID: ${d.txid}</div>
                    <div style="border-top:1px solid #333; padding-top:6px; display:flex; flex-direction:column; gap:5px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                            <span><span style="color:#888;">Block:</span> <span style="color:${isConfirmed ? '#fceea7' : '#f4a261'}; font-weight:900;">${blkStr}</span></span>
                            <span><span style="color:#888;">${isConfirmed ? 'Time:' : ''}</span> <span style="color:#fceea7; font-weight:900;">${timeStr}</span></span>
                        </div>
                        <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px;">
                            <span><span style="color:#888;">Size / vSize:</span> <span style="color:#fff;">${d.size} B / ${d.vsize} vB</span></span>
                            <span><span style="color:#888;">Fee Rate:</span> <span style="color:#00ccff;">${cleanFeeRate} sat/vB</span></span>
                        </div>
                    </div>
                    <div style="border-top:1px dotted #333; margin-top:6px; padding-top:4px; text-align:right; color:#f4a261;">
                        Fee: ${d.fee.toLocaleString('en-US')} sats ($${feeUsd})
                    </div>
                </div>

                ${(nahSummaryHtml || satSummaryHtml) ? `
                <div style="background:#fdf6d8; border:1.5px solid #0b4594; border-radius:8px; padding:8px; margin-bottom:10px;">
                    <div style="font-size:10px; font-weight:900; color:#e76f51; text-transform:uppercase; margin-bottom:4px;">⚡ NET TRANSACTION SUMMARY</div>
                    ${nahSummaryHtml}
                    ${satSummaryHtml ? `<div style="margin-top:4px;"><div style="font-size:9px; color:#0b4594; font-weight:900;">Net sat change:</div>${satSummaryHtml}</div>` : ''}
                </div>` : ''}

                <div style="font-size:10px; font-weight:900; color:#0b4594; text-transform:uppercase; margin-bottom:4px;">
                    INPUTS &amp; OUTPUTS (${inputs.length} Inputs, ${outputs.length} Outputs)
                </div>
                <div style="background:#f8f9fa; border:1px solid #ccc; border-radius:6px; padding:8px; margin-bottom:8px;">
                    <div style="font-size:9px; color:#e76f51; font-weight:900; text-transform:uppercase; margin-bottom:2px;">INPUTS (FROM)</div>
                    ${inputsHtml}
                    <div style="font-size:9px; color:#2a9d8f; font-weight:900; text-transform:uppercase; margin-top:8px; margin-bottom:2px;">OUTPUTS (TO)</div>
                    ${outputsHtml}
                </div>
            `;
            return;
        } catch(e) {
            resBox.innerHTML = "Unable to load transaction details.";
            return;
        }
    }

    currentLookupAddr = query;
    try {
        const [nahRes, satInfoRes, satTxsRes] = await Promise.allSettled([
            fetch(`${NAH_NODE_API}/address/${encodeURIComponent(query)}`).then(r => r.ok ? r.json() : null),
            fetch(`${MEMPOOL_API}/address/${encodeURIComponent(query)}`).then(r => r.ok ? r.json() : null),
            fetch(`${MEMPOOL_API}/address/${encodeURIComponent(query)}/txs`).then(r => r.ok ? r.json() : [])
        ]);

        const nahData = (nahRes.status === "fulfilled" && nahRes.value) ? nahRes.value : { address: query, balance: 0, history: [] };
        const satInfo = (satInfoRes.status === "fulfilled" && satInfoRes.value) ? satInfoRes.value : null;
        loadedSatRawTxs = (satTxsRes.status === "fulfilled" && Array.isArray(satTxsRes.value)) ? satTxsRes.value : [];

        if (loadedSatRawTxs.length >= 25) {
            lastSeenSatTxid = loadedSatRawTxs[loadedSatRawTxs.length - 1].txid;
            try {
                const page2Res = await fetch(`${MEMPOOL_API}/address/${encodeURIComponent(query)}/txs/chain/${lastSeenSatTxid}`);
                const page2 = page2Res.ok ? await page2Res.json() : [];
                if (Array.isArray(page2) && page2.length > 0) {
                    loadedSatRawTxs = loadedSatRawTxs.concat(page2);
                    lastSeenSatTxid = page2[page2.length - 1].txid;
                }
            } catch(e) {}
        } else {
            lastSeenSatTxid = "";
        }

        const nahBal = nahData.balance || 0;
        const nahUnit = fmtUnit(nahBal, "nah", "nahs");
        let rawPct = (nahBal / 148300000000000) * 100;
        let pctTotal = (nahBal > 0 && rawPct < 0.0001) ? "<0.0001%" : rawPct.toFixed(6) + "%";

        let satBal = 0;
        let totalChainTxCount = loadedSatRawTxs.length;
        if (satInfo && satInfo.chain_stats) {
            const c = satInfo.chain_stats;
            const m = satInfo.mempool_stats || { funded_txo_sum: 0, spent_txo_sum: 0, tx_count: 0 };
            satBal = (c.funded_txo_sum - c.spent_txo_sum) + (m.funded_txo_sum - m.spent_txo_sum);
            totalChainTxCount = (c.tx_count || 0) + (m.tx_count || 0);
        }
        const satUnit = fmtUnit(satBal, "sat", "sats");

        const nahHistory = nahData.history || [];
        const unconfNahTxs = nahHistory.filter(t => t.confirmed === false || !t.height || t.height === 0);
        let pendingNahBanner = "";
        if (unconfNahTxs.length > 0) {
            let netPendingNah = 0;
            unconfNahTxs.forEach(t => {
                if (t.type === "RECEIVED") netPendingNah += (t.amount || 0);
                else if (t.type === "SENT") netPendingNah -= (t.amount || 0);
            });
            const signP = netPendingNah >= 0 ? "+" : "-";
            const pendingAmtStr = netPendingNah !== 0
                ? `${signP}${Math.abs(netPendingNah).toLocaleString('en-US')} ${fmtUnit(Math.abs(netPendingNah), 'nah', 'nahs')}`
                : `SPLIT / CONSOLIDATE`;
            pendingNahBanner = `<div style="margin-top:5px; padding:4px 8px; background:#2b1d0e; border:1px dashed #f4a261; border-radius:6px; color:#fceea7; font-size:10px; font-weight:900;">
                ⏳ PENDING (${unconfNahTxs.length}): ${pendingAmtStr}
            </div>`;
        }

        const nahHistoryHtml = nahHistory.map(tx => {
            const isConfirmed = !(tx.confirmed === false || !tx.height || tx.height === 0);
            const isSent = tx.type === "SENT";
            const badgeColor = isSent ? "#e76f51" : "#2a9d8f";
            const sign = isSent ? "-" : "+";
            const peerLabel = isSent ? "To" : "From";
            const txUnit = fmtUnit(tx.amount, "nah", "nahs");
            const canClickPeer = tx.counterparty && !tx.counterparty.includes("Protocol") && !tx.counterparty.includes("Genesis");
            const peerHtml = canClickPeer
                ? `<a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${tx.counterparty}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${shortAddress(tx.counterparty)}</a>`
                : `<span style="color:#555;">${tx.counterparty}</span>`;

            const cleanRate = tx.fee_rate ? Number(tx.fee_rate).toFixed(2).replace(/\.00$/, "") : "";
            const feeStr = tx.fee_sats
                ? `tx fee: ${tx.fee_sats.toLocaleString('en-US')} sats${cleanRate ? ` (${cleanRate} sat/vB)` : ''}`
                : "";

            const timeOrWaitHtml = isConfirmed
                ? `<span style="white-space:nowrap; color:#555;">${tx.ts ? formatLocalDate(tx.ts) : `Block #${tx.height}`}</span>`
                : `<span style="white-space:nowrap; color:#e76f51; font-weight:900;">⏳ 1st conf: ${estimateFirstConfWait(tx.fee_rate)}</span>`;

            const cardStyle = isConfirmed
                ? "padding:8px; margin-bottom:6px; background:#fdf6d8; border:2px solid #0b4594; border-radius:6px; font-size:10px;"
                : "padding:8px; margin-bottom:6px; background:#fff3e0; border:2px dashed #e76f51; border-radius:6px; font-size:10px;";

            const statusBadgeHtml = isConfirmed
                ? `<span style="background:${badgeColor}; color:#fff; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:900; white-space:nowrap;">💎 ${tx.type}</span>`
                : `<span style="background:#f4a261; color:#111; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:900; white-space:nowrap;">⏳ UNCONFIRMED / 💎 PENDING</span>`;

            return `<div style="${cardStyle}">
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:4px;">
                    ${statusBadgeHtml}
                    <span style="color:${badgeColor}; font-size:12px; font-weight:900; white-space:nowrap;">${sign}${tx.amount.toLocaleString('en-US')} ${txUnit}</span>
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; color:#0b4594; font-size:10px; margin-bottom:3px;">
                    <span style="white-space:nowrap;">${peerLabel}: ${peerHtml}</span>
                    ${timeOrWaitHtml}
                </div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; color:#666; font-size:9px; border-top:1px dashed #e9c46a; padding-top:3px;">
                    <span style="white-space:nowrap;">Tx: <a href="javascript:void(0)" onclick="document.getElementById('wallet-search-input').value='${tx.txid}'; lookupNahWallet();" style="color:#0b4594; text-decoration:underline;">${tx.txid.slice(0,8)}...${tx.txid.slice(-6)}</a></span>
                    <span style="white-space:nowrap;">${feeStr}</span>
                </div>
            </div>`;
        }).join("");

        const satHistoryHtml = renderSatTxsList(loadedSatRawTxs, query);
        const cleanSatCount = loadedSatRawTxs.filter(tx => !isDustOrSelfFeeOnly(tx, query)).length;
        const hasMoreSat = totalChainTxCount > loadedSatRawTxs.length && lastSeenSatTxid;

        resBox.innerHTML = `
            <div style="color:#0b4594; font-size:10px; margin-bottom:6px; word-break:break-all;">ADDRESS: <span style="color:#555;">${query}</span></div>
            <div style="background:#111111; border:2px solid #0b4594; border-radius:8px; padding:10px; margin-bottom:8px; text-align:center;">
                <div style="color:#00ccff; font-size:17px; font-weight:900; text-shadow:0 0 8px rgba(0,204,255,0.4);">💎 ${nahBal.toLocaleString('en-US')} ${nahUnit}</div>
                <div style="color:#2a9d8f; font-size:10px; margin-top:3px;">SHARE OF MAX SUPPLY: ${pctTotal}</div>
                ${pendingNahBanner}
            </div>
            <div style="color:#0b4594; font-size:12px; margin-bottom:12px; text-align:center;">sat balance: <span style="color:#f4a261; font-weight:900;">${satBal.toLocaleString('en-US')} ${satUnit}</span></div>

            <div style="color:#e76f51; font-size:11px; font-weight:900; margin-bottom:6px;">💎 nah transactions (${nahHistory.length})</div>
            <div style="max-height:240px; overflow-y:auto; margin-bottom:14px;">
                ${nahHistoryHtml || '<div style="color:#777; font-size:11px; padding:6px 0;">No nah transactions found for this address.</div>'}
            </div>

            <div style="color:#0b4594; font-size:11px; font-weight:900; border-top:2px solid #e9c46a; padding-top:10px; margin-bottom:4px;">sat transactions (${cleanSatCount})</div>
            <div id="sat-tx-list-container" style="max-height:200px; overflow-y:auto;">
                ${satHistoryHtml}
            </div>
            ${hasMoreSat ? `<button id="load-more-sat-btn" onclick="loadMoreSatTxs()" style="width:100%; margin-top:8px; padding:6px; background:#fdf6d8; border:1px solid #0b4594; border-radius:6px; color:#0b4594; font-family:'Quicksand',sans-serif; font-size:10px; font-weight:900; cursor:pointer;">LOAD OLDER SAT TRANSACTIONS ▼</button>` : ''}
        `;
    } catch (e) {
        resBox.innerHTML = "Unable to load address details right now.";
    }
}

function formatConvert(val, decimals) {
    let str = val.toFixed(decimals);
    if (str.includes('.')) { str = str.replace(/0+$/, '').replace(/\.$/, ''); }
    return str;
}

function setupOmniConverter() {
    const inputs = ['vnd', 'usd', 'btc', 'sat', 'nah'];
    inputs.forEach(currency => {
        const el = document.getElementById(`conv-${currency}`);
        if (!el) return;
        el.addEventListener('input', function(e) {
            if(e.target.value === '') {
                inputs.forEach(id => { if(id !== currency) document.getElementById(`conv-${id}`).value = ''; });
                return;
            }
            const val = parseFloat(e.target.value);
            if(isNaN(val)) return;

            const btc_usd = window.globalLiveBtcPrice || 80000;
            const usd_vnd = window.globalLiveVndRate || 25500;
            const btc_vnd = btc_usd * usd_vnd;
            const sat_nah = window.CURRENT_NAH_SATS || 0.0005; 

            let btc_val = 0;
            if(currency === 'vnd') btc_val = val / btc_vnd;
            if(currency === 'usd') btc_val = val / btc_usd;
            if(currency === 'btc') btc_val = val;
            if(currency === 'sat') btc_val = val / 100000000;
            if(currency === 'nah') btc_val = (val * sat_nah) / 100000000;

            const out_vnd = formatConvert(btc_val * btc_vnd, 2);
            const out_usd = formatConvert(btc_val * btc_usd, 6);
            const out_btc = formatConvert(btc_val, 10);
            const out_sat = formatConvert(btc_val * 100000000, 2);
            const out_nah = formatConvert((btc_val * 100000000) / sat_nah, 2);

            if(currency !== 'vnd') document.getElementById('conv-vnd').value = out_vnd;
            if(currency !== 'usd') document.getElementById('conv-usd').value = out_usd;
            if(currency !== 'btc') document.getElementById('conv-btc').value = out_btc;
            if(currency !== 'sat') document.getElementById('conv-sat').value = out_sat;
            if(currency !== 'nah') document.getElementById('conv-nah').value = out_nah;
        });
    });
}

async function bootExplorerInfrastructure() {
    setupOmniConverter();
    await Promise.all([ syncNahCoreNode(), loadBlockTicker() ]);
    setInterval(syncNahCoreNode, 60000);
    setInterval(loadBlockTicker, 30000);
}
bootExplorerInfrastructure();

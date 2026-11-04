// ============================================================================
// NAH-WALLET-VAULT.JS: DUAL-VAULT UTXO, SEND/SPLIT & 6-FILE AUDIT HUB (v26.0)
// Design Philosophy: Forever Immutable + Dual-Vault Isolation + Zero Trust
// ============================================================================

let isVaultSyncing = false;

function formatSatsToUsd(satsAmount) {
    const sats = Number(satsAmount || 0);
    const btcUsd = Number(window.globalLiveBtcPrice) || 80000;
    const usd = (sats / 100000000) * btcUsd;
    if (sats <= 0) return "$0.00";
    if (usd < 0.01) return "<$0.01";
    return "$" + usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function buildTimechainFeeHintHtml(feeRateSatVb) {
    const mp = window.liveMempoolBlocks || [];
    let pendingRangeStr = "~1 sat/vB";
    if (mp.length > 0 && mp[0]) {
        const b0 = mp[0];
        const minF = (b0.feeRange && b0.feeRange.length) ? fmtFeeRate(b0.feeRange[0]) : fmtFeeRate(b0.medianFee || 1);
        const maxF = (b0.feeRange && b0.feeRange.length) ? fmtFeeRate(b0.feeRange[b0.feeRange.length - 1]) : minF;
        pendingRangeStr = `${esc(minF)}–${esc(maxF)} sat/vB`;
    }
    const waitStr = (typeof estimateFirstConfWait === "function")
        ? esc(estimateFirstConfWait(feeRateSatVb || 1))
        : "~10 mins (Next Block)";
    return `<div style="font-size:8.5px; font-weight:700; color:#555; margin-bottom:7px; display:flex; justify-content:space-between; flex-wrap:wrap; gap:4px;">
        <span>⛓️ Next Pending Block: <strong style="color:#0b4594;">${pendingRangeStr}</strong></span>
        <span>⏳ Est. 1st conf: <strong style="color:#e76f51;">${waitStr}</strong></span>
    </div>`;
}

function viewTxInNahExplorer(txid) {
    const cleanTxid = String(txid || "").trim().replace(/[^0-9a-fA-F]/g, "");
    if (!cleanTxid) return;
    if (typeof closeEmergencyBackupBox === "function") closeEmergencyBackupBox();
    if (typeof resetAllPasswordVisibility === "function") resetAllPasswordVisibility();
    if (typeof openTab === "function") openTab("tab-nah");
    const allTabBtns = document.querySelectorAll(".tab-btn");
    allTabBtns.forEach(b => b.classList.remove("active"));
    const nahTabBtn = document.querySelector(".tab-btn[onclick*=\"'tab-nah'\"]");
    if (nahTabBtn) nahTabBtn.classList.add("active");
    const inp = document.getElementById("wallet-search-input");
    if (inp) {
        inp.value = cleanTxid;
        if (typeof lookupNahWallet === "function") lookupNahWallet();
        setTimeout(() => {
            try { inp.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
        }, 100);
    }
}

async function fetchAndHydrateAddressState(address, providerLabel, pubKey) {
    assertCoreModulesIntact(true);
    const [nahHttp, btcHttp] = await Promise.all([
        fetchWithTimeout(`${NAH_NODE_API}/address/${encodeURIComponent(address)}`),
        fetchWithTimeout(`${MEMPOOL_API}/address/${encodeURIComponent(address)}/utxo`)
    ]);

    if (!nahHttp.ok || !btcHttp.ok) {
        throw new Error("Dual-Vault Safety Gate: Waiting for both nah-core indexer and Bitcoin mempool node to respond cleanly.");
    }

    const nahData = await nahHttp.json();
    const rawBtcUtxos = await btcHttp.json();

    if (!nahData || !Array.isArray(nahData.utxos) || !Array.isArray(rawBtcUtxos)) {
        throw new Error("Invalid UTXO response format from node.");
    }

    let syncedHeight = getEffectiveNahSyncedHeight(nahData);
    if (!syncedHeight) {
        try {
            const stRes = await fetchWithTimeout(`${NAH_NODE_API}/status`, {}, 5000);
            if (stRes.ok) {
                const stData = await stRes.json();
                syncedHeight = getEffectiveNahSyncedHeight(stData);
            }
        } catch (e) {}
    }

    if (!PUBLIC_ACCOUNTS || !window.NahSovereignBtc.isSessionUnlocked()) {
        return null;
    }

    const hydrated = window.NahSovereignBtc.hydrateVaultUtxos(address, rawBtcUtxos, nahData.utxos, syncedHeight);
    const stateObj = {
        connected: true,
        providerName: providerLabel,
        address: address,
        publicKey: pubKey,
        nahBalance: hydrated.nahBalance,
        nahUtxos: hydrated.nahUtxos,
        cardinalUtxos: hydrated.cardinalUtxos,
        cardinalSats: hydrated.cardinalSats,
        unconfirmedSatSats: hydrated.unconfirmedSatSats || 0,
        selectedUtxo: null,
        cachedAt: Date.now()
    };
    ADDRESS_VAULT_CACHE[address] = stateObj;
    return stateObj;
}

function setVaultHeaderVisualMode(mode) {
    const btnTap = document.getElementById("btn-mode-taproot");
    const btnSeg = document.getElementById("btn-mode-segwit");
    const isTapOnly = Boolean(PUBLIC_ACCOUNTS && PUBLIC_ACCOUNTS.taprootOnly);
    if (btnSeg) {
        btnSeg.style.display = isTapOnly ? "none" : "inline-block";
    }
    if (btnTap && btnSeg) {
        btnTap.style.background = mode === "taproot" ? "#0b4594" : "#fdf6d8";
        btnTap.style.color = mode === "taproot" ? "#fceea7" : "#0b4594";
        btnSeg.style.background = mode === "segwit" ? "#0b4594" : "#fdf6d8";
        btnSeg.style.color = mode === "segwit" ? "#fceea7" : "#0b4594";
    }
    const modeBadge = document.getElementById("vault-storage-mode-badge");
    if (modeBadge) {
        modeBadge.innerText = IS_STATELESS_SESSION
            ? "🔥 ONE-TIME SESSION ONLY (WIPES WHEN LOCKED OR TAB CLOSES)"
            : "🔒 SAVED ENCRYPTED COOL VAULT (15M IDLE / 3M SCREEN-LOCK AUTO-GUARD)";
        modeBadge.style.color = IS_STATELESS_SESSION ? "#e76f51" : "#2a9d8f";
    }
}

function setScanningVaultPlaceholders() {
    const nahBalEl = document.getElementById("vault-nah-bal");
    const nahFiatEl = document.getElementById("vault-nah-fiat");
    const nahPktEl = document.getElementById("vault-nah-packets");
    const satBalEl = document.getElementById("vault-sat-bal");
    const satFiatEl = document.getElementById("vault-sat-fiat");
    const satPktEl = document.getElementById("vault-sat-packets");

    if (nahBalEl) nahBalEl.innerText = "...";
    if (nahFiatEl) nahFiatEl.innerText = "...";
    if (nahPktEl) nahPktEl.innerText = "Scanning packets...";
    if (satBalEl) satBalEl.innerText = "...";
    if (satFiatEl) satFiatEl.innerText = "...";
    if (satPktEl) satPktEl.innerText = "Scanning UTXOs...";
}

function setOfflineVaultPlaceholders() {
    const nahBalEl = document.getElementById("vault-nah-bal");
    const nahFiatEl = document.getElementById("vault-nah-fiat");
    const nahPktEl = document.getElementById("vault-nah-packets");
    const satBalEl = document.getElementById("vault-sat-bal");
    const satFiatEl = document.getElementById("vault-sat-fiat");
    const satPktEl = document.getElementById("vault-sat-packets");

    if (nahBalEl) nahBalEl.innerText = "✈️ OFFLINE";
    if (nahFiatEl) nahFiatEl.innerText = "Airplane Mode Active";
    if (nahPktEl) nahPktEl.innerText = "Turn OFF Airplane Mode to sync";
    if (satBalEl) satBalEl.innerText = "✈️ OFFLINE";
    if (satFiatEl) satFiatEl.innerText = "Airplane Mode Active";
    if (satPktEl) satPktEl.innerText = "Turn OFF Airplane Mode to sync";
}

function setErrorVaultPlaceholders() {
    const nahBalEl = document.getElementById("vault-nah-bal");
    const nahFiatEl = document.getElementById("vault-nah-fiat");
    const nahPktEl = document.getElementById("vault-nah-packets");
    const satBalEl = document.getElementById("vault-sat-bal");
    const satFiatEl = document.getElementById("vault-sat-fiat");
    const satPktEl = document.getElementById("vault-sat-packets");

    if (nahBalEl) nahBalEl.innerText = "⚠️ Sync Error";
    if (nahFiatEl) nahFiatEl.innerText = "Network unreachable";
    if (nahPktEl) nahPktEl.innerText = "Tap ↻ to retry";
    if (satBalEl) satBalEl.innerText = "⚠️ Sync Error";
    if (satFiatEl) satFiatEl.innerText = "Network unreachable";
    if (satPktEl) satPktEl.innerText = "Tap ↻ to retry";
}

async function autoSelectBestAddressAndLoad() {
    if (!PUBLIC_ACCOUNTS) return;
    const mySeq = ++walletLoadSeq;
    ACTIVE_ADDR_MODE = "taproot";
    isVaultSyncing = false;

    hideAllWalletScreens();
    setVaultHeaderVisualMode("taproot");
    const panel = document.getElementById("wallet-vault-panel");
    const listEl = document.getElementById("vault-utxo-list");
    const pagEl = document.getElementById("vault-utxo-pagination");
    const splitBox = document.getElementById("vault-splitter-box");
    if (panel) panel.style.display = "block";
    if (pagEl) pagEl.style.display = "none";
    if (splitBox) { splitBox.style.display = "none"; splitBox.innerHTML = ""; }

    document.getElementById("vault-addr-display").innerHTML = formatAddressWithChecksumHighlight(PUBLIC_ACCOUNTS.taproot.address);

    if (!navigator.onLine) {
        setOfflineVaultPlaceholders();
        await switchWalletAddressMode(ACTIVE_ADDR_MODE, true);
        showWalletNotice("✈️ Your Cool Wallet is safely locked! Turn OFF Airplane Mode and your balance will load automatically.");
        return;
    }

    setScanningVaultPlaceholders();

    if (PUBLIC_ACCOUNTS.taprootOnly || !PUBLIC_ACCOUNTS.segwit) {
        await switchWalletAddressMode("taproot", true);
        return;
    }

    isVaultSyncing = true;
    if (listEl) listEl.innerHTML = `<div style="font-size:10px; color:#888; text-align:center; padding:10px;">Loading UTXO packets...</div>`;

    try {
        const tapAcc = PUBLIC_ACCOUNTS.taproot;
        const segAcc = PUBLIC_ACCOUNTS.segwit;
        const [tapRes, segRes] = await Promise.allSettled([
            fetchAndHydrateAddressState(tapAcc.address, tapAcc.type, tapAcc.pubkeyHex),
            fetchAndHydrateAddressState(segAcc.address, segAcc.type, segAcc.pubkeyHex)
        ]);
        if (mySeq !== walletLoadSeq || !PUBLIC_ACCOUNTS || !window.NahSovereignBtc.isSessionUnlocked()) return;

        const tapState = tapRes.status === "fulfilled" ? tapRes.value : null;
        const segState = segRes.status === "fulfilled" ? segRes.value : null;

        if (!tapState && !segState) {
            isVaultSyncing = false;
            setErrorVaultPlaceholders();
            const errMsg = (tapRes.reason && tapRes.reason.message)
                ? tapRes.reason.message
                : "Unable to verify UTXO isolation right now. Please tap ↻ to retry.";
            if (listEl) {
                listEl.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center; padding:8px;">⚠️ ${esc(errMsg)}</div>`;
            }
            return;
        }

        const tapNah = tapState ? tapState.nahBalance : 0;
        const segNah = segState ? segState.nahBalance : 0;
        const tapSat = tapState ? tapState.cardinalSats : 0;
        const segSat = segState ? segState.cardinalSats : 0;

        if (segNah > tapNah || (tapNah === 0 && segNah === 0 && segSat > tapSat)) {
            ACTIVE_ADDR_MODE = "segwit";
        } else {
            ACTIVE_ADDR_MODE = "taproot";
        }
        const chosenAddr = PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE].address;
        await switchWalletAddressMode(ACTIVE_ADDR_MODE, !ADDRESS_VAULT_CACHE[chosenAddr]);
    } catch (e) {
        if (mySeq !== walletLoadSeq || !PUBLIC_ACCOUNTS || !window.NahSovereignBtc.isSessionUnlocked()) return;
        isVaultSyncing = false;
        setErrorVaultPlaceholders();
        if (listEl) {
            listEl.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center; padding:8px;">⚠️ ${esc(e.message || "Unable to verify UTXO isolation right now. Please tap ↻ to retry.")}</div>`;
        }
    }
}

async function switchWalletAddressMode(mode, forceNetworkRefresh = false) {
    if (!PUBLIC_ACCOUNTS) return;
    if (mode === "segwit" && (PUBLIC_ACCOUNTS.taprootOnly || !PUBLIC_ACCOUNTS.segwit)) {
        mode = "taproot";
    }
    ACTIVE_ADDR_MODE = mode;
    pendingSignedSplitTx = null;
    touchSessionActivity();
    setVaultHeaderVisualMode(mode);
    const acc = PUBLIC_ACCOUNTS[mode];
    await loadVaultForAddress(acc.address, acc.type, acc.pubkeyHex, forceNetworkRefresh);
}

function applyVaultStateToUI(stateObj) {
    if (!stateObj) return;
    isVaultSyncing = false;
    window.NAH_WALLET_STATE = stateObj;
    const nahBal = stateObj.nahBalance || 0;
    const nahUtxos = stateObj.nahUtxos || [];
    const cardinalSats = stateObj.cardinalSats || 0;
    const cardinalUtxos = stateObj.cardinalUtxos || [];
    const unconfSats = stateObj.unconfirmedSatSats || 0;

    document.getElementById("vault-nah-bal").innerText = `${nahBal.toLocaleString("en-US")} ${fmtUnit(nahBal, "nah", "nahs")}`;
    document.getElementById("vault-nah-packets").innerText = `${nahUtxos.length} ${fmtUnit(nahUtxos.length, "UTXO packet", "UTXO packets")}`;
    document.getElementById("vault-sat-bal").innerText = `${cardinalSats.toLocaleString("en-US")} ${fmtUnit(cardinalSats, "sat", "sats")}`;

    const nahSatsRate = Number(window.CURRENT_NAH_SATS) || 0.0005;
    const estNahSats = Math.round(nahBal * nahSatsRate);
    const nahFiatEl = document.getElementById("vault-nah-fiat");
    if (nahFiatEl) {
        nahFiatEl.innerText = `≈ ${estNahSats.toLocaleString("en-US")} sats (${formatSatsToUsd(estNahSats)})`;
    }
    const satFiatEl = document.getElementById("vault-sat-fiat");
    if (satFiatEl) {
        satFiatEl.innerText = `≈ ${formatSatsToUsd(cardinalSats)}`;
    }

    const satPacketsEl = document.getElementById("vault-sat-packets");
    if (satPacketsEl) {
        const baseText = `${cardinalUtxos.length} spendable ${fmtUnit(cardinalUtxos.length, "UTXO", "UTXOs")}`;
        satPacketsEl.innerText = unconfSats > 0
            ? `${baseText} (+${unconfSats.toLocaleString("en-US")} sats confirming)`
            : baseText;
    }

    renderNahPacketPage(window.currentPacketPage);
}

function renderNahPacketPage(pageIdx) {
    const state = window.NAH_WALLET_STATE;
    const listEl = document.getElementById("vault-utxo-list");
    const pagEl = document.getElementById("vault-utxo-pagination");
    if (!state || !listEl) return;

    const utxos = state.nahUtxos || [];
    const nahBal = state.nahBalance || 0;
    if (utxos.length === 0) {
        listEl.innerHTML = `<div style="font-size:10px; color:#777; text-align:center; padding:10px;">No nah UTXO packets found in this ${ACTIVE_ADDR_MODE.toUpperCase()} address.</div>`;
        if (pagEl) pagEl.style.display = "none";
        return;
    }

    const totalPages = Math.ceil(utxos.length / PACKETS_PER_PAGE);
    window.currentPacketPage = Math.max(0, Math.min(pageIdx, totalPages - 1));
    const start = window.currentPacketPage * PACKETS_PER_PAGE;
    const slice = utxos.slice(start, start + PACKETS_PER_PAGE);

    listEl.innerHTML = slice.map((u, i) => {
        const realIdx = start + i;
        const pctWallet = nahBal > 0 ? ((u.nah / nahBal) * 100).toFixed(2) + "%" : "100%";
        const isSelected = state.selectedUtxo && state.selectedUtxo.outpoint === u.outpoint;
        const borderCol = isSelected ? "#e76f51" : "#0b4594";
        const bgCol = isSelected ? "#fff3e0" : "#fdf6d8";
        let statusBadge = "";
        if (u.isPendingSplit) statusBadge = ` <span style="color:#f4a261;">[⏳ MEMPOOL]</span>`;
        else if (u.isConfirmingInMempool) statusBadge = ` <span style="color:#f4a261;">[⏳ CONFIRMING]</span>`;
        return `
            <div onclick="selectNahUtxoPacket(${realIdx})" style="padding:10px; margin-bottom:6px; background:${bgCol}; border:2px solid ${borderCol}; border-radius:8px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
                <span style="background:#111; color:#00ccff; padding:3px 7px; border-radius:5px; font-size:9px; font-weight:900; white-space:nowrap;">
                    PACKET #${realIdx + 1} (${pctWallet})${statusBadge}
                </span>
                <span style="color:#0b4594; font-size:12px; font-weight:900; white-space:nowrap;">
                    💎 ${u.nah.toLocaleString("en-US")} ${fmtUnit(u.nah, "nah", "nahs")}
                </span>
            </div>
        `;
    }).join("");

    if (pagEl) {
        if (totalPages > 1) {
            pagEl.style.display = "flex";
            const prevDisabled = window.currentPacketPage === 0;
            const nextDisabled = window.currentPacketPage >= totalPages - 1;
            pagEl.innerHTML = `
                <button onclick="renderNahPacketPage(${window.currentPacketPage - 1})" ${prevDisabled ? "disabled" : ""} style="background:${prevDisabled ? "#eee" : "#0b4594"}; color:${prevDisabled ? "#999" : "#fceea7"}; border:none; border-radius:5px; padding:4px 10px; font-family:'Quicksand',sans-serif; font-size:9px; font-weight:900; cursor:${prevDisabled ? "default" : "pointer"};">◀ PREV</button>
                <span>PAGE ${window.currentPacketPage + 1} / ${totalPages} (${utxos.length} PACKETS)</span>
                <button onclick="renderNahPacketPage(${window.currentPacketPage + 1})" ${nextDisabled ? "disabled" : ""} style="background:${nextDisabled ? "#eee" : "#0b4594"}; color:${nextDisabled ? "#999" : "#fceea7"}; border:none; border-radius:5px; padding:4px 10px; font-family:'Quicksand',sans-serif; font-size:9px; font-weight:900; cursor:${nextDisabled ? "default" : "pointer"};">NEXT ▶</button>
            `;
        } else {
            pagEl.style.display = "none";
        }
    }
}

async function loadVaultForAddress(address, providerLabel, pubKey, forceNetworkRefresh = false) {
    const mySeq = ++walletLoadSeq;
    isVaultSyncing = false;
    hideAllWalletScreens();
    const panel = document.getElementById("wallet-vault-panel");
    const listEl = document.getElementById("vault-utxo-list");
    const pagEl = document.getElementById("vault-utxo-pagination");
    const splitBox = document.getElementById("vault-splitter-box");
    if (panel) panel.style.display = "block";
    if (splitBox) { splitBox.style.display = "none"; splitBox.innerHTML = ""; }
    if (window.NAH_WALLET_STATE) window.NAH_WALLET_STATE.selectedUtxo = null;
    window.NAH_WALLET_STATE = null;

    document.getElementById("vault-addr-display").innerHTML = formatAddressWithChecksumHighlight(address);

    const cached = ADDRESS_VAULT_CACHE[address];
    if (cached) cached.selectedUtxo = null;
    if (!forceNetworkRefresh && cached && (Date.now() - (cached.cachedAt || 0) < CACHE_TTL_MS)) {
        applyVaultStateToUI(cached);
        return;
    }

    if (pagEl) pagEl.style.display = "none";

    if (!navigator.onLine) {
        if (cached) {
            applyVaultStateToUI(cached);
        } else {
            setOfflineVaultPlaceholders();
            if (listEl) {
                listEl.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center; padding:10px;">✈️ Your device is in Airplane Mode. Turn ON Wi-Fi/5G and your balance will load automatically.</div>`;
            }
        }
        return;
    }

    isVaultSyncing = true;
    setScanningVaultPlaceholders();
    if (listEl) listEl.innerHTML = `<div style="font-size:10px; color:#888; text-align:center; padding:10px;">Loading UTXO packets...</div>`;

    try {
        const stateObj = await fetchAndHydrateAddressState(address, providerLabel, pubKey);
        if (mySeq !== walletLoadSeq || !PUBLIC_ACCOUNTS || !window.NahSovereignBtc.isSessionUnlocked() || PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE].address !== address) {
            return;
        }
        isVaultSyncing = false;
        applyVaultStateToUI(stateObj);
    } catch (e) {
        if (mySeq !== walletLoadSeq || !PUBLIC_ACCOUNTS || !window.NahSovereignBtc.isSessionUnlocked() || PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE].address !== address) {
            return;
        }
        isVaultSyncing = false;
        setErrorVaultPlaceholders();
        if (listEl) {
            listEl.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center; padding:8px;">⚠️ ${esc(e.message || "Unable to verify UTXO isolation right now. Please tap ↻ to retry.")}</div>`;
        }
    }
}

function closeSplitPacketDrawer() {
    pendingSignedSplitTx = null;
    if (window.NAH_WALLET_STATE) window.NAH_WALLET_STATE.selectedUtxo = null;
    const splitBox = document.getElementById("vault-splitter-box");
    if (splitBox) { splitBox.style.display = "none"; splitBox.innerHTML = ""; }
    renderNahPacketPage(window.currentPacketPage);
}

function getSuggestedNetworkFeeRate() {
    const mp = window.liveMempoolBlocks || [];
    if (mp.length > 0 && mp[0].feeRange && mp[0].feeRange.length > 0) {
        return Math.min(100, Math.max(1, Math.ceil(Number(mp[0].feeRange[0]) || 1)));
    }
    return 1;
}

function getValidatedDrawerFeeRate(inputId = "split-feerate-input") {
    const feeRateEl = document.getElementById(inputId);
    if (!feeRateEl) return 1;
    const rawStr = String(feeRateEl.value || "").replace(/,/g, ".").trim();
    if (!rawStr) return null;
    const n = Number(rawStr);
    if (!Number.isFinite(n) || n < 0.1 || n > 500) return null;
    return n;
}

function setDrawerActionButtonEnabled(btnId, enabled) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    btn.disabled = !enabled;
    btn.style.opacity = enabled ? "1" : "0.5";
    btn.style.cursor = enabled ? "pointer" : "not-allowed";
}

// --- PACKET DRAWER: 📤 SEND nah & ✂️ SPLIT PACKET ---
function selectNahUtxoPacket(idx) {
    touchSessionActivity();
    pendingSignedSplitTx = null;
    const state = window.NAH_WALLET_STATE;
    const u = state && state.nahUtxos[idx];
    if (!u) return;
    if (state.selectedUtxo && state.selectedUtxo.outpoint === u.outpoint) {
        closeSplitPacketDrawer();
        return;
    }
    state.selectedUtxo = u;
    state.selectedIdx = idx;
    activePacketDrawerTab = "send";
    renderNahPacketPage(window.currentPacketPage);
    renderPacketDrawerShell();
}

function renderPacketDrawerShell() {
    const state = window.NAH_WALLET_STATE;
    const u = state && state.selectedUtxo;
    const idx = state ? state.selectedIdx : 0;
    const splitBox = document.getElementById("vault-splitter-box");
    if (!u || !splitBox) return;

    splitBox.style.display = "block";
    splitBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1.5px dashed #0b4594; padding-bottom:6px;">
            <span style="font-size:11px; font-weight:900; color:#0b4594;">
                📦 PACKET #${idx + 1}: <span style="color:#e76f51;">💎 ${u.nah.toLocaleString("en-US")} ${fmtUnit(u.nah, "nah", "nahs")}</span>
            </span>
            <span onclick="closeSplitPacketDrawer()" style="font-size:11px; font-weight:900; color:#e76f51; cursor:pointer; padding:0 4px;">✕</span>
        </div>
        <div class="drawer-mode-tabs">
            <button type="button" id="tab-btn-send-nah" class="drawer-mode-btn ${activePacketDrawerTab === "send" ? "active" : ""}" onclick="switchPacketDrawerTab('send')">📤 SEND nah</button>
            <button type="button" id="tab-btn-split-nah" class="drawer-mode-btn ${activePacketDrawerTab === "split" ? "active" : ""}" onclick="switchPacketDrawerTab('split')">✂️ SPLIT PACKET</button>
        </div>
        <div id="packet-action-workspace"></div>
    `;
    if (activePacketDrawerTab === "send") {
        openSendNahWorkspace();
    } else {
        openSplitPacketDrawer();
    }
}

function switchPacketDrawerTab(tabMode) {
    touchSessionActivity();
    pendingSignedSplitTx = null;
    activePacketDrawerTab = tabMode === "split" ? "split" : "send";
    const btnSend = document.getElementById("tab-btn-send-nah");
    const btnSplit = document.getElementById("tab-btn-split-nah");
    if (btnSend) btnSend.classList.toggle("active", activePacketDrawerTab === "send");
    if (btnSplit) btnSplit.classList.toggle("active", activePacketDrawerTab === "split");
    if (activePacketDrawerTab === "send") {
        openSendNahWorkspace();
    } else {
        openSplitPacketDrawer();
    }
}

function openSendNahWorkspace() {
    const u = window.NAH_WALLET_STATE && window.NAH_WALLET_STATE.selectedUtxo;
    const ws = document.getElementById("packet-action-workspace");
    if (!u || !ws) return;
    if (u.isPendingSplit || u.isConfirmingInMempool) {
        ws.innerHTML = `<div style="font-size:10px; color:#fceea7; background:#111111; border:1.5px dashed #f4a261; padding:8px; border-radius:6px; text-align:center;">⏳ This packet is waiting for block confirmation in the Bitcoin mempool (~10 mins).</div>`;
        return;
    }
    const defaultRate = getSuggestedNetworkFeeRate();
    const fullNahStr = BigInt(u.nah).toLocaleString("en-US");
    ws.innerHTML = `
        <div style="font-size:9.5px; font-weight:900; color:#0b4594; margin-bottom:3px;">
            Recipient Bitcoin Address (Taproot <strong>bc1p...</strong> or SegWit <strong>bc1q...</strong>):
        </div>
        <input type="text" id="send-nah-recip-input" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="sovereign-input" placeholder="Paste recipient bc1p... or bc1q... address" oninput="onSendNahInputUpdate()" style="font-size:10.5px; margin-bottom:5px;">
        <div id="send-nah-recip-verify" class="recip-verify-box" style="display:none;"></div>
        <div style="font-size:9.5px; font-weight:900; color:#0b4594; margin-bottom:3px;">
            Amount of <strong>nah</strong> to send (if less than 100%, remainder automatically returns to your wallet):
        </div>
        <div style="display:flex; gap:5px; margin-bottom:6px;">
            <input type="text" inputmode="numeric" maxlength="21" id="send-nah-amt-input" class="sovereign-input" value="${fullNahStr}" oninput="onSendNahAmountFormat(this)" style="font-size:12px; text-align:right; font-weight:900; flex:1;">
            <button type="button" class="max-amt-btn" onclick="fillMaxSendNahAmount()">MAX 100%</button>
        </div>
        <div id="send-nah-preview" style="background:#ffffff; border:1.5px solid #0b4594; border-radius:6px; padding:6px 8px; margin-bottom:6px; font-size:9.5px; font-weight:900; color:#0b4594;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:3px; font-size:9.5px; font-weight:900; color:#0b4594;">
            <span>Network Fee Rate (sat/vB):</span>
            <input type="text" inputmode="decimal" id="send-nah-feerate-input" class="sovereign-input" value="${defaultRate}" oninput="onSendNahInputUpdate()" style="width:75px; padding:5px 6px; font-size:10px; text-align:right;">
        </div>
        <div id="send-nah-timechain-hint"></div>
        <button type="button" id="btn-exec-send-nah" onclick="executeNahPacketSend()" style="width:100%; background:#0b4594; color:#fceea7; border:2px solid #0b4594; border-radius:8px; padding:9px; font-family:'Quicksand',sans-serif; font-size:10.5px; font-weight:900; cursor:pointer;">
            📤 SIGN &amp; SEND nah ON BITCOIN
        </button>
        <div id="split-tx-result" style="display:none; margin-top:6px; padding:6px; background:#111111; color:#00ccff; border-radius:6px; font-size:9px; word-break:break-all;"></div>
    `;
    onSendNahInputUpdate();
}

function fillMaxSendNahAmount() {
    touchSessionActivity();
    const u = window.NAH_WALLET_STATE && window.NAH_WALLET_STATE.selectedUtxo;
    const inp = document.getElementById("send-nah-amt-input");
    if (!u || !inp) return;
    inp.value = BigInt(u.nah).toLocaleString("en-US");
    onSendNahInputUpdate();
}

function onSendNahAmountFormat(inpEl) {
    touchSessionActivity();
    const digitsOnly = String(inpEl.value || "").replace(/\D/g, "").replace(/^0+/, "").slice(0, 14);
    inpEl.value = digitsOnly ? BigInt(digitsOnly).toLocaleString("en-US") : "";
    onSendNahInputUpdate();
}

function onSendNahInputUpdate() {
    pendingSignedSplitTx = null;
    const state = window.NAH_WALLET_STATE;
    const u = state && state.selectedUtxo;
    const recipEl = document.getElementById("send-nah-recip-input");
    const verEl = document.getElementById("send-nah-recip-verify");
    const amtEl = document.getElementById("send-nah-amt-input");
    const prevEl = document.getElementById("send-nah-preview");
    const hintEl = document.getElementById("send-nah-timechain-hint");
    const resBox = document.getElementById("split-tx-result");
    if (resBox) { resBox.style.display = "none"; resBox.innerHTML = ""; }
    if (!u || !prevEl) return;

    const feeRate = getValidatedDrawerFeeRate("send-nah-feerate-input");
    if (hintEl) hintEl.innerHTML = buildTimechainFeeHintHtml(feeRate || 1);

    const rawRecip = recipEl ? recipEl.value.trim() : "";
    const isAddrOk = window.NahSovereignBtc.isValidBitcoinAddress(rawRecip);
    const isSelfAddr = Boolean(isAddrOk && state.address && rawRecip.toLowerCase() === state.address.trim().toLowerCase());
    if (verEl) {
        if (rawRecip.length > 0 && isAddrOk) {
            verEl.style.display = "block";
            const selfWarn = isSelfAddr
                ? `<div style="color:#e76f51; margin-top:2px;">⚠️ Note: This is your own wallet address (Self-Transfer)!</div>`
                : "";
            verEl.innerHTML = `✓ Verify First &amp; Last 6 Chars: ${formatAddressWithChecksumHighlight(rawRecip)}${selfWarn}`;
        } else {
            verEl.style.display = "none";
            verEl.innerHTML = "";
        }
    }

    const sendBig = window.NahSovereignBtc.parseStrictNahAmount(amtEl ? amtEl.value : "");
    const totalBig = BigInt(u.nah);
    if (!sendBig || sendBig <= 0n || sendBig > totalBig) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Enter an amount between 1 and ${totalBig.toLocaleString("en-US")} nah.</span>`;
        setDrawerActionButtonEnabled("btn-exec-send-nah", false);
        return;
    }

    if (feeRate === null) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Enter a valid network fee rate between 0.1 and 500 sat/vB.</span>`;
        setDrawerActionButtonEnabled("btn-exec-send-nah", false);
        return;
    }

    const remBig = totalBig - sendBig;
    const est = window.NahSovereignBtc.estimateNahSendCost({
        mode: ACTIVE_ADDR_MODE,
        recipientAddress: isAddrOk ? rawRecip : "",
        selectedNahUtxo: u,
        allNahUtxos: state.nahUtxos,
        cardinalUtxos: state.cardinalUtxos,
        sendAmount: sendBig,
        feeRateSatVb: feeRate
    });

    const isFeeCapOk = Boolean(est && !est.exceedsMaxFeeCap);
    setDrawerActionButtonEnabled("btn-exec-send-nah", isAddrOk && isFeeCapOk);

    const changeLine = remBig > 0n
        ? `<div style="display:flex; justify-content:space-between; color:#0b4594;"><span>• Returned to Your Wallet (Change):</span><span>💎 ${remBig.toLocaleString("en-US")} ${fmtUnit(Number(remBig), "nah", "nahs")}</span></div>`
        : `<div style="display:flex; justify-content:space-between; color:#555; font-size:8.5px;"><span>• Full Packet Transfer:</span><span>100% of packet sent</span></div>`;

    const highFeeWarn = (feeRate > 20) ? ` <span style="color:#e76f51;">(⚠️ High fee rate)</span>` : "";
    const sub600Note = (est && est.sub600MergedSats > 0)
        ? ` (+${est.sub600MergedSats} sats sub-600 change merged)`
        : "";
    const costLine = est
        ? `<div style="border-top:1px dotted #ccc; margin-top:3px; padding-top:3px; display:flex; justify-content:space-between; font-size:8.5px; color:${(est.hasEnoughSat && !est.exceedsMaxFeeCap) ? "#2a9d8f" : "#e76f51"};">
               <span>⚡ Exact Miner Fee (${est.estVsize} vB):${highFeeWarn}</span>
               <span>${est.estMinerFeeSats.toLocaleString("en-US")} sats (≈ ${formatSatsToUsd(est.estMinerFeeSats)})${sub600Note}</span>
           </div>`
        : "";
    const feeCapWarn = (est && est.exceedsMaxFeeCap)
        ? `<div style="color:#e76f51; font-size:8.5px; margin-top:2px;">🚨 Safety Cap: Miner fee exceeds the 50,000-sat safety limit! Please lower your sat/vB rate.</div>`
        : "";
    const addrPrompt = !isAddrOk
        ? `<div style="color:#e76f51; font-size:8.5px; margin-top:2px;">👉 Paste a valid Bitcoin address (bc1p... or bc1q...) above to unlock Send.</div>`
        : "";

    prevEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; color:#2a9d8f;">
            <span>• Sending to Recipient:</span>
            <span>💎 ${sendBig.toLocaleString("en-US")} ${fmtUnit(Number(sendBig), "nah", "nahs")}</span>
        </div>
        ${changeLine}
        ${costLine}
        ${feeCapWarn}
        ${addrPrompt}
    `;
}

async function executeNahPacketSend() {
    touchSessionActivity();
    const state = window.NAH_WALLET_STATE;
    if (!state || !state.selectedUtxo || !PUBLIC_ACCOUNTS) return;
    const u = state.selectedUtxo;
    const recipEl = document.getElementById("send-nah-recip-input");
    const amtEl = document.getElementById("send-nah-amt-input");
    const resBox = document.getElementById("split-tx-result");
    const btn = document.getElementById("btn-exec-send-nah");
    if (btn && btn.disabled) return;

    const cleanRecip = recipEl ? recipEl.value.trim() : "";
    const sendBig = window.NahSovereignBtc.parseStrictNahAmount(amtEl ? amtEl.value : "");
    const feeRate = getValidatedDrawerFeeRate("send-nah-feerate-input");

    if (!window.NahSovereignBtc.isValidBitcoinAddress(cleanRecip)) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a valid Bitcoin address (bc1p... or bc1q...).</span>`; }
        return;
    }
    if (!sendBig || sendBig <= 0n || sendBig > BigInt(u.nah)) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a valid nah amount between 1 and ${u.nah.toLocaleString("en-US")}.</span>`; }
        return;
    }
    if (feeRate === null) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a network fee rate between 0.1 and 500 sat/vB.</span>`; }
        return;
    }

    await signAndBroadcastVaultTx({
        btnEl: btn,
        defaultBtnLabel: "📤 SIGN & SEND nah ON BITCOIN",
        buildFn: async (account) => await window.NahSovereignBtc.buildNahSendTransaction({
            mode: ACTIVE_ADDR_MODE,
            account,
            recipientAddress: cleanRecip,
            selectedNahUtxo: u,
            allNahUtxos: state.nahUtxos,
            cardinalUtxos: state.cardinalUtxos,
            sendAmount: sendBig,
            feeRateSatVb: feeRate
        })
    });
}

// --- PACKET DRAWER TAB 2: ✂️ SPLIT PACKET ---
function openSplitPacketDrawer() {
    touchSessionActivity();
    const u = window.NAH_WALLET_STATE && window.NAH_WALLET_STATE.selectedUtxo;
    const ws = document.getElementById("packet-action-workspace");
    if (!u || !ws) return;
    if (u.isPendingSplit || u.isConfirmingInMempool) {
        ws.innerHTML = `<div style="font-size:10px; color:#fceea7; background:#111111; border:1.5px dashed #f4a261; padding:8px; border-radius:6px; text-align:center;">⏳ This packet is currently waiting for block confirmation in the Bitcoin mempool (~10 mins).</div>`;
        return;
    }
    if (u.nah < 2) {
        ws.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center;">This packet only contains 1 nah and cannot be split smaller.</div>`;
        return;
    }
    activeEqualSplitCount = 2;
    const halfNah = (BigInt(u.nah) / 2n).toLocaleString("en-US");
    const defaultRate = getSuggestedNetworkFeeRate();
    const eqButtonsHtml = [2, 3, 4, 5].map(n => {
        const isPossible = u.nah >= n;
        const label = n === 2 ? "2 PACKETS (50/50)" : `${n} PACKETS`;
        return `<button type="button" id="btn-eq-${n}" class="preset-split-btn ${n === 2 ? "active" : ""}" ${isPossible ? `onclick="selectEqualSplitMode(${n})"` : "disabled"} style="${isPossible ? "" : "opacity:0.4; cursor:not-allowed;"}">${label}</button>`;
    }).join("");

    ws.innerHTML = `
        <div style="font-size:10px; font-weight:900; color:#0b4594; margin-bottom:4px;">
            ✂️ QUICK EQUAL SPLIT (IN 1 TRANSACTION):
        </div>
        <div style="display:flex; gap:4px; margin-bottom:8px;">
            ${eqButtonsHtml}
        </div>
        <div id="split-input-label" style="font-size:9.5px; font-weight:900; color:#0b4594; margin-bottom:3px;">
            Each packet receives (~equal 2-packet split — or type below for custom 2-packet split):
        </div>
        <input type="text" inputmode="numeric" maxlength="21" id="split-amt-input" class="sovereign-input" value="${halfNah}" oninput="onCustomSplitAmountInput(this)" style="font-size:12px; margin-bottom:6px; text-align:right; font-weight:900;">
        <div id="split-conservation-preview" style="background:#ffffff; border:1.5px solid #0b4594; border-radius:6px; padding:6px 8px; margin-bottom:6px; font-size:9.5px; font-weight:900; color:#0b4594;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:3px; font-size:9.5px; font-weight:900; color:#0b4594;">
            <span>Network Fee Rate (sat/vB):</span>
            <input type="text" inputmode="decimal" id="split-feerate-input" class="sovereign-input" value="${defaultRate}" oninput="updateSplitConservationPreview()" style="width:75px; padding:5px 6px; font-size:10px; text-align:right;">
        </div>
        <div id="split-nah-timechain-hint"></div>
        <button type="button" id="btn-exec-split" onclick="executeNahPacketSplit()" style="width:100%; background:#e76f51; color:#ffffff; border:2px solid #0b4594; border-radius:8px; padding:9px; font-family:'Quicksand',sans-serif; font-size:10.5px; font-weight:900; cursor:pointer;">
            ⚡ SIGN &amp; BROADCAST SPLIT ON BITCOIN
        </button>
        <div id="split-tx-result" style="display:none; margin-top:6px; padding:6px; background:#111111; color:#00ccff; border-radius:6px; font-size:9px; word-break:break-all;"></div>
    `;
    updateSplitConservationPreview();
}

function selectEqualSplitMode(count) {
    touchSessionActivity();
    const u = window.NAH_WALLET_STATE && window.NAH_WALLET_STATE.selectedUtxo;
    if (!u || u.nah < count) return;
    activeEqualSplitCount = count;
    [2, 3, 4, 5].forEach(n => {
        const b = document.getElementById(`btn-eq-${n}`);
        if (b) b.classList.toggle("active", n === count);
    });
    const lbl = document.getElementById("split-input-label");
    if (lbl) {
        lbl.innerText = `Each packet receives (~equal ${count}-packet split — or type below for custom 2-packet split):`;
    }
    const eachAmt = BigInt(u.nah) / BigInt(count);
    const inp = document.getElementById("split-amt-input");
    if (inp && eachAmt > 0n) {
        inp.value = eachAmt.toLocaleString("en-US");
    }
    updateSplitConservationPreview();
}

function onCustomSplitAmountInput(inpEl) {
    touchSessionActivity();
    activeEqualSplitCount = 0;
    [2, 3, 4, 5].forEach(n => {
        const b = document.getElementById(`btn-eq-${n}`);
        if (b) b.classList.remove("active");
    });
    const lbl = document.getElementById("split-input-label");
    if (lbl) {
        lbl.innerText = "Custom 2-Packet Split — Amount for Packet #1 (Packet #2 gets remainder):";
    }
    const digitsOnly = String(inpEl.value || "").replace(/\D/g, "").replace(/^0+/, "").slice(0, 14);
    inpEl.value = digitsOnly ? BigInt(digitsOnly).toLocaleString("en-US") : "";
    updateSplitConservationPreview();
}

function computeCurrentSplitEdictArray() {
    const u = window.NAH_WALLET_STATE && window.NAH_WALLET_STATE.selectedUtxo;
    if (!u) return null;
    const totalBig = BigInt(u.nah);

    if (activeEqualSplitCount >= 2 && activeEqualSplitCount <= 5) {
        const countBig = BigInt(activeEqualSplitCount);
        const piece = totalBig / countBig;
        if (piece <= 0n) return null;
        const splits = [];
        for (let i = 0; i < activeEqualSplitCount - 1; i++) {
            splits.push(piece);
        }
        return splits;
    }

    const inpEl = document.getElementById("split-amt-input");
    const parsed = window.NahSovereignBtc.parseStrictNahAmount(inpEl ? inpEl.value : "");
    if (!parsed || parsed <= 0n || parsed >= totalBig) return null;
    return [parsed];
}

function updateSplitConservationPreview() {
    pendingSignedSplitTx = null;
    const state = window.NAH_WALLET_STATE;
    const u = state && state.selectedUtxo;
    const prevEl = document.getElementById("split-conservation-preview");
    const hintEl = document.getElementById("split-nah-timechain-hint");
    const resBox = document.getElementById("split-tx-result");
    if (resBox) { resBox.style.display = "none"; resBox.innerHTML = ""; }
    if (!u || !prevEl) return;

    const feeRate = getValidatedDrawerFeeRate("split-feerate-input");
    if (hintEl) hintEl.innerHTML = buildTimechainFeeHintHtml(feeRate || 1);

    const splits = computeCurrentSplitEdictArray();
    if (!splits) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Enter a whole number between 1 and ${(u.nah - 1).toLocaleString("en-US")} nahs.</span>`;
        setDrawerActionButtonEnabled("btn-exec-split", false);
        return;
    }

    if (feeRate === null) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a valid network fee rate between 0.1 and 500 sat/vB.</span>`;
        setDrawerActionButtonEnabled("btn-exec-split", false);
        return;
    }

    const totalBig = BigInt(u.nah);
    const sumSplits = splits.reduce((acc, a) => acc + a, 0n);
    const remainder = totalBig - sumSplits;
    const allPackets = [...splits, remainder];

    const est = window.NahSovereignBtc.estimateNahSplitCost({
        mode: ACTIVE_ADDR_MODE,
        selectedNahUtxo: u,
        allNahUtxos: state.nahUtxos,
        cardinalUtxos: state.cardinalUtxos,
        splitAmounts: splits,
        feeRateSatVb: feeRate
    });

    const isFeeCapOk = Boolean(est && !est.exceedsMaxFeeCap);
    setDrawerActionButtonEnabled("btn-exec-split", isFeeCapOk);

    const rowsHtml = allPackets.map((amt, idx) => `
        <div style="display:flex; justify-content:space-between; color:${idx === allPackets.length - 1 ? "#0b4594" : "#2a9d8f"};">
            <span>• New Packet #${idx + 1}:</span>
            <span>💎 ${amt.toLocaleString("en-US")} ${fmtUnit(Number(amt), "nah", "nahs")}</span>
        </div>
    `).join("");

    const highFeeWarn = (feeRate > 20) ? ` <span style="color:#e76f51;">(⚠️ High fee rate)</span>` : "";
    const sub600Note = (est && est.sub600MergedSats > 0)
        ? ` (+${est.sub600MergedSats} sats sub-600 change merged)`
        : "";
    const costLine = est
        ? `<div style="display:flex; justify-content:space-between; font-size:8.5px; color:${(est.hasEnoughSat && !est.exceedsMaxFeeCap) ? "#2a9d8f" : "#e76f51"}; margin-top:2px;">
               <span>⚡ Exact Miner Fee (${est.estVsize} vB):${highFeeWarn}</span>
               <span>${est.estMinerFeeSats.toLocaleString("en-US")} sats (≈ ${formatSatsToUsd(est.estMinerFeeSats)})${sub600Note}</span>
           </div>`
        : "";
    const feeCapWarn = (est && est.exceedsMaxFeeCap)
        ? `<div style="color:#e76f51; font-size:8.5px; margin-top:2px;">🚨 Safety Cap: Miner fee exceeds the 50,000-sat safety limit! Please lower your sat/vB rate.</div>`
        : "";

    prevEl.innerHTML = `
        ${rowsHtml}
        <div style="border-top:1px dotted #ccc; margin-top:3px; padding-top:3px; display:flex; justify-content:space-between; font-size:8.5px; color:#555;">
            <span>✓ Total Preserved (100%):</span><span>${totalBig.toLocaleString("en-US")} nahs</span>
        </div>
        ${costLine}
        ${feeCapWarn}
    `;
}

async function executeNahPacketSplit() {
    touchSessionActivity();
    const state = window.NAH_WALLET_STATE;
    if (!state || !state.selectedUtxo || !PUBLIC_ACCOUNTS) return;
    const u = state.selectedUtxo;
    const splits = computeCurrentSplitEdictArray();
    const feeRate = getValidatedDrawerFeeRate("split-feerate-input");
    const resBox = document.getElementById("split-tx-result");
    const btn = document.getElementById("btn-exec-split");
    if (btn && btn.disabled) return;
    if (!splits || splits.length === 0) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a valid split amount smaller than the packet balance.</span>`; }
        return;
    }
    if (feeRate === null) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a network fee rate between 0.1 and 500 sat/vB.</span>`; }
        return;
    }

    await signAndBroadcastVaultTx({
        btnEl: btn,
        defaultBtnLabel: "⚡ SIGN & BROADCAST SPLIT ON BITCOIN",
        buildFn: async (account) => await window.NahSovereignBtc.buildNahSplitTransaction({
            mode: ACTIVE_ADDR_MODE,
            account,
            selectedNahUtxo: u,
            allNahUtxos: state.nahUtxos,
            cardinalUtxos: state.cardinalUtxos,
            splitAmounts: splits,
            feeRateSatVb: feeRate
        })
    });
}

// --- PURE BITCOIN (sat) SEND DRAWER (STRICTLY ISOLATED FROM nah PACKETS) ---
function openSendSatDrawer() {
    touchSessionActivity();
    pendingSignedSplitTx = null;
    const state = window.NAH_WALLET_STATE;
    const splitBox = document.getElementById("vault-splitter-box");
    if (!splitBox) return;

    if (!state) {
        splitBox.style.display = "block";
        const msg = !navigator.onLine
            ? "✈️ Your wallet is in Airplane Mode. Turn ON Wi-Fi/5G to sync your spendable sat UTXOs first."
            : (isVaultSyncing
                ? "⏳ Scanning UTXO packets... Please wait a moment and tap 📤 SEND sat again."
                : "⚠️ Network sync incomplete. Please tap ↻ above to reload your UTXOs first.");
        splitBox.innerHTML = `<div style="font-size:10px; color:#0b4594; text-align:center; padding:6px;">${msg}</div>`;
        return;
    }

    state.selectedUtxo = null;
    renderNahPacketPage(window.currentPacketPage);

    const availSats = state.cardinalSats || 0;
    if (availSats < 546) {
        splitBox.style.display = "block";
        splitBox.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1.5px dashed #0b4594; padding-bottom:6px;">
                <span style="font-size:11px; font-weight:900; color:#0b4594;">📤 SEND sat (BASIC sat BALANCE)</span>
                <span onclick="closeSplitPacketDrawer()" style="font-size:11px; font-weight:900; color:#e76f51; cursor:pointer; padding:0 4px;">✕</span>
            </div>
            <div style="font-size:9.5px; color:#0b4594; line-height:1.45; text-align:center; padding:4px;">
                ⚡ Your Basic sat Balance currently has <strong>${availSats.toLocaleString("en-US")} spendable sats</strong> (protected <strong>nah</strong> packets are never touched).<br>
                👉 Tap <strong>📋 COPY</strong> at the top of your wallet to deposit Bitcoin (e.g. 5,000–10,000 sats), wait 1 confirmation, then tap <strong>↻</strong>!
            </div>
        `;
        return;
    }

    const defaultRate = getSuggestedNetworkFeeRate();
    splitBox.style.display = "block";
    splitBox.innerHTML = `
        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px; border-bottom:1.5px dashed #0b4594; padding-bottom:6px;">
            <span style="font-size:11px; font-weight:900; color:#0b4594;">
                📤 SEND sat (AVAILABLE: <span style="color:#e76f51;">⚡ ${availSats.toLocaleString("en-US")} sats</span>)
            </span>
            <span onclick="closeSplitPacketDrawer()" style="font-size:11px; font-weight:900; color:#e76f51; cursor:pointer; padding:0 4px;">✕</span>
        </div>
        <div style="font-size:9.5px; font-weight:900; color:#0b4594; margin-bottom:3px;">
            Recipient Bitcoin Address (Taproot <strong>bc1p...</strong> or SegWit <strong>bc1q...</strong>):
        </div>
        <input type="text" id="send-sat-recip-input" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="sovereign-input" placeholder="Paste recipient bc1p... or bc1q... address" oninput="onSendSatInputUpdate()" style="font-size:10.5px; margin-bottom:5px;">
        <div id="send-sat-recip-verify" class="recip-verify-box" style="display:none;"></div>
        <div style="font-size:9.5px; font-weight:900; color:#0b4594; margin-bottom:3px;">
            Amount of <strong>sat</strong> to send (min 546 sats — protected <strong>nah</strong> packets are never touched):
        </div>
        <div style="display:flex; gap:5px; margin-bottom:6px;">
            <input type="text" inputmode="numeric" maxlength="18" id="send-sat-amt-input" class="sovereign-input" placeholder="Enter sats (e.g. 5,000) or tap MAX SATS" oninput="onSendSatAmountFormat(this)" style="font-size:12px; text-align:right; font-weight:900; flex:1;">
            <button type="button" class="max-amt-btn" onclick="fillMaxSendSatAmount()">MAX SATS</button>
        </div>
        <div id="send-sat-preview" style="background:#ffffff; border:1.5px solid #0b4594; border-radius:6px; padding:6px 8px; margin-bottom:6px; font-size:9.5px; font-weight:900; color:#0b4594;"></div>
        <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; margin-bottom:3px; font-size:9.5px; font-weight:900; color:#0b4594;">
            <span>Network Fee Rate (sat/vB):</span>
            <input type="text" inputmode="decimal" id="send-sat-feerate-input" class="sovereign-input" value="${defaultRate}" oninput="onSendSatInputUpdate()" style="width:75px; padding:5px 6px; font-size:10px; text-align:right;">
        </div>
        <div id="send-sat-timechain-hint"></div>
        <button type="button" id="btn-exec-send-sat" onclick="executeBtcSatSend()" style="width:100%; background:#0b4594; color:#fceea7; border:2px solid #0b4594; border-radius:8px; padding:9px; font-family:'Quicksand',sans-serif; font-size:10.5px; font-weight:900; cursor:pointer;">
            ⚡ SIGN &amp; SEND sat ON BITCOIN
        </button>
        <div id="split-tx-result" style="display:none; margin-top:6px; padding:6px; background:#111111; color:#00ccff; border-radius:6px; font-size:9px; word-break:break-all;"></div>
    `;
    onSendSatInputUpdate();
}

function fillMaxSendSatAmount() {
    touchSessionActivity();
    const state = window.NAH_WALLET_STATE;
    const inp = document.getElementById("send-sat-amt-input");
    const recipEl = document.getElementById("send-sat-recip-input");
    if (!state || !inp || !window.NahSovereignBtc) return;
    const feeRate = getValidatedDrawerFeeRate("send-sat-feerate-input") || 1;
    const maxSats = window.NahSovereignBtc.computeMaxSendableSats({
        mode: ACTIVE_ADDR_MODE,
        recipientAddress: recipEl ? recipEl.value.trim() : "",
        allNahUtxos: state.nahUtxos,
        cardinalUtxos: state.cardinalUtxos,
        feeRateSatVb: feeRate
    });
    inp.value = maxSats > 0 ? BigInt(maxSats).toLocaleString("en-US") : "";
    onSendSatInputUpdate();
}

function onSendSatAmountFormat(inpEl) {
    touchSessionActivity();
    const digitsOnly = String(inpEl.value || "").replace(/\D/g, "").replace(/^0+/, "").slice(0, 15);
    inpEl.value = digitsOnly ? BigInt(digitsOnly).toLocaleString("en-US") : "";
    onSendSatInputUpdate();
}

function onSendSatInputUpdate() {
    pendingSignedSplitTx = null;
    const state = window.NAH_WALLET_STATE;
    const recipEl = document.getElementById("send-sat-recip-input");
    const verEl = document.getElementById("send-sat-recip-verify");
    const amtEl = document.getElementById("send-sat-amt-input");
    const prevEl = document.getElementById("send-sat-preview");
    const hintEl = document.getElementById("send-sat-timechain-hint");
    const resBox = document.getElementById("split-tx-result");
    if (resBox) { resBox.style.display = "none"; resBox.innerHTML = ""; }
    if (!state || !prevEl) return;

    const feeRate = getValidatedDrawerFeeRate("send-sat-feerate-input");
    if (hintEl) hintEl.innerHTML = buildTimechainFeeHintHtml(feeRate || 1);

    const rawRecip = recipEl ? recipEl.value.trim() : "";
    const isAddrOk = window.NahSovereignBtc.isValidBitcoinAddress(rawRecip);
    const isSelfAddr = Boolean(isAddrOk && state.address && rawRecip.toLowerCase() === state.address.trim().toLowerCase());
    if (verEl) {
        if (rawRecip.length > 0 && isAddrOk) {
            verEl.style.display = "block";
            const selfWarn = isSelfAddr
                ? `<div style="color:#e76f51; margin-top:2px;">⚠️ Note: This is your own wallet address (Self-Transfer)!</div>`
                : "";
            verEl.innerHTML = `✓ Verify First &amp; Last 6 Chars: ${formatAddressWithChecksumHighlight(rawRecip)}${selfWarn}`;
        } else {
            verEl.style.display = "none";
            verEl.innerHTML = "";
        }
    }

    const rawAmtStr = amtEl ? amtEl.value.trim() : "";
    if (!rawAmtStr) {
        prevEl.innerHTML = `<span style="color:#0b4594;">👉 Enter the amount of sats to send above (min 546 sats) or tap <strong>MAX SATS</strong>.</span>`;
        setDrawerActionButtonEnabled("btn-exec-send-sat", false);
        return;
    }

    const sendBig = window.NahSovereignBtc.parseStrictSatAmount(rawAmtStr);
    if (!sendBig) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Enter a valid amount of at least 546 sats.</span>`;
        setDrawerActionButtonEnabled("btn-exec-send-sat", false);
        return;
    }

    if (feeRate === null) {
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Enter a valid network fee rate between 0.1 and 500 sat/vB.</span>`;
        setDrawerActionButtonEnabled("btn-exec-send-sat", false);
        return;
    }

    const est = window.NahSovereignBtc.estimateBtcSendCost({
        mode: ACTIVE_ADDR_MODE,
        recipientAddress: isAddrOk ? rawRecip : "",
        allNahUtxos: state.nahUtxos,
        cardinalUtxos: state.cardinalUtxos,
        sendSats: sendBig,
        feeRateSatVb: feeRate
    });

    const isFeeCapOk = Boolean(est && !est.exceedsMaxFeeCap);
    setDrawerActionButtonEnabled("btn-exec-send-sat", Boolean(isAddrOk && est && est.hasEnoughSat && isFeeCapOk));

    if (!est || !est.hasEnoughSat) {
        const needed = est ? est.deficitSats : Number(sendBig);
        prevEl.innerHTML = `<span style="color:#e76f51;">⚠️ Insufficient spendable sat balance (need ~${needed.toLocaleString("en-US")} more sats, or tap MAX SATS).</span>`;
        return;
    }

    if (est.exceedsMaxFeeCap) {
        prevEl.innerHTML = `<span style="color:#e76f51;">🚨 Safety Cap: Miner fee (${est.estMinerFeeSats.toLocaleString("en-US")} sats) exceeds the 50,000-sat safety limit! Please lower your sat/vB rate.</span>`;
        return;
    }

    const highFeeWarn = (feeRate > 20) ? ` <span style="color:#e76f51;">(⚠️ High fee rate)</span>` : "";
    const changeText = est.hasBtcChangeOut
        ? `${Number(est.remAfterChangeFee).toLocaleString("en-US")} sats returned to your wallet`
        : (est.sub600MergedSats > 0
            ? `0 sats (+${est.sub600MergedSats} sats sub-600 remainder merged to fee — or tap MAX SATS)`
            : `0 sats (exact sweep — no change output)`);
    const addrPrompt = !isAddrOk
        ? `<div style="color:#e76f51; font-size:8.5px; margin-top:2px;">👉 Paste a valid Bitcoin address (bc1p... or bc1q...) above to unlock Send.</div>`
        : "";

    prevEl.innerHTML = `
        <div style="display:flex; justify-content:space-between; color:#2a9d8f;">
            <span>• Sending to Recipient:</span>
            <span>⚡ ${sendBig.toLocaleString("en-US")} sats (≈ ${formatSatsToUsd(Number(sendBig))})</span>
        </div>
        <div style="display:flex; justify-content:space-between; color:#0b4594; font-size:8.5px;">
            <span>• Change Back to Wallet:</span>
            <span>${changeText}</span>
        </div>
        <div style="border-top:1px dotted #ccc; margin-top:3px; padding-top:3px; display:flex; justify-content:space-between; font-size:8.5px; color:#2a9d8f;">
            <span>⚡ Exact Miner Fee (${est.estVsize} vB):${highFeeWarn}</span>
            <span>${est.estMinerFeeSats.toLocaleString("en-US")} sats (≈ ${formatSatsToUsd(est.estMinerFeeSats)})</span>
        </div>
        ${addrPrompt}
    `;
}

async function executeBtcSatSend() {
    touchSessionActivity();
    const state = window.NAH_WALLET_STATE;
    if (!state || !PUBLIC_ACCOUNTS) return;
    const recipEl = document.getElementById("send-sat-recip-input");
    const amtEl = document.getElementById("send-sat-amt-input");
    const resBox = document.getElementById("split-tx-result");
    const btn = document.getElementById("btn-exec-send-sat");
    if (btn && btn.disabled) return;

    const cleanRecip = recipEl ? recipEl.value.trim() : "";
    const sendBig = window.NahSovereignBtc.parseStrictSatAmount(amtEl ? amtEl.value : "");
    const feeRate = getValidatedDrawerFeeRate("send-sat-feerate-input");
    if (!window.NahSovereignBtc.isValidBitcoinAddress(cleanRecip)) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a valid Bitcoin address (bc1p... or bc1q...).</span>`; }
        return;
    }
    if (!sendBig) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter at least 546 sats to send.</span>`; }
        return;
    }
    if (feeRate === null) {
        if (resBox) { resBox.style.display = "block"; resBox.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter a network fee rate between 0.1 and 500 sat/vB.</span>`; }
        return;
    }

    await signAndBroadcastVaultTx({
        btnEl: btn,
        defaultBtnLabel: "⚡ SIGN & SEND sat ON BITCOIN",
        buildFn: async (account) => await window.NahSovereignBtc.buildBtcSendTransaction({
            mode: ACTIVE_ADDR_MODE,
            account,
            recipientAddress: cleanRecip,
            allNahUtxos: state.nahUtxos,
            cardinalUtxos: state.cardinalUtxos,
            sendSats: sendBig,
            feeRateSatVb: feeRate
        })
    });
}

// --- UNIFIED SIGN, BROADCAST, RETRY & RECEIPT RENDERER ---
async function signAndBroadcastVaultTx({ btnEl, defaultBtnLabel, buildFn }) {
    const state = window.NAH_WALLET_STATE;
    const resBox = document.getElementById("split-tx-result");
    if (!state || !PUBLIC_ACCOUNTS) return;

    let signed = null;
    try {
        assertCoreModulesIntact(true);
        if (btnEl) { btnEl.disabled = true; btnEl.innerText = "🔐 SIGNING IN ~3ms RAM..."; }
        const account = PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE];
        signed = await buildFn(account);
        pendingSignedSplitTx = signed;

        if (!navigator.onLine) {
            if (resBox) {
                resBox.style.display = "block";
                resBox.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
                        <span style="color:#fceea7;">✈️ OFFLINE SIGNED TX (${signed.vsize} vB | Fee: ${signed.feeSats} sats)</span>
                        <div style="display:flex; gap:4px;">
                            <button type="button" class="raw-hex-action-btn" onclick="copySignedRawHex(this)">📋 COPY SIGNED HEX</button>
                            <button type="button" class="raw-hex-action-btn" onclick="retryBroadcastSignedTx(this)">📡 BROADCAST WHEN ONLINE</button>
                        </div>
                    </div>
                    <div style="background:#222; padding:4px; border-radius:4px; color:#2a9d8f; user-select:all;">${esc(signed.rawHex)}</div>
                `;
            }
            if (btnEl) { btnEl.disabled = false; btnEl.innerText = defaultBtnLabel; }
            return;
        }

        if (resBox) {
            resBox.style.display = "block";
            resBox.innerHTML = "📡 Broadcasting signed transaction to Bitcoin network...";
        }
        const bRes = await fetchWithTimeout(`${MEMPOOL_API}/tx`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: signed.rawHex
        });
        if (!bRes.ok) {
            const errTxt = (await bRes.text()).slice(0, 140);
            throw new Error("Broadcast rejected: " + errTxt);
        }
        const rawBroadcastResp = (await bRes.text()).trim();
        const broadcastedTxid = /^[0-9a-f]{64}$/i.test(rawBroadcastResp) ? rawBroadcastResp.toLowerCase() : signed.txid;

        finalizeBroadcastedTxUI(account, state, signed, broadcastedTxid);
    } catch (e) {
        if (!window.NahSovereignBtc || !window.NahSovereignBtc.isSessionUnlocked()) {
            showWalletNotice("🔒 " + esc(e.message || "Wallet session expired. Please unlock with your password."));
            return;
        }
        if (resBox) {
            resBox.style.display = "block";
            if (e && e.insufficientSat) {
                resBox.innerHTML = `
                    <div style="color:#f4a261; font-weight:900; margin-bottom:3px;">⚡ NEED ~${(e.neededSats || 1500).toLocaleString("en-US")} MORE SATS</div>
                    <div style="color:#eee; line-height:1.45;">
                        Bitcoin transactions require a small amount of confirmed sats in your Basic sat Balance.<br>
                        👉 Tap <strong>📋 COPY</strong> at the top of your wallet, send some Bitcoin (e.g. 5,000–10,000 sats) to your address, wait 1 confirmation, then tap <strong>↻</strong>!
                    </div>
                `;
            } else if (signed && signed.rawHex) {
                resBox.innerHTML = `
                    <div style="color:#e76f51; margin-bottom:4px;">❌ ${esc(e.message || e)}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
                        <span style="color:#fceea7;">Signed Tx Ready (${signed.vsize} vB | Fee: ${signed.feeSats} sats):</span>
                        <div style="display:flex; gap:4px;">
                            <button type="button" class="raw-hex-action-btn" onclick="retryBroadcastSignedTx(this)">📡 RETRY BROADCAST</button>
                            <button type="button" class="raw-hex-action-btn" onclick="copySignedRawHex(this)">📋 COPY SIGNED HEX</button>
                        </div>
                    </div>
                    <div style="background:#222; padding:4px; border-radius:4px; color:#2a9d8f; user-select:all;">${esc(signed.rawHex)}</div>
                `;
            } else {
                resBox.innerHTML = `<span style="color:#e76f51;">❌ ${esc(e.message || e)}</span>`;
            }
        }
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = defaultBtnLabel; }
    }
}

function finalizeBroadcastedTxUI(account, state, signed, broadcastedTxid) {
    pendingSignedSplitTx = null;
    window.NahSovereignBtc.recordBroadcastedTxUtxoChanges(
        account.address,
        signed.spentInputs,
        signed.newNahUtxoObjects,
        signed.newBtcChangeObject
    );

    if (signed.recipientAddress && signed.recipientAddress.toLowerCase() !== account.address.toLowerCase()) {
        Object.keys(ADDRESS_VAULT_CACHE).forEach(k => {
            if (k.toLowerCase() === signed.recipientAddress.toLowerCase()) {
                delete ADDRESS_VAULT_CACHE[k];
            }
        });
    }

    const spentSet = new Set(signed.spentInputs.map(i => i.outpoint));
    state.nahUtxos = [
        ...(signed.newNahUtxoObjects || []),
        ...state.nahUtxos.filter(item => !spentSet.has(item.outpoint))
    ];
    state.nahBalance = state.nahUtxos.reduce((acc, item) => acc + (item.nah || 0), 0);
    state.cardinalUtxos = state.cardinalUtxos.filter(item => !spentSet.has(item.outpoint));

    const btcChanges = Array.isArray(signed.newBtcChangeObject)
        ? signed.newBtcChangeObject
        : (signed.newBtcChangeObject ? [signed.newBtcChangeObject] : []);
    for (const chObj of btcChanges) {
        if (chObj && Number(chObj.value) >= 600) {
            state.cardinalUtxos.push(chObj);
        }
    }

    state.cardinalUtxos.sort((a, b) => (a.value || 0) - (b.value || 0));
    state.cardinalSats = state.cardinalUtxos.reduce((acc, item) => acc + (item.value || 0), 0);
    state.selectedUtxo = null;
    state.cachedAt = Date.now();
    window.currentPacketPage = 0;
    ADDRESS_VAULT_CACHE[account.address] = state;
    applyVaultStateToUI(state);

    const safeTxid = esc(broadcastedTxid);
    const splitBox = document.getElementById("vault-splitter-box");
    if (!splitBox) return;

    let summaryLine = "";
    if (signed.actionType === "send_nah") {
        const chTxt = signed.changeNahAmount > 0 ? ` (+ ${signed.changeNahAmount.toLocaleString("en-US")} nah change returned to your wallet)` : "";
        summaryLine = `<div>• Sent to Recipient: <strong>💎 ${signed.sentNahAmount.toLocaleString("en-US")} ${fmtUnit(signed.sentNahAmount, "nah", "nahs")}</strong>${chTxt}</div>`;
    } else if (signed.actionType === "send_sat") {
        summaryLine = `<div>• Sent to Recipient: <strong>⚡ ${signed.sentSatAmount.toLocaleString("en-US")} sats</strong> (≈ ${formatSatsToUsd(signed.sentSatAmount)})</div>`;
    } else {
        summaryLine = `<div>• Created Packets: <strong>${signed.createdPacketAmounts.map(a => a.toLocaleString("en-US") + " " + fmtUnit(a, "nah", "nahs")).join(" + ")}</strong></div>`;
    }

    splitBox.style.display = "block";
    splitBox.innerHTML = `
        <div style="background:#111111; color:#00ccff; border:1.5px solid #2a9d8f; border-radius:8px; padding:10px; font-size:9.5px; word-break:break-all; line-height:1.5;">
            <div style="color:#2a9d8f; font-weight:900; font-size:10.5px; margin-bottom:4px;">✅ TRANSACTION BROADCASTED &amp; VAULT UPDATED!</div>
            ${summaryLine}
            <div>• Exact Network Fee: <strong>${signed.feeSats.toLocaleString("en-US")} sats</strong> (≈ ${formatSatsToUsd(signed.feeSats)} • ${signed.vsize} vB)</div>
            <div style="margin-bottom:6px;">• Live Mempool TxID: <a href="https://mempool.space/tx/${safeTxid}" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline; font-weight:900;">${safeTxid} ↗</a></div>
            <button type="button" class="raw-hex-action-btn explorer-link" onclick="viewTxInNahExplorer('${safeTxid}')">🔍 VIEW IN NAH EXPLORER</button>
        </div>
    `;
}

async function retryBroadcastSignedTx(btnEl) {
    if (btnEl && btnEl.disabled) return;
    touchSessionActivity();
    const state = window.NAH_WALLET_STATE;
    const resBox = document.getElementById("split-tx-result");
    if (!pendingSignedSplitTx || !state || !PUBLIC_ACCOUNTS) return;
    const signed = pendingSignedSplitTx;
    const account = PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE];
    if (!account || account.address !== state.address) return;

    if (!navigator.onLine) {
        if (resBox) {
            resBox.style.display = "block";
            resBox.innerHTML = `
                <div style="color:#f4a261; margin-bottom:4px;">✈️ Your device is still in Airplane Mode! Turn ON Wi-Fi/5G, then tap 📡 RETRY BROADCAST below:</div>
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
                    <span style="color:#fceea7;">Signed Tx (${signed.vsize} vB | Fee: ${signed.feeSats} sats):</span>
                    <div style="display:flex; gap:4px;">
                        <button type="button" class="raw-hex-action-btn" onclick="retryBroadcastSignedTx(this)">📡 RETRY BROADCAST</button>
                        <button type="button" class="raw-hex-action-btn" onclick="copySignedRawHex(this)">📋 COPY SIGNED HEX</button>
                    </div>
                </div>
                <div style="background:#222; padding:4px; border-radius:4px; color:#2a9d8f; user-select:all;">${esc(signed.rawHex)}</div>
            `;
        }
        return;
    }
    try {
        assertCoreModulesIntact(true);
        if (btnEl) { btnEl.disabled = true; btnEl.innerText = "📡 BROADCASTING..."; }
        const bRes = await fetchWithTimeout(`${MEMPOOL_API}/tx`, {
            method: "POST",
            headers: { "Content-Type": "text/plain" },
            body: signed.rawHex
        });
        if (!bRes.ok) {
            const errTxt = (await bRes.text()).slice(0, 140);
            throw new Error("Broadcast rejected: " + errTxt);
        }
        const rawBroadcastResp = (await bRes.text()).trim();
        const broadcastedTxid = /^[0-9a-f]{64}$/i.test(rawBroadcastResp) ? rawBroadcastResp.toLowerCase() : signed.txid;
        finalizeBroadcastedTxUI(account, state, signed, broadcastedTxid);
    } catch (e) {
        if (resBox) {
            resBox.style.display = "block";
            resBox.innerHTML = `
                <div style="color:#e76f51; margin-bottom:4px;">❌ ${esc(e.message || e)}</div>
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:4px; margin-bottom:4px;">
                    <span style="color:#fceea7;">Signed Tx (${signed.vsize} vB | Fee: ${signed.feeSats} sats):</span>
                    <div style="display:flex; gap:4px;">
                        <button type="button" class="raw-hex-action-btn" onclick="retryBroadcastSignedTx(this)">📡 RETRY BROADCAST</button>
                        <button type="button" class="raw-hex-action-btn" onclick="copySignedRawHex(this)">📋 COPY SIGNED HEX</button>
                    </div>
                </div>
                <div style="background:#222; padding:4px; border-radius:4px; color:#2a9d8f; user-select:all;">${esc(signed.rawHex)}</div>
            `;
        }
    }
}

// 6-MODULE OPEN-SOURCE & AUDITABILITY HUB (WORKS 100% OFFLINE IN AIRPLANE MODE)
async function verifyWalletCodeIntegrity() {
    const box = document.getElementById("wallet-audit-box");
    if (!box || isAuditRunning) return;
    if (box.style.display === "block") {
        box.style.display = "none";
        return;
    }
    isAuditRunning = true;
    box.style.display = "block";
    box.innerHTML = "Running BIP-86/84 mathematical vectors & computing live SHA-256 digests across all 6 modules...";
    try {
        assertCoreModulesIntact(false);
        const audit = await window.NahSovereignBtc.computeSelfCodeAuditHash();
        const safeWalletHref = esc(audit.walletUrl || "nah-wallet.js?v=26");
        const safeSetupHref = esc(audit.setupUrl || "nah-wallet-setup.js?v=26");
        const safeVaultHref = esc(audit.vaultUrl || "nah-wallet-vault.js?v=26");
        const safeStyleHref = esc(audit.styleUrl || "nah-style.css?v=24");
        const safeExplorerHref = esc(audit.explorerUrl || "nah-explorer.js?v=23");
        box.innerHTML = `
            <div style="color:#fceea7; font-size:9.5px; margin-bottom:4px; border-bottom:1px solid #333; padding-bottom:3px;">
                🛡️ <strong>100% CLIENT-SIDE ENCLAVE, ZERO DEPENDENCIES &amp; ZERO BACKEND TRUST (v26.0)</strong>
            </div>
            <div style="color:#ccc; margin-bottom:6px; font-weight:500;">
                Hosted on GitHub Pages (<a href="${GITHUB_REPO_URL}" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline; font-weight:900;">github.com/geminibrc9999/nah-sovereign-diamond</a>) with <strong>zero NPM dependencies</strong>. All <code>secp256k1</code> math, SHA-256-locked BIP-39 dictionary, 600k-round PBKDF2-AES-256-GCM, and ~3ms Zero-String RAM signing (<code>BIP-340 / RFC-6979</code>) execute 100% inside your browser. Public nodes (<code>nah-core</code> &amp; <code>mempool.space</code>) only ever receive your public address (<code>GET /address/bc1...</code>) and pre-signed raw tx hex (<code>POST /tx</code>). Match the live <code>SHA-256</code> hashes below against GitHub to verify that zero keys or seeds ever leave your device.
            </div>
            <div style="color:#fceea7; margin-bottom:2px;">📂 <strong>LIVE IN-BROWSER SOURCE MODULES &amp; SHA-256 HASHES:</strong></div>
            <div style="margin-bottom:3px;">
                1. <a href="${safeWalletHref}" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">nah-wallet.js</a> (${audit.sizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/nah-wallet.js" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.sha256}</span>
            </div>
            <div style="margin-bottom:3px;">
                2. <a href="${safeSetupHref}" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">nah-wallet-setup.js</a> (${audit.setupSizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/nah-wallet-setup.js" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.setupSha256}</span>
            </div>
            <div style="margin-bottom:3px;">
                3. <a href="${safeVaultHref}" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">nah-wallet-vault.js</a> (${audit.vaultSizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/nah-wallet-vault.js" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.vaultSha256}</span>
            </div>
            <div style="margin-bottom:3px;">
                4. <a href="index.html" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">index.html</a> (${audit.indexSizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/index.html" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.indexSha256}</span>
            </div>
            <div style="margin-bottom:3px;">
                5. <a href="${safeStyleHref}" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">nah-style.css</a> (${audit.styleSizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/nah-style.css" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.styleSha256}</span>
            </div>
            <div style="margin-bottom:6px;">
                6. <a href="${safeExplorerHref}" target="_blank" rel="noopener noreferrer" style="color:#00ccff; text-decoration:underline;">nah-explorer.js</a> (${audit.explorerSizeBytes.toLocaleString("en-US")} B) • <a href="${GITHUB_REPO_URL}/blob/main/nah-explorer.js" target="_blank" rel="noopener noreferrer" style="color:#fceea7; text-decoration:underline;">[GitHub]</a><br>
                <span style="color:#2a9d8f;">SHA-256: ${audit.explorerSha256}</span>
            </div>
            <div style="border-top:1px dotted #444; padding-top:4px; color:#ddd;">
                • Official BIP-39 Wordlist SHA-256: <span style="color:#2a9d8f;">${audit.bip39WordlistSha256} (Pinned &amp; Frozen)</span><br>
                • Official BIP-84 / BIP-86 Test Vectors: <strong style="color:#2a9d8f;">${audit.vectorsVerified ? "PASSED 100%" : "FAILED"}</strong><br>
                • Security Architecture: <strong>100% Zero-Keyboard Seed Entry + Forever Immutable Block Barrier</strong>
            </div>
        `;
    } catch (e) {
        box.innerHTML = "Audit error: " + esc(e.message || e);
    } finally {
        isAuditRunning = false;
    }
}

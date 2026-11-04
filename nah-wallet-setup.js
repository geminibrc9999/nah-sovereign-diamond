// ============================================================================
// NAH-WALLET-SETUP.JS: COLD/COOL ONBOARDING & ZERO-KEYBOARD CONTROLLER (v26.0)
// Design Philosophy: Forever Immutable + Predictive Zero-Keyboard + Airgap Guard
// ============================================================================

window.currentPacketPage = 0;
const PACKETS_PER_PAGE = 5;
const CACHE_TTL_MS = 30000;
const VAULT_STORAGE_KEY = "nah_sovereign_aes_vault_v1";
const GITHUB_REPO_URL = "https://github.com/geminibrc9999/nah-sovereign-diamond";

let PUBLIC_ACCOUNTS = null;
let ACTIVE_ADDR_MODE = "taproot";
let WALLET_ARCH_MODE = "cool"; // "cold" | "cool"
let IS_STATELESS_SESSION = false;
let hasGeneratedPendingSeed = false;
let emergencyBackupTimer = null;
let activeEmergencyWordsRef = null;
let activeEqualSplitCount = 0;
let activePacketDrawerTab = "send"; // "send" | "split"
let isAuditRunning = false;
let walletLoadSeq = 0;
let pendingSignedSplitTx = null;
let COLD_REVEALED_ADDRESS = "";

let selectedQuizAnswers = ["", "", ""];
let importedWordsList = [];
let currentTouchPrefix = "";
let importCheckSeq = 0;
let importChipsMasked = false;
const ADDRESS_VAULT_CACHE = {};

function esc(str) {
    return (window.NahSovereignBtc && window.NahSovereignBtc.escapeHtml)
        ? window.NahSovereignBtc.escapeHtml(str)
        : String(str || "").replace(/[&<>"']/g, "");
}

// STRICT FAIL-CLOSED CIRCUIT BREAKER
function assertCoreModulesIntact(requireNetworkConfig = false) {
    if (!window.NahSovereignBtc) {
        throw new Error("Security Circuit Breaker: Core cryptographic module (nah-wallet.js) failed to load. Please refresh or check Audit Hub.");
    }
    if (requireNetworkConfig) {
        if (typeof NAH_NODE_API !== "string" || !NAH_NODE_API || typeof MEMPOOL_API !== "string" || !MEMPOOL_API || typeof fmtUnit !== "function") {
            throw new Error("Security Circuit Breaker: Core indexer module (nah-explorer.js) is missing or unreachable. Halting network operations for your safety.");
        }
    }
}

// FOREVER IMMUTABLE BLOCK-HEIGHT EXTRACTOR (Syncs with nahData, history & window.NAH_SYNCED_HEIGHT)
function getEffectiveNahSyncedHeight(nahData) {
    const direct = Math.floor(Number(
        (nahData && (nahData.synced_block || nahData.block_height || nahData.height || nahData.tip_height)) ||
        window.NAH_SYNCED_HEIGHT ||
        0
    ));
    if (direct > 946855 && Number.isSafeInteger(direct)) {
        if (direct > (window.NAH_SYNCED_HEIGHT || 0)) window.NAH_SYNCED_HEIGHT = direct;
        return direct;
    }
    if (nahData && Array.isArray(nahData.history)) {
        let maxHistHeight = 0;
        for (const hItem of nahData.history) {
            const hh = Math.floor(Number(hItem && hItem.height) || 0);
            if (hh > maxHistHeight) maxHistHeight = hh;
        }
        if (maxHistHeight > 946855 && Number.isSafeInteger(maxHistHeight)) {
            if (maxHistHeight > (window.NAH_SYNCED_HEIGHT || 0)) window.NAH_SYNCED_HEIGHT = maxHistHeight;
            return maxHistHeight;
        }
    }
    return 0;
}

function handleActiveSessionOrSeedTimeout() {
    if (PUBLIC_ACCOUNTS) {
        lockSovereignWallet(true);
        return;
    }
    if (hasGeneratedPendingSeed || importedWordsList.length > 0) {
        showInitialWalletScreen();
        showWalletNotice("🔒 Seed setup session automatically wiped due to inactivity or screen lock.");
    }
}

function touchSessionActivity() {
    if (!window.NahSovereignBtc) return;
    if (window.NahSovereignBtc.isSessionUnlocked() || hasGeneratedPendingSeed || importedWordsList.length > 0) {
        window.NahSovereignBtc.refreshSessionTimeout(handleActiveSessionOrSeedTimeout);
    }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: ctrl.signal });
    } catch (err) {
        if (err && err.name === "AbortError") {
            throw new Error("Network request timed out (12s). Please check your connection and tap ↻.");
        }
        throw err;
    } finally {
        clearTimeout(timer);
    }
}

function updateAirgapStatusBanner() {
    const netEl = document.getElementById("airgap-net-indicator");
    const readyEl = document.getElementById("airgap-ready-badge");
    const barEl = document.getElementById("airgap-status-bar");
    if (!netEl || !barEl || !readyEl) return;

    if (navigator.onLine) {
        netEl.innerHTML = "📡 INTERNET: CONNECTED";
        netEl.style.color = "#00ccff";
        barEl.style.borderColor = "#0b4594";
    } else {
        netEl.innerHTML = "✈️ AIRPLANE MODE: ON (100% OFFLINE)";
        netEl.style.color = "#fceea7";
        barEl.style.borderColor = "#2a9d8f";
    }

    if (window.NahSovereignBtc && window.NahSovereignBtc.isOfflineReady()) {
        readyEl.innerHTML = "✓ AIRPLANE MODE READY";
        readyEl.style.color = "#2a9d8f";
    } else {
        readyEl.innerHTML = "⏳ LOADING DICTIONARY...";
        readyEl.style.color = "#f4a261";
    }

    const createScreen = document.getElementById("wallet-create-screen");
    if (window.NahSovereignBtc && createScreen && createScreen.style.display === "block") {
        updateGenerateButtonState(window.NahSovereignBtc.getHumanEntropyProgress());
    }

    const impScreen = document.getElementById("wallet-import-screen");
    if (window.NahSovereignBtc && impScreen && impScreen.style.display === "block") {
        renderBip39PrefixSuggestions();
    }
}

function maskStep3ASeedOnBackground() {
    const dispStage = document.getElementById("seed-display-stage");
    const seedBox = document.getElementById("generated-seed-box");
    if (dispStage && dispStage.style.display === "block" && seedBox && hasGeneratedPendingSeed) {
        seedBox.innerHTML = `
            <div onclick="unmaskStep3ASeedWords()" style="cursor:pointer; color:#f4a261; padding:6px;">
                🔒 12 words hidden for your security — Tap here to view again
            </div>
        `;
    }
}

function unmaskStep3ASeedWords() {
    if (!window.NahSovereignBtc) return;
    const words = window.NahSovereignBtc.getPendingWordsForPeek();
    if (words) renderSeedWordsIntoBox(words);
}

function rerollStep3BQuizOnBackground() {
    const quizStage = document.getElementById("seed-quiz-stage");
    if (quizStage && quizStage.style.display === "block" && hasGeneratedPendingSeed && window.NahSovereignBtc) {
        try {
            const freshQuiz = window.NahSovereignBtc.rollFreshSeedQuizChallenge();
            renderZeroKeyboardQuizOptions(freshQuiz);
        } catch (e) {}
    }
}

function maskImportChipsOnBackground() {
    const impScreen = document.getElementById("wallet-import-screen");
    const box = document.getElementById("import-seed-chips-box");
    if (impScreen && impScreen.style.display === "block" && box && importedWordsList.length > 0) {
        importChipsMasked = true;
        box.innerHTML = `
            <div onclick="unmaskImportChips()" style="cursor:pointer; color:#f4a261; width:100%; text-align:center; padding:6px; font-size:9.5px;">
                🔒 ${importedWordsList.length} selected words hidden while in background — Tap here to view
            </div>
        `;
    }
}

function unmaskImportChips() {
    importChipsMasked = false;
    touchSessionActivity();
    renderImportedSeedChips();
}

window.addEventListener("online", () => {
    updateAirgapStatusBanner();
    if (window.NahSovereignBtc && !window.NahSovereignBtc.isOfflineReady()) {
        initOfflineEngineStatus();
    }
    // Zero-Plaintext-Online Firewall for Pure Cold Wallet
    if (WALLET_ARCH_MODE === "cold" && hasGeneratedPendingSeed) {
        showInitialWalletScreen();
        showWalletNotice("🛡️ Cold Wallet Security Firewall: Internet connection detected while creating a Pure Cold Wallet! Pending seed was automatically wiped from RAM. Please keep Airplane Mode ON.");
        return;
    }
    // Mask Step 3A / Reroll Step 3B / Mask Import chips if internet reconnects early during Cool Wallet setup
    if (WALLET_ARCH_MODE === "cool" && (hasGeneratedPendingSeed || importedWordsList.length > 0)) {
        maskStep3ASeedOnBackground();
        rerollStep3BQuizOnBackground();
        maskImportChipsOnBackground();
    }
    // Auto-sync Cool Wallet balance on reconnect ONLY if no signed tx is waiting in the drawer
    if (PUBLIC_ACCOUNTS && !pendingSignedSplitTx && !window.NAH_WALLET_STATE && window.NahSovereignBtc && window.NahSovereignBtc.isSessionUnlocked()) {
        hideWalletNotice();
        if (Object.keys(ADDRESS_VAULT_CACHE).length > 0 && typeof switchWalletAddressMode === "function") {
            switchWalletAddressMode(ACTIVE_ADDR_MODE, true);
        } else if (typeof autoSelectBestAddressAndLoad === "function") {
            autoSelectBestAddressAndLoad();
        }
    }
});

window.addEventListener("offline", updateAirgapStatusBanner);

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        closeEmergencyBackupBox();
        resetAllPasswordVisibility();
        maskStep3ASeedOnBackground();
        rerollStep3BQuizOnBackground();
        maskImportChipsOnBackground();
    } else if (hasGeneratedPendingSeed && window.NahSovereignBtc && !window.NahSovereignBtc.getPendingWordsForPeek()) {
        showInitialWalletScreen();
        showWalletNotice("🔒 Seed creation session timed out while screen was locked. Please generate a fresh 12-word seed.");
    }
});

window.addEventListener("pagehide", () => {
    closeEmergencyBackupBox();
    resetAllPasswordVisibility();
});

window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
        walletLoadSeq++;
        pendingSignedSplitTx = null;
        COLD_REVEALED_ADDRESS = "";
        PUBLIC_ACCOUNTS = null;
        IS_STATELESS_SESSION = false;
        window.NAH_WALLET_STATE = null;
        Object.keys(ADDRESS_VAULT_CACHE).forEach(k => delete ADDRESS_VAULT_CACHE[k]);
        showInitialWalletScreen();
    }
});

async function initOfflineEngineStatus() {
    updateAirgapStatusBanner();
    try {
        if (window.NahSovereignBtc) {
            await window.NahSovereignBtc.runStartupBtcSelfTest();
        }
    } catch (e) {
        console.error("Offline preload notice:", e);
    }
    updateAirgapStatusBanner();
}

function showWalletNotice(htmlMsg) {
    const box = document.getElementById("wallet-status-msg");
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = htmlMsg;
}

function hideWalletNotice() {
    const box = document.getElementById("wallet-status-msg");
    if (box) { box.style.display = "none"; box.innerHTML = ""; }
}

function resetAllPasswordVisibility() {
    ["unlock-password-input", "create-password-1", "create-password-2", "import-password-1", "import-password-2", "emergency-pwd-input"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.type = "password";
    });
    ["btn-show-unlock-pwd", "btn-show-create-pwd", "btn-show-import-pwd"].forEach(id => {
        const btn = document.getElementById(id);
        if (btn) btn.innerText = "SHOW";
    });
}

function updateQuizProgressBadge() {
    const badge = document.getElementById("quiz-progress-status");
    if (!badge) return;
    const count = selectedQuizAnswers.filter(Boolean).length;
    if (count === 3) {
        badge.innerText = "✓ 3/3 READY";
        badge.classList.add("ready");
    } else {
        badge.innerText = `${count}/3 SELECTED`;
        badge.classList.remove("ready");
    }
}

function clearQuizOptionDomNodes() {
    selectedQuizAnswers = ["", "", ""];
    ["quiz-opts-1", "quiz-opts-2", "quiz-opts-3"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
    });
    updateQuizProgressBadge();
}

function clearSensitiveDomInputs() {
    COLD_REVEALED_ADDRESS = "";
    importCheckSeq++;
    importChipsMasked = false;
    clearQuizOptionDomNodes();
    if (Array.isArray(importedWordsList)) importedWordsList.fill("");
    importedWordsList = [];
    currentTouchPrefix = "";
    ["unlock-password-input", "create-password-1", "create-password-2", "import-password-1", "import-password-2", "emergency-pwd-input"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    ["create-pwd-meter", "import-pwd-meter", "cold-addr-chunked-display", "import-seed-chips-box", "import-prefix-strip"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.innerHTML = "";
    });
}

function togglePwdPairVisibility(id1, id2, btnEl) {
    const inp1 = document.getElementById(id1);
    const inp2 = id2 ? document.getElementById(id2) : null;
    if (!inp1) return;
    const nextType = inp1.type === "password" ? "text" : "password";
    inp1.type = nextType;
    if (inp2) inp2.type = nextType;
    if (btnEl) btnEl.innerText = nextType === "text" ? "HIDE" : "SHOW";
}

function updatePwdStrengthAndMatchUI(id1, id2, meterId) {
    const el = document.getElementById(meterId);
    const inp1 = document.getElementById(id1);
    const inp2 = document.getElementById(id2);
    if (!el || !inp1 || !window.NahSovereignBtc) return;
    const p1 = String(inp1.value || "").normalize("NFC");
    const p2 = inp2 ? String(inp2.value || "").normalize("NFC") : "";
    if (!p1) { el.innerHTML = ""; return; }
    const res = window.NahSovereignBtc.evaluatePasswordStrength(p1);
    let matchHtml = "";
    if (p2.length > 0) {
        matchHtml = (p1 === p2)
            ? ` <span style="color:#2a9d8f;">• ✓ Passwords match</span>`
            : ` <span style="color:#e76f51;">• ⏳ Confirm password does not match yet</span>`;
    }
    el.innerHTML = `<span style="color:${res.color};">${esc(res.label)}:</span> <span style="color:#555; font-weight:700;">${esc(res.hint)}</span>${matchHtml}`;
}

function formatAddressWithChecksumHighlight(addr) {
    const clean = esc(String(addr || "").trim());
    if (!clean || clean.length < 14) return clean || "...";
    const head = clean.slice(0, 6);
    const mid = clean.slice(6, -6);
    const tail = clean.slice(-6);
    return `<span style="color:#e76f51; text-decoration:underline;">${head}</span>${mid}<span style="color:#e76f51; text-decoration:underline;">${tail}</span>`;
}

// Keeps each 4-character Cold Address block intact across line wraps on mobile screens
function formatChunkedAddressWithHighlight(addr) {
    const raw = String(addr || "").trim();
    if (!raw || raw.length < 14) return esc(raw);
    const chunks = raw.match(/.{1,4}/g) || [raw];
    return chunks.map((ch, idx) => {
        if (idx === 0 || idx === chunks.length - 1) {
            return `<span style="display:inline-block; white-space:nowrap; word-break:normal; color:#f4a261; text-decoration:underline; margin:0 3px;">${esc(ch)}</span>`;
        }
        return `<span style="display:inline-block; white-space:nowrap; word-break:normal; margin:0 3px;">${esc(ch)}</span>`;
    }).join(" ");
}

function hideAllWalletScreens() {
    pendingSignedSplitTx = null;
    closeEmergencyBackupBox();
    resetAllPasswordVisibility();
    clearSensitiveDomInputs();
    [
        "wallet-mode-selector-screen",
        "wallet-entry-screen",
        "wallet-unlock-screen",
        "wallet-create-screen",
        "wallet-cold-address-screen",
        "wallet-import-screen",
        "wallet-vault-panel",
        "wallet-status-msg"
    ].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
}

function hasStoredEncryptedVault() {
    try {
        const raw = localStorage.getItem(VAULT_STORAGE_KEY);
        if (!raw) return false;
        const parsed = JSON.parse(raw);
        const valid = window.NahSovereignBtc
            ? window.NahSovereignBtc.isValidVaultObject(parsed)
            : Boolean(parsed && parsed.ct);
        if (!valid) localStorage.removeItem(VAULT_STORAGE_KEY);
        return valid;
    } catch (e) {
        try { localStorage.removeItem(VAULT_STORAGE_KEY); } catch (err) {}
        return false;
    }
}

function showInitialWalletScreen() {
    hasGeneratedPendingSeed = false;
    if (window.NahSovereignBtc && window.NahSovereignBtc.clearPendingSeed) {
        window.NahSovereignBtc.clearPendingSeed();
    }
    const seedBox = document.getElementById("generated-seed-box");
    if (seedBox) seedBox.innerHTML = "";
    const dispStage = document.getElementById("seed-display-stage");
    if (dispStage) dispStage.style.display = "none";
    const quizStage = document.getElementById("seed-quiz-stage");
    if (quizStage) quizStage.style.display = "none";
    hideAllWalletScreens();

    if (hasStoredEncryptedVault()) {
        WALLET_ARCH_MODE = "cool";
        document.getElementById("wallet-unlock-screen").style.display = "block";
    } else {
        document.getElementById("wallet-mode-selector-screen").style.display = "block";
    }
}

function openModeSelectorScreen() {
    showInitialWalletScreen();
    document.getElementById("wallet-unlock-screen").style.display = "none";
    document.getElementById("wallet-mode-selector-screen").style.display = "block";
}

function selectWalletArchitectureMode(mode) {
    WALLET_ARCH_MODE = mode === "cold" ? "cold" : "cool";
    hideAllWalletScreens();
    if (WALLET_ARCH_MODE === "cold") {
        openCreateWalletScreen("cold");
    } else {
        if (hasStoredEncryptedVault()) {
            document.getElementById("wallet-unlock-screen").style.display = "block";
        } else {
            document.getElementById("wallet-entry-screen").style.display = "block";
        }
    }
}

function updateGenerateButtonState(pct) {
    const btn = document.getElementById("btn-generate-seed");
    const lbl = document.getElementById("entropy-pct-label");
    const bar = document.getElementById("entropy-progress-bar");
    if (bar) bar.style.width = pct + "%";

    if (pct >= 100) {
        if (lbl) {
            lbl.innerText = "100% MIXED ✓ READY";
            lbl.style.color = "#2a9d8f";
        }
        if (WALLET_ARCH_MODE === "cold" && navigator.onLine) {
            if (btn) {
                btn.disabled = true;
                btn.style.background = "#e76f51";
                btn.style.color = "#ffffff";
                btn.style.borderColor = "#0b4594";
                btn.style.cursor = "not-allowed";
                btn.innerText = "✈️ TURN ON AIRPLANE MODE TO GENERATE COLD WALLET";
            }
            return;
        }
        if (btn) {
            btn.disabled = false;
            btn.style.background = "#0b4594";
            btn.style.color = "#fceea7";
            btn.style.borderColor = "#0b4594";
            btn.style.cursor = "pointer";
            btn.innerText = "⚡ GENERATE MY 12 SECRET WORDS NOW";
        }
    } else {
        const tapsLeft = Math.ceil((100 - pct) / 10);
        if (lbl) {
            lbl.innerText = `${pct}% MIXED (${tapsLeft} MORE ${tapsLeft === 1 ? "TAP" : "TAPS"})`;
            lbl.style.color = "#e76f51";
        }
        if (btn) {
            btn.disabled = true;
            btn.style.background = "#cccccc";
            btn.style.color = "#666666";
            btn.style.borderColor = "#999999";
            btn.style.cursor = "not-allowed";
            btn.innerText = `🔒 TAP ROLL DICE ${tapsLeft} MORE ${tapsLeft === 1 ? "TIME" : "TIMES"} TO UNLOCK (${pct}%)`;
        }
    }
}

function openCreateWalletScreen(archMode = null) {
    try { assertCoreModulesIntact(false); } catch (e) { showWalletNotice("⚠️ " + esc(e.message)); return; }
    if (archMode) WALLET_ARCH_MODE = archMode;
    hideAllWalletScreens();
    hasGeneratedPendingSeed = false;
    window.NahSovereignBtc.resetHumanEntropyPool();

    const titleEl = document.getElementById("create-screen-title");
    const step1DescEl = document.getElementById("create-step1-desc");
    const pwdBlockEl = document.getElementById("cool-password-setup-block");
    const finalBtnEl = document.getElementById("btn-finalize-create");

    if (WALLET_ARCH_MODE === "cold") {
        if (titleEl) titleEl.innerText = "❄️ CREATE PURE COLD WALLET (TAPROOT bc1p)";
        if (step1DescEl) {
            step1DescEl.innerHTML = `<strong>Mandatory for Pure Cold Wallet:</strong> Verify that the top-right badge says <strong style="color:#2a9d8f;">✓ AIRPLANE MODE READY</strong>, then turn ON Airplane Mode. Your 12 words will be generated offline, verified by touch, and wiped from RAM (<code>0x00</code>) the millisecond your <strong>bc1p</strong> address appears!`;
        }
        if (pwdBlockEl) pwdBlockEl.style.display = "none";
        if (finalBtnEl) finalBtnEl.innerText = "❄️ VERIFY 3 WORDS & REVEAL COLD ADDRESS (ZERO-STORAGE)";
    } else {
        if (titleEl) titleEl.innerText = "⚡ CREATE COOL WALLET (PURE TAPROOT bc1p)";
        if (step1DescEl) {
            step1DescEl.innerHTML = `Once the top-right badge says <strong style="color:#2a9d8f;">✓ AIRPLANE MODE READY</strong>, turn ON Airplane Mode (recommended). Your 12 words are generated offline, verified by touch, and locked with 600,000-round AES-256-GCM before you go online!`;
        }
        if (pwdBlockEl) pwdBlockEl.style.display = "block";
        if (finalBtnEl) finalBtnEl.innerText = "✅ VERIFY 3 WORDS, LOCK & OPEN COOL WALLET";
    }

    updateGenerateButtonState(0);
    document.getElementById("create-mode-save").checked = true;
    document.getElementById("create-entropy-step").style.display = "block";
    document.getElementById("seed-display-stage").style.display = "none";
    document.getElementById("seed-quiz-stage").style.display = "none";
    document.getElementById("wallet-create-screen").style.display = "block";
}

async function onHumanEntropyInput(val) {
    if (!window.NahSovereignBtc) return;
    try {
        const pct = await window.NahSovereignBtc.feedHumanEntropy(val);
        updateGenerateButtonState(pct);
    } catch (e) {
        showWalletNotice("⚠️ " + esc(e.message || e));
    }
}

function renderSeedWordsIntoBox(wordsArr) {
    const box = document.getElementById("generated-seed-box");
    if (!box || !Array.isArray(wordsArr)) return;
    box.innerHTML = wordsArr.map((w, i) =>
        `<span style="display:inline-block; background:#1e293b; border:1px solid #00ccff; border-radius:5px; padding:3px 7px; margin:3px;"><span style="color:#888; font-size:9px;">#${i + 1}</span> ${esc(w)}</span>`
    ).join(" ");
    wordsArr.fill("");
}

function renderZeroKeyboardQuizOptions(quizObj) {
    clearQuizOptionDomNodes();
    document.getElementById("quiz-num-1").innerText = quizObj.firstWordNumber;
    document.getElementById("quiz-num-2").innerText = quizObj.secondWordNumber;
    document.getElementById("quiz-num-3").innerText = quizObj.thirdWordNumber;

    const renderRow = (slotIdx, opts) => {
        const container = document.getElementById(`quiz-opts-${slotIdx}`);
        if (!container || !Array.isArray(opts)) return;
        container.innerHTML = opts.map(w =>
            `<button type="button" class="quiz-opt-btn" onclick="selectQuizOptionBtn(${slotIdx}, '${esc(w)}', this)">${esc(w)}</button>`
        ).join("");
    };
    renderRow(1, quizObj.options1);
    renderRow(2, quizObj.options2);
    renderRow(3, quizObj.options3);
    updateQuizProgressBadge();
}

function selectQuizOptionBtn(slotIdx, wordStr, btnEl) {
    hideWalletNotice();
    touchSessionActivity();
    selectedQuizAnswers[slotIdx - 1] = wordStr;
    const container = document.getElementById(`quiz-opts-${slotIdx}`);
    if (container) {
        const btns = container.querySelectorAll(".quiz-opt-btn");
        btns.forEach(b => b.classList.remove("selected"));
    }
    if (btnEl) btnEl.classList.add("selected");
    updateQuizProgressBadge();
}

async function generateSingleCleanSeed() {
    hideWalletNotice();
    if (WALLET_ARCH_MODE === "cold" && navigator.onLine) {
        showWalletNotice("✈️ Pure Cold Wallet requires Airplane Mode! Please turn ON Airplane Mode (disconnect Wi-Fi/5G) first.");
        return;
    }
    try {
        assertCoreModulesIntact(false);
        const gen = await window.NahSovereignBtc.generateMnemonic12();
        hasGeneratedPendingSeed = true;
        window.NahSovereignBtc.refreshSessionTimeout(handleActiveSessionOrSeedTimeout);
        renderSeedWordsIntoBox(gen.wordsList);
        const entStep = document.getElementById("create-entropy-step");
        if (entStep) entStep.style.display = "none";
        document.getElementById("seed-display-stage").style.display = "block";
        document.getElementById("seed-quiz-stage").style.display = "none";
        updateAirgapStatusBanner();
    } catch (e) {
        showWalletNotice(esc(e.message || String(e)));
    }
}

function proceedToBlindPaperQuiz() {
    if (!hasGeneratedPendingSeed) return;
    hideWalletNotice();
    touchSessionActivity();
    document.getElementById("generated-seed-box").innerHTML = "";
    document.getElementById("create-entropy-step").style.display = "none";
    document.getElementById("seed-display-stage").style.display = "none";

    const quiz = window.NahSovereignBtc.rollFreshSeedQuizChallenge();
    renderZeroKeyboardQuizOptions(quiz);
    document.getElementById("seed-quiz-stage").style.display = "block";
}

function peekAtSeedWordsAgain() {
    const words = window.NahSovereignBtc.getPendingWordsForPeek();
    if (!words) return;
    hideWalletNotice();
    clearQuizOptionDomNodes();
    renderSeedWordsIntoBox(words);
    document.getElementById("seed-quiz-stage").style.display = "none";
    document.getElementById("seed-display-stage").style.display = "block";
}

async function finalizeCreateWallet() {
    const btn = document.getElementById("btn-finalize-create");
    if (btn && btn.disabled) return;
    if (!hasGeneratedPendingSeed) {
        showWalletNotice("Please generate your 12 secret words first.");
        return;
    }
    if (!selectedQuizAnswers[0] || !selectedQuizAnswers[1] || !selectedQuizAnswers[2]) {
        showWalletNotice("⚠️ Please tap the matching word button in all 3 rows above (3/3) to verify your paper backup!");
        return;
    }

    const ans1 = selectedQuizAnswers[0];
    const ans2 = selectedQuizAnswers[1];
    const ans3 = selectedQuizAnswers[2];

    const quizDetail = window.NahSovereignBtc.verifyPendingSeedQuizDetailed(ans1, ans2, ans3);
    if (!quizDetail.passed) {
        const freshQuiz = window.NahSovereignBtc.rollFreshSeedQuizChallenge();
        renderZeroKeyboardQuizOptions(freshQuiz);
        showWalletNotice(esc(quizDetail.message));
        return;
    }

    // BRANCH A: PURE COLD WALLET (Derive Taproot bc1p, wipe RAM immediately, zero storage)
    if (WALLET_ARCH_MODE === "cold") {
        if (navigator.onLine) {
            showWalletNotice("✈️ Please keep Airplane Mode ON while finalizing your Pure Cold Wallet!");
            return;
        }
        try {
            if (btn) { btn.disabled = true; btn.innerText = "❄️ DERIVING TAPROOT & WIPING RAM..."; }
            const coldRes = await window.NahSovereignBtc.finalizeColdWalletAddressAndWipe(ans1, ans2, ans3);
            clearQuizOptionDomNodes();
            hasGeneratedPendingSeed = false;
            hideAllWalletScreens();
            COLD_REVEALED_ADDRESS = coldRes.taproot.address;
            const dispEl = document.getElementById("cold-addr-chunked-display");
            if (dispEl) dispEl.innerHTML = formatChunkedAddressWithHighlight(COLD_REVEALED_ADDRESS);
            document.getElementById("wallet-cold-address-screen").style.display = "block";
        } catch (e) {
            showWalletNotice("Cold Wallet error: " + esc(e.message || e));
        } finally {
            if (btn) { btn.disabled = false; btn.innerText = "❄️ VERIFY 3 WORDS & REVEAL COLD ADDRESS (ZERO-STORAGE)"; }
        }
        return;
    }

    // BRANCH B: INTERACTIVE COOL WALLET (600,000-round PBKDF2 + AES-256-GCM)
    const p1 = String(document.getElementById("create-password-1").value || "").normalize("NFC");
    const p2 = String(document.getElementById("create-password-2").value || "").normalize("NFC");
    const pwdCheck = window.NahSovereignBtc.evaluatePasswordStrength(p1);
    if (!pwdCheck.valid) {
        showWalletNotice("⚠️ " + esc(pwdCheck.label) + ": " + esc(pwdCheck.hint));
        return;
    }
    if (p1 !== p2) {
        showWalletNotice("⚠️ Passwords do not match. Please type the same password in both boxes.");
        return;
    }
    const stateless = Boolean(document.getElementById("create-mode-ram").checked);
    try {
        if (btn) { btn.disabled = true; btn.innerText = "🔐 ENCRYPTING (600,000 ROUNDS)..."; }
        showWalletNotice("🔐 Encrypting wallet with 600,000 rounds of PBKDF2-SHA256 + AES-256-GCM...");
        const { vaultObj, accounts } = await window.NahSovereignBtc.createAndEncryptPendingWallet(p1);
        clearQuizOptionDomNodes();
        hasGeneratedPendingSeed = false;
        document.getElementById("generated-seed-box").innerHTML = "";
        await activateDerivedWalletSession(vaultObj, accounts, stateless);
    } catch (e) {
        showWalletNotice("Wallet creation error: " + esc(e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "✅ VERIFY 3 WORDS, LOCK & OPEN COOL WALLET"; }
    }
}

function copyColdWalletAddress() {
    if (!COLD_REVEALED_ADDRESS) return;
    const btn = document.getElementById("btn-copy-cold-addr");
    copyTextToClipboardWithFallback(COLD_REVEALED_ADDRESS, () => {
        if (btn) {
            btn.innerText = "✓ COLD ADDRESS COPIED (VERIFY FIRST & LAST 6 CHARS)";
            setTimeout(() => { btn.innerText = "📋 COPY TAPROOT (bc1p) RECEIVING ADDRESS"; }, 2500);
        }
    });
}

function wipeColdAddressScreenAndFinish() {
    const savedHint = (COLD_REVEALED_ADDRESS && COLD_REVEALED_ADDRESS.length >= 14)
        ? ` (Clipboard Check — First 6: <strong>${esc(COLD_REVEALED_ADDRESS.slice(0, 6))}</strong> • Last 6: <strong>${esc(COLD_REVEALED_ADDRESS.slice(-6))}</strong>)`
        : "";
    COLD_REVEALED_ADDRESS = "";
    if (window.NahSovereignBtc) {
        window.NahSovereignBtc.lockSessionRamKey();
        window.NahSovereignBtc.clearSessionUtxoLocks();
    }
    showInitialWalletScreen();
    showWalletNotice(`❄️ Pure Cold Wallet setup complete &amp; screen wiped!${savedHint} Turn OFF Airplane Mode and send <strong>nah</strong> or <strong>sat</strong> to your copied <strong>bc1p</strong> address.`);
}

// --- ZERO-KEYBOARD IN-APP TOUCH PAD FOR COOL WALLET IMPORT (WITH PREDICTIVE DEAD-KEY LOCKOUT) ---
function openImportWalletScreen() {
    try { assertCoreModulesIntact(false); } catch (e) { showWalletNotice("⚠️ " + esc(e.message)); return; }
    WALLET_ARCH_MODE = "cool";
    hideAllWalletScreens();
    importedWordsList = [];
    currentTouchPrefix = "";
    importChipsMasked = false;
    document.getElementById("import-mode-save").checked = true;
    renderInAppAzTouchPad();
    renderImportedSeedChips();
    renderBip39PrefixSuggestions();
    document.getElementById("wallet-import-screen").style.display = "block";

    if (!window.NahSovereignBtc.isOfflineReady() && window.NahSovereignBtc.ensureWordlistReady) {
        window.NahSovereignBtc.ensureWordlistReady().then(() => {
            updateAirgapStatusBanner();
            renderBip39PrefixSuggestions();
        }).catch(err => {
            showWalletNotice("⚠️ " + esc(err.message || err));
        });
    }
}

function renderInAppAzTouchPad() {
    const padEl = document.getElementById("import-az-pad");
    if (!padEl) return;
    const letters = "abcdefghijklmnopqrstuvwxyz".split("");
    const btnsHtml = letters.map(ch =>
        `<button type="button" id="az-key-${ch}" data-letter="${ch}" class="az-key-btn" onclick="onAzTouchKey('${ch}')">${ch.toUpperCase()}</button>`
    ).join("");
    padEl.innerHTML = btnsHtml + `<button type="button" id="az-key-del" class="az-key-btn" style="grid-column: span 2; background:#fdf6d8; color:#e76f51;" onclick="onAzBackspace()">⌫ DEL LETTER</button>`;
    updateAzPadDeadKeys();
}

function updateAzPadDeadKeys() {
    const padEl = document.getElementById("import-az-pad");
    if (!padEl || !window.NahSovereignBtc) return;
    const dictReady = window.NahSovereignBtc.isOfflineReady();
    const isFull = importedWordsList.length >= 24;
    const allowedList = (!dictReady || isFull)
        ? []
        : (window.NahSovereignBtc.getValidNextBip39Letters
            ? window.NahSovereignBtc.getValidNextBip39Letters(currentTouchPrefix)
            : "abcdefghijklmnopqrstuvwxyz".split(""));
    const allowedSet = new Set(allowedList);

    const btns = padEl.querySelectorAll("button[data-letter]");
    btns.forEach(btn => {
        const ch = btn.getAttribute("data-letter");
        const enabled = dictReady && !isFull && allowedSet.has(ch);
        btn.disabled = !enabled;
        btn.classList.toggle("dead-key", !enabled);
    });

    const delBtn = document.getElementById("az-key-del");
    if (delBtn) {
        const canDel = dictReady && currentTouchPrefix.length > 0;
        delBtn.disabled = !canDel;
        delBtn.classList.toggle("dead-key", !canDel);
    }
}

function renderImportedSeedChips() {
    const box = document.getElementById("import-seed-chips-box");
    const cntEl = document.getElementById("import-words-counter");
    const len = importedWordsList.length;
    const target = len <= 12 ? 12 : 24;
    const myCheckSeq = ++importCheckSeq;

    if (cntEl) {
        cntEl.innerText = `${len} / ${target} WORDS SELECTED`;
        cntEl.style.color = "#0b4594";
    }

    if (len === 12 || len === 24) {
        const snapshotPhrase = importedWordsList.join(" ");
        window.NahSovereignBtc.validateMnemonic(snapshotPhrase).then(isOk => {
            if (myCheckSeq !== importCheckSeq || !cntEl) return;
            if (isOk) {
                cntEl.innerText = `✅ ${len} / ${len} WORDS — BITCOIN CHECKSUM VERIFIED!`;
                cntEl.style.color = "#2a9d8f";
            } else {
                cntEl.innerText = `⚠️ ${len} / ${len} WORDS — CHECKSUM MISMATCH (CHECK WORD ORDER)`;
                cntEl.style.color = "#e76f51";
            }
        }).catch(() => {});
    }

    if (!box) return;
    if (len === 0) {
        box.innerHTML = `<span style="color:#888; font-size:9.5px; width:100%; text-align:center;">Tap letters below (e.g. A ➔ B) then tap the matching word button to add your 12 or 24 words without opening your phone keyboard...</span>`;
        return;
    }
    if (importChipsMasked) {
        maskImportChipsOnBackground();
        return;
    }
    box.innerHTML = importedWordsList.map((w, i) =>
        `<span class="seed-word-chip"><span style="color:#888; font-size:8px;">#${i + 1}</span> ${esc(w)}</span>`
    ).join(" ");
}

function renderBip39PrefixSuggestions() {
    const strip = document.getElementById("import-prefix-strip");
    updateAzPadDeadKeys();
    if (!strip || !window.NahSovereignBtc) return;
    if (!window.NahSovereignBtc.isOfflineReady()) {
        strip.innerHTML = `<span style="color:#f4a261; font-size:9.5px; font-weight:900;">⏳ Loading official BIP-39 dictionary... Please wait a moment.</span>`;
        return;
    }
    if (importedWordsList.length >= 24) {
        strip.innerHTML = `<span style="color:#2a9d8f; font-size:9.5px; font-weight:900;">✓ All 24 words selected! Enter your password below to lock &amp; open wallet.</span>`;
        return;
    }
    if (!currentTouchPrefix) {
        strip.innerHTML = `<span style="color:#666; font-size:9px;">Tap 1–4 letters below to filter official BIP-39 words (invalid next letters lock automatically)...</span>`;
        return;
    }
    const matches = window.NahSovereignBtc.matchBip39WordsByPrefix(currentTouchPrefix, 10);
    if (matches.length === 0) {
        strip.innerHTML = `<span style="color:#e76f51; font-size:9.5px;">No BIP-39 word starts with "${esc(currentTouchPrefix.toUpperCase())}" — tap ⌫ DEL LETTER</span>`;
        return;
    }
    const isSingle = matches.length === 1;
    strip.innerHTML = `<span style="color:#0b4594; font-size:9px; margin-right:4px;">"${esc(currentTouchPrefix.toUpperCase())}":</span>` + matches.map(w => {
        const isExact = (w === currentTouchPrefix);
        const extraCls = isSingle ? "single-match" : (isExact ? "exact-match" : "");
        return `<button type="button" class="bip39-suggest-btn ${extraCls}" onclick="selectBip39SuggestedWord('${esc(w)}')">+ ${esc(w)}</button>`;
    }).join("");
}

function onAzTouchKey(ch) {
    hideWalletNotice();
    touchSessionActivity();
    if (!window.NahSovereignBtc || !window.NahSovereignBtc.isOfflineReady()) return;
    if (importedWordsList.length >= 24) return;
    if (currentTouchPrefix.length < 8) {
        currentTouchPrefix += ch;
        renderBip39PrefixSuggestions();
    }
}

function onAzBackspace() {
    hideWalletNotice();
    touchSessionActivity();
    if (currentTouchPrefix.length > 0) {
        currentTouchPrefix = currentTouchPrefix.slice(0, -1);
        renderBip39PrefixSuggestions();
    }
}

function selectBip39SuggestedWord(word) {
    hideWalletNotice();
    if (importedWordsList.length >= 24) return;
    importChipsMasked = false;
    importedWordsList.push(word);
    currentTouchPrefix = "";
    touchSessionActivity();
    renderImportedSeedChips();
    renderBip39PrefixSuggestions();
}

function removeLastImportedWord() {
    hideWalletNotice();
    importChipsMasked = false;
    currentTouchPrefix = "";
    if (importedWordsList.length > 0) importedWordsList.pop();
    touchSessionActivity();
    renderImportedSeedChips();
    renderBip39PrefixSuggestions();
}

function clearAllImportedWords() {
    hideWalletNotice();
    importCheckSeq++;
    importChipsMasked = false;
    currentTouchPrefix = "";
    importedWordsList.fill("");
    importedWordsList = [];
    renderImportedSeedChips();
    renderBip39PrefixSuggestions();
}

async function finalizeImportWallet() {
    const btn = document.getElementById("btn-finalize-import");
    if (btn && btn.disabled) return;
    if (importedWordsList.length !== 12 && importedWordsList.length !== 24) {
        showWalletNotice(`⚠️ Please select exactly 12 (or 24) words using the touch pad above (${importedWordsList.length} selected).`);
        return;
    }
    const p1 = String(document.getElementById("import-password-1").value || "").normalize("NFC");
    const p2 = String(document.getElementById("import-password-2").value || "").normalize("NFC");
    const pwdCheck = window.NahSovereignBtc.evaluatePasswordStrength(p1);
    if (!pwdCheck.valid) {
        showWalletNotice("⚠️ " + esc(pwdCheck.label) + ": " + esc(pwdCheck.hint));
        return;
    }
    if (p1 !== p2) {
        showWalletNotice("⚠️ Passwords do not match. Please type the same password in both boxes.");
        return;
    }
    const stateless = Boolean(document.getElementById("import-mode-ram").checked);
    try {
        if (btn) { btn.disabled = true; btn.innerText = "🔐 ENCRYPTING (600,000 ROUNDS)..."; }
        showWalletNotice("🔐 Verifying checksum & encrypting wallet with 600,000 rounds of PBKDF2-SHA256 + AES-256-GCM...");
        const wordsCopy = importedWordsList.slice();
        const { vaultObj, accounts } = await window.NahSovereignBtc.importAndEncryptWallet(wordsCopy, p1);
        wordsCopy.fill("");
        clearAllImportedWords();
        await activateDerivedWalletSession(vaultObj, accounts, stateless);
    } catch (e) {
        showWalletNotice(esc(e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "🔐 ENCRYPT & OPEN COOL WALLET"; }
    }
}

async function activateDerivedWalletSession(vaultObj, accounts, statelessMode) {
    IS_STATELESS_SESSION = Boolean(statelessMode);
    let storageBlockedWarning = false;
    if (!IS_STATELESS_SESSION) {
        const savedOk = await window.NahSovereignBtc.saveAndVerifyVaultStorage(vaultObj);
        if (!savedOk) {
            IS_STATELESS_SESSION = true;
            storageBlockedWarning = true;
        }
    } else {
        try { localStorage.removeItem(VAULT_STORAGE_KEY); } catch (e) {}
    }
    PUBLIC_ACCOUNTS = accounts;
    window.NahSovereignBtc.refreshSessionTimeout(handleActiveSessionOrSeedTimeout);
    if (typeof autoSelectBestAddressAndLoad === "function") {
        await autoSelectBestAddressAndLoad();
    }
    if (storageBlockedWarning) {
        const offlineSuffix = !navigator.onLine
            ? "<br>✈️ Turn OFF Airplane Mode when ready and your balance will load automatically."
            : "";
        showWalletNotice("⚠️ Private Browsing detected (browser storage is blocked). Your wallet is open in One-Time Session Mode — keep your 12 paper words safe!" + offlineSuffix);
    }
}

async function unlockEncryptedWallet() {
    try { assertCoreModulesIntact(false); } catch (e) { showWalletNotice("⚠️ " + esc(e.message)); return; }
    const btn = document.getElementById("btn-unlock-wallet");
    if (btn && btn.disabled) return;
    const pwdEl = document.getElementById("unlock-password-input");
    const pwd = pwdEl ? String(pwdEl.value || "").normalize("NFC") : "";
    if (!pwd) {
        showWalletNotice("⚠️ Please enter your wallet password.");
        return;
    }
    try {
        if (btn) { btn.disabled = true; btn.innerText = "🔐 UNLOCKING..."; }
        const rawVault = localStorage.getItem(VAULT_STORAGE_KEY);
        if (!rawVault) {
            showInitialWalletScreen();
            return;
        }
        let vaultObj = null;
        try { vaultObj = JSON.parse(rawVault); } catch (parseErr) {
            localStorage.removeItem(VAULT_STORAGE_KEY);
            showInitialWalletScreen();
            showWalletNotice("⚠️ Saved vault format was corrupted and has been reset. Please import your 12 paper backup words.");
            return;
        }
        PUBLIC_ACCOUNTS = await window.NahSovereignBtc.unlockVaultToPublicAccounts(vaultObj, pwd);
        IS_STATELESS_SESSION = false;
        pwdEl.value = "";
        window.NahSovereignBtc.refreshSessionTimeout(handleActiveSessionOrSeedTimeout);
        if (typeof autoSelectBestAddressAndLoad === "function") {
            await autoSelectBestAddressAndLoad();
        }
    } catch (e) {
        if (pwdEl) pwdEl.value = "";
        if (e && e.vaultWiped) {
            showInitialWalletScreen();
        } else if (pwdEl) {
            pwdEl.focus();
        }
        showWalletNotice("❌ " + esc(e.message || "Incorrect password."));
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "🔓 UNLOCK COOL WALLET"; }
    }
}

function closeEmergencyBackupBox() {
    if (emergencyBackupTimer) { clearInterval(emergencyBackupTimer); emergencyBackupTimer = null; }
    if (Array.isArray(activeEmergencyWordsRef)) {
        activeEmergencyWordsRef.fill("");
        activeEmergencyWordsRef = null;
    }
    const box = document.getElementById("emergency-backup-box");
    const out = document.getElementById("emergency-seed-output");
    const inp = document.getElementById("emergency-pwd-input");
    if (box) box.style.display = "none";
    if (out) { out.style.display = "none"; out.innerHTML = ""; }
    if (inp) { inp.value = ""; inp.type = "password"; }
}

function onEmergencyPwdInput() {
    touchSessionActivity();
    hideWalletNotice();
    const out = document.getElementById("emergency-seed-output");
    if (out && !Array.isArray(activeEmergencyWordsRef)) {
        out.style.display = "none";
        out.innerHTML = "";
    }
}

function toggleEmergencyBackupBox() {
    touchSessionActivity();
    hideWalletNotice();
    const box = document.getElementById("emergency-backup-box");
    if (!box) return;
    if (box.style.display === "block") {
        closeEmergencyBackupBox();
    } else {
        box.style.display = "block";
        document.getElementById("emergency-pwd-input").focus();
    }
}

async function revealEmergencySeedWords() {
    touchSessionActivity();
    hideWalletNotice();
    const btn = document.getElementById("btn-reveal-emergency");
    if (btn && btn.disabled) return;
    const inp = document.getElementById("emergency-pwd-input");
    const out = document.getElementById("emergency-seed-output");
    if (!inp || !out) return;
    if (!inp.value.trim()) {
        out.style.display = "block";
        out.innerHTML = `<span style="color:#e76f51;">⚠️ Please enter your wallet password above to view your 12 backup words.</span>`;
        inp.focus();
        return;
    }
    try {
        if (btn) { btn.disabled = true; btn.innerText = "VERIFYING..."; }
        let vaultObj = null;
        try {
            const rawVault = localStorage.getItem(VAULT_STORAGE_KEY);
            if (rawVault) vaultObj = JSON.parse(rawVault);
        } catch (e) {}

        if (Array.isArray(activeEmergencyWordsRef)) {
            activeEmergencyWordsRef.fill("");
        }
        const words = await window.NahSovereignBtc.revealSeedWordsWithFreshPassword(vaultObj, inp.value);
        activeEmergencyWordsRef = words;
        inp.value = "";
        let secsLeft = 30;
        const renderCountdown = () => {
            if (!Array.isArray(activeEmergencyWordsRef)) return;
            out.innerHTML = `
                <div style="color:#f4a261; font-size:9px; margin-bottom:4px;">⏳ AUTO-HIDING IN ${secsLeft}s — WRITE ON PAPER ONLY (NEVER SCREENSHOT):</div>
                <div>${activeEmergencyWordsRef.map((w, i) => `<span style="display:inline-block; margin:2px 4px;"><span style="color:#888; font-size:8px;">#${i + 1}</span> ${esc(w)}</span>`).join(" ")}</div>
            `;
        };
        out.style.display = "block";
        renderCountdown();
        if (emergencyBackupTimer) clearInterval(emergencyBackupTimer);
        emergencyBackupTimer = setInterval(() => {
            secsLeft--;
            if (secsLeft <= 0) {
                closeEmergencyBackupBox();
            } else {
                renderCountdown();
            }
        }, 1000);
    } catch (e) {
        inp.value = "";
        if (e && e.vaultWiped) {
            lockSovereignWallet(true);
            showWalletNotice("❌ " + esc(e.message || "Incorrect password."));
        } else {
            out.style.display = "block";
            out.innerHTML = `<span style="color:#e76f51;">❌ ${esc(e.message || "Incorrect password.")}</span>`;
            inp.focus();
        }
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = "REVEAL"; }
    }
}

function copyTextToClipboardWithFallback(textToCopy, onDone) {
    const fallbackCopy = () => {
        try {
            const ta = document.createElement("textarea");
            ta.value = textToCopy;
            ta.setAttribute("readonly", "");
            ta.style.position = "fixed";
            ta.style.opacity = "0";
            document.body.appendChild(ta);
            ta.select();
            ta.setSelectionRange(0, textToCopy.length);
            document.execCommand("copy");
            document.body.removeChild(ta);
            if (typeof onDone === "function") onDone();
        } catch (e) {}
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(textToCopy).then(() => {
            if (typeof onDone === "function") onDone();
        }).catch(fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function copyActiveWalletAddress() {
    touchSessionActivity();
    if (!PUBLIC_ACCOUNTS || !PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE]) return;
    const addr = PUBLIC_ACCOUNTS[ACTIVE_ADDR_MODE].address;
    const btn = document.getElementById("btn-copy-addr");
    copyTextToClipboardWithFallback(addr, () => {
        if (btn) {
            btn.innerText = "✓ COPIED (CHECK LAST 6)";
            setTimeout(() => { btn.innerText = "📋 COPY"; }, 2200);
        }
    });
}

function copySignedRawHex(btnEl) {
    touchSessionActivity();
    const rawHex = pendingSignedSplitTx && pendingSignedSplitTx.rawHex;
    if (!rawHex) return;
    copyTextToClipboardWithFallback(rawHex, () => {
        if (btnEl) {
            const orig = btnEl.innerText;
            btnEl.innerText = "✓ HEX COPIED!";
            setTimeout(() => { btnEl.innerText = orig; }, 2000);
        }
    });
}

function lockSovereignWallet(isAutoTimeout = false) {
    if (!isAutoTimeout && IS_STATELESS_SESSION) {
        if (!confirm("You are in One-Time Session Only mode. Locking will wipe this session from memory and you will need your 12 paper words to open it again. Continue?")) {
            return;
        }
    }
    walletLoadSeq++;
    pendingSignedSplitTx = null;
    closeEmergencyBackupBox();
    window.NahSovereignBtc.lockSessionRamKey();
    if (IS_STATELESS_SESSION) {
        window.NahSovereignBtc.clearSessionUtxoLocks();
    }
    PUBLIC_ACCOUNTS = null;
    IS_STATELESS_SESSION = false;
    window.NAH_WALLET_STATE = null;
    Object.keys(ADDRESS_VAULT_CACHE).forEach(k => delete ADDRESS_VAULT_CACHE[k]);
    showInitialWalletScreen();
    if (isAutoTimeout) {
        showWalletNotice("🔒 Wallet automatically locked for your security due to inactivity or screen lock.");
    }
}

function resetStoredWalletPrompt() {
    if (!confirm("Remove this wallet from your browser? Make sure you have your 12 secret words written on physical paper before continuing!")) return;
    walletLoadSeq++;
    pendingSignedSplitTx = null;
    closeEmergencyBackupBox();
    window.NahSovereignBtc.lockSessionRamKey();
    window.NahSovereignBtc.clearSessionUtxoLocks();
    PUBLIC_ACCOUNTS = null;
    IS_STATELESS_SESSION = false;
    window.NAH_WALLET_STATE = null;
    Object.keys(ADDRESS_VAULT_CACHE).forEach(k => delete ADDRESS_VAULT_CACHE[k]);
    try { localStorage.removeItem(VAULT_STORAGE_KEY); } catch (e) {}
    showInitialWalletScreen();
}

window.addEventListener("DOMContentLoaded", () => {
    const tabMenu = document.querySelector(".tab-menu");
    if (tabMenu) {
        tabMenu.addEventListener("click", (e) => {
            if (e && e.target && e.target.closest && e.target.closest(".wallet-tab-btn")) {
                updateAirgapStatusBanner();
                return;
            }
            closeEmergencyBackupBox();
            resetAllPasswordVisibility();
            maskStep3ASeedOnBackground();
            rerollStep3BQuizOnBackground();
            maskImportChipsOnBackground();
        });
    }
});

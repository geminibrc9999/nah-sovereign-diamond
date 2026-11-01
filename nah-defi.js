// ============================================================================
// NAH-DEFI.JS: SOVEREIGN WALLET CONNECT (UNISAT / OKX / XVERSE) & NAH UTXO VAULT
// ============================================================================

window.NAH_WALLET_STATE = {
    connected: false,
    providerName: "",
    address: "",
    publicKey: "",
    nahBalance: 0,
    nahUtxos: [],
    cardinalUtxos: [],
    cardinalSats: 0,
    selectedUtxo: null
};

(function initDefiHubUI() {
    const hub = document.getElementById("nah-defi-hub");
    if (!hub) return;

    hub.innerHTML = `
        <div class="converter-section" style="background: #fdf6d8; margin-bottom: 20px; border: 3px solid #0b4594;">
            <div class="sub-title" style="margin-bottom: 6px;">🔐 SOVEREIGN WALLET &amp; NAH UTXO VAULT</div>
            <div style="font-size: 10px; font-weight: 700; color: #0b4594; text-align: center; margin-bottom: 10px;">
                Zero-Key Architecture: Connect Web3 Wallet or Inspect Any Address UTXO Vault
            </div>

            <!-- 3 NÚT KẾT NỐI VÍ CHÍNH (UNISAT ĐỨNG ĐẦU VỚI NHÃN RECOMMENDED) -->
            <div id="wallet-connect-btns" style="display: flex; gap: 6px; margin-bottom: 8px;">
                <button onclick="connectSovereignWallet('unisat')" style="flex: 1.25; background: #111111; color: #fceea7; border: 2px solid #0b4594; border-radius: 8px; padding: 8px 4px; font-family: 'Quicksand', sans-serif; font-size: 11px; font-weight: 900; cursor: pointer; box-shadow: 2px 2px 0px #0b4594; line-height: 1.15;">
                    🟡 UNISAT<span style="font-size: 7px; color: #e76f51; display: block; margin-top: 2px;">(RECOMMENDED)</span>
                </button>
                <button onclick="connectSovereignWallet('okx')" style="flex: 1; background: #111111; color: #00ccff; border: 2px solid #0b4594; border-radius: 8px; padding: 8px 4px; font-family: 'Quicksand', sans-serif; font-size: 11px; font-weight: 900; cursor: pointer; box-shadow: 2px 2px 0px #0b4594;">
                    🟢 OKX WALLET
                </button>
                <button onclick="connectSovereignWallet('xverse')" style="flex: 1; background: #111111; color: #f4a261; border: 2px solid #0b4594; border-radius: 8px; padding: 8px 4px; font-family: 'Quicksand', sans-serif; font-size: 11px; font-weight: 900; cursor: pointer; box-shadow: 2px 2px 0px #0b4594;">
                    🔵 XVERSE
                </button>
            </div>

            <!-- THANH TRA CỨU NHANH KHO UTXO TRÊN ĐIỆN THOẠI (WATCH-ONLY / SAFARI FALLBACK) -->
            <div id="wallet-watch-bar" style="display: flex; gap: 6px; margin-bottom: 4px;">
                <input type="text" id="vault-watch-input" placeholder="Or paste Bitcoin address to inspect UTXO packets..." style="flex: 1; padding: 8px 10px; border: 2px solid #0b4594; border-radius: 8px; font-family: 'Quicksand', sans-serif; font-size: 11px; font-weight: 700; color: #0b4594; outline: none; background: #ffffff;">
                <button onclick="inspectAddressVault()" style="background: #e76f51; color: #ffffff; border: 2px solid #0b4594; border-radius: 8px; padding: 0 12px; font-family: 'Quicksand', sans-serif; font-weight: 900; font-size: 11px; cursor: pointer;">
                    LOAD VAULT
                </button>
            </div>

            <!-- THÔNG BÁO KHI DÙNG TRÌNH DUYỆT SAFARI DI ĐỘNG -->
            <div id="wallet-status-msg" style="display: none; margin-top: 8px; padding: 8px; background: #fff3e0; border: 1.5px dashed #e76f51; border-radius: 6px; font-size: 10px; font-weight: 700; color: #0b4594; text-align: center;"></div>

            <!-- BẢNG ĐIỀU KHIỂN KẾT NỐI & KHO UTXO -->
            <div id="wallet-vault-panel" style="display: none; margin-top: 10px; background: #ffffff; border: 2px solid #0b4594; border-radius: 10px; padding: 10px;">
                <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1.5px dotted #e9c46a; padding-bottom: 6px; margin-bottom: 8px;">
                    <div>
                        <span id="vault-provider-badge" style="background: #0b4594; color: #fceea7; padding: 2px 6px; border-radius: 4px; font-size: 9px; font-weight: 900; text-transform: uppercase;">CONNECTED</span>
                        <span id="vault-addr-display" style="font-size: 11px; font-weight: 900; color: #0b4594; margin-left: 4px;">...</span>
                    </div>
                    <button onclick="disconnectSovereignWallet()" style="background: transparent; color: #e76f51; border: 1px solid #e76f51; border-radius: 5px; padding: 2px 6px; font-family: 'Quicksand', sans-serif; font-size: 9px; font-weight: 900; cursor: pointer;">
                        CLOSE ✕
                    </button>
                </div>

                <!-- 2 KÉT SẮT TÁCH BIỆT: PROTECTED nah VAULT vs BASIC sat BALANCE -->
                <div style="display: flex; gap: 6px; margin-bottom: 10px;">
                    <div style="flex: 1; background: #111111; border: 1.5px solid #0b4594; border-radius: 8px; padding: 8px 6px; text-align: center;">
                        <div style="font-size: 9px; color: #888; font-weight: 900;">💎 PROTECTED nah VAULT</div>
                        <div id="vault-nah-bal" style="font-size: 13px; color: #00ccff; font-weight: 900; margin: 3px 0; white-space: nowrap;">0 nahs</div>
                        <div id="vault-nah-packets" style="font-size: 8px; color: #2a9d8f; font-weight: 900;">0 UTXO packets</div>
                    </div>
                    <div style="flex: 1; background: #111111; border: 1.5px solid #0b4594; border-radius: 8px; padding: 8px 6px; text-align: center;">
                        <div style="font-size: 9px; color: #888; font-weight: 900;">⚡ BASIC sat BALANCE</div>
                        <div id="vault-sat-bal" style="font-size: 13px; color: #f4a261; font-weight: 900; margin: 3px 0; white-space: nowrap;">0 sats</div>
                        <div id="vault-sat-packets" style="font-size: 8px; color: #ccc; font-weight: 900;">0 spendable UTXOs</div>
                    </div>
                </div>

                <div style="font-size: 10px; font-weight: 900; color: #e76f51; text-transform: uppercase; margin-bottom: 6px; display: flex; justify-content: space-between;">
                    <span>📦 YOUR INDIVIDUAL nah UTXO PACKETS</span>
                    <span style="color: #0b4594; font-size: 9px;">TAP PACKET TO SPLIT / LIST</span>
                </div>

                <div id="vault-utxo-list" style="max-height: 220px; overflow-y: auto;"></div>

                <!-- KHUNG CHỜ CHO CÔNG CỤ NAH SPLITTER (BƯỚC 2B) -->
                <div id="vault-splitter-box" style="display: none; margin-top: 10px; padding: 10px; background: #fdf6d8; border: 2px dashed #0b4594; border-radius: 8px;"></div>
            </div>
        </div>
    `;
})();

function showWalletNotice(htmlMsg) {
    const box = document.getElementById("wallet-status-msg");
    if (!box) return;
    box.style.display = "block";
    box.innerHTML = htmlMsg;
}

async function connectSovereignWallet(type) {
    const msgBox = document.getElementById("wallet-status-msg");
    if (msgBox) msgBox.style.display = "none";

    try {
        if (type === "unisat") {
            if (!window.unisat) {
                showWalletNotice(`
                    UniSat Wallet not detected in this browser.<br>
                    Open <strong>nahkahmotors.com</strong> inside the UniSat App Browser, or paste your address above to inspect your UTXO Vault!
                `);
                return;
            }
            const accounts = await window.unisat.requestAccounts();
            const pubKey = await window.unisat.getPublicKey();
            if (accounts && accounts.length > 0) {
                await loadVaultForAddress(accounts[0], "UNISAT", pubKey || "");
            }
        } else if (type === "okx") {
            const provider = (window.okxwallet && window.okxwallet.bitcoin) ? window.okxwallet.bitcoin : null;
            if (!provider) {
                const dappUrl = encodeURIComponent(window.location.href);
                showWalletNotice(`
                    OKX Wallet not detected in this browser.<br>
                    👉 <a href="okx://wallet/dapp/url?dappUrl=${dappUrl}" style="color:#e76f51; text-decoration:underline; font-weight:900;">Tap here to open in OKX Wallet App</a>, or paste your address above to inspect your UTXO Vault!
                `);
                return;
            }
            const res = await provider.connect();
            await loadVaultForAddress(res.address, "OKX WALLET", res.publicKey || "");
        } else if (type === "xverse") {
            const xv = (window.XverseProviders && window.XverseProviders.BitcoinProvider) || window.BitcoinProvider;
            if (!xv) {
                showWalletNotice(`
                    Xverse Wallet not detected in this browser.<br>
                    Open <strong>nahkahmotors.com</strong> inside the Xverse App Browser, or paste your address above to inspect your UTXO Vault!
                `);
                return;
            }
            const resp = await xv.request("getAccounts", {
                purposes: ["ordinals", "payment"],
                message: "Connect to NAH Sovereign Diamond Vault"
            });
            const list = (resp && resp.result) ? resp.result : [];
            const ordAcc = list.find(a => a.purpose === "ordinals") || list[0];
            if (ordAcc && ordAcc.address) {
                await loadVaultForAddress(ordAcc.address, "XVERSE", ordAcc.publicKey || "");
            }
        }
    } catch (err) {
        showWalletNotice("Wallet connection cancelled or failed: " + (err.message || err));
    }
}

async function inspectAddressVault() {
    const inp = document.getElementById("vault-watch-input");
    if (!inp) return;
    const addr = inp.value.trim();
    if (!addr) return;
    const msgBox = document.getElementById("wallet-status-msg");
    if (msgBox) msgBox.style.display = "none";
    await loadVaultForAddress(addr, "WATCH VAULT", "");
}

function disconnectSovereignWallet() {
    window.NAH_WALLET_STATE = {
        connected: false, providerName: "", address: "", publicKey: "",
        nahBalance: 0, nahUtxos: [], cardinalUtxos: [], cardinalSats: 0, selectedUtxo: null
    };
    const panel = document.getElementById("wallet-vault-panel");
    if (panel) panel.style.display = "none";
}

async function loadVaultForAddress(address, providerLabel, pubKey) {
    const panel = document.getElementById("wallet-vault-panel");
    const listEl = document.getElementById("vault-utxo-list");
    const splitBox = document.getElementById("vault-splitter-box");
    if (panel) panel.style.display = "block";
    if (splitBox) splitBox.style.display = "none";
    if (listEl) listEl.innerHTML = `<div style="font-size:10px; color:#888; text-align:center; padding:10px;">Scanning UTXO Vault on Bitcoin Timechain...</div>`;

    document.getElementById("vault-provider-badge").innerText = providerLabel;
    document.getElementById("vault-addr-display").innerText = shortAddress(address);

    try {
        const [nahRes, btcUtxoRes] = await Promise.allSettled([
            fetch(`${NAH_NODE_API}/address/${encodeURIComponent(address)}`).then(r => r.ok ? r.json() : null),
            fetch(`${MEMPOOL_API}/address/${encodeURIComponent(address)}/utxo`).then(r => r.ok ? r.json() : [])
        ]);

        const nahData = (nahRes.status === "fulfilled" && nahRes.value) ? nahRes.value : { balance: 0, utxos: [] };
        const rawBtcUtxos = (btcUtxoRes.status === "fulfilled" && Array.isArray(btcUtxoRes.value)) ? btcUtxoRes.value : [];

        const nahUtxos = nahData.utxos || [];
        const nahOutpointSet = new Set(nahUtxos.map(u => u.outpoint));

        const cardinalUtxos = rawBtcUtxos.filter(u => {
            const op = `${u.txid}:${u.vout}`;
            return !nahOutpointSet.has(op) && (u.value || 0) > 600;
        });
        const cardinalSats = cardinalUtxos.reduce((acc, u) => acc + (u.value || 0), 0);

        window.NAH_WALLET_STATE = {
            connected: providerLabel !== "WATCH VAULT",
            providerName: providerLabel,
            address: address,
            publicKey: pubKey,
            nahBalance: nahData.balance || 0,
            nahUtxos: nahUtxos,
            cardinalUtxos: cardinalUtxos,
            cardinalSats: cardinalSats,
            selectedUtxo: null
        };

        const nahBal = nahData.balance || 0;
        document.getElementById("vault-nah-bal").innerText = `${nahBal.toLocaleString('en-US')} ${fmtUnit(nahBal, 'nah', 'nahs')}`;
        document.getElementById("vault-nah-packets").innerText = `${nahUtxos.length} ${fmtUnit(nahUtxos.length, 'UTXO packet', 'UTXO packets')}`;
        document.getElementById("vault-sat-bal").innerText = `${cardinalSats.toLocaleString('en-US')} ${fmtUnit(cardinalSats, 'sat', 'sats')}`;
        document.getElementById("vault-sat-packets").innerText = `${cardinalUtxos.length} spendable ${fmtUnit(cardinalUtxos.length, 'UTXO', 'UTXOs')}`;

        if (nahUtxos.length === 0) {
            listEl.innerHTML = `<div style="font-size:10px; color:#777; text-align:center; padding:10px;">No unspent nah UTXO packets found in this address.</div>`;
            return;
        }

        listEl.innerHTML = nahUtxos.map((u, idx) => {
            const pctWallet = nahBal > 0 ? ((u.nah / nahBal) * 100).toFixed(2) + "%" : "100%";
            const shortOp = `${u.txid.slice(0, 8)}...${u.txid.slice(-6)}:${u.vout}`;
            return `
                <div onclick="selectNahUtxoPacket(${idx})" style="padding:8px; margin-bottom:6px; background:#fdf6d8; border:1.5px solid #0b4594; border-radius:6px; cursor:pointer; font-size:10px;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:3px;">
                        <span style="background:#111; color:#00ccff; padding:2px 6px; border-radius:4px; font-size:9px; font-weight:900;">
                            PACKET #${idx + 1} (${pctWallet})
                        </span>
                        <span style="color:#0b4594; font-size:12px; font-weight:900; white-space:nowrap;">
                            💎 ${u.nah.toLocaleString('en-US')} ${fmtUnit(u.nah, 'nah', 'nahs')}
                        </span>
                    </div>
                    <div style="display:flex; justify-content:space-between; align-items:center; color:#555; font-size:9px;">
                        <span>UTXO: <strong style="color:#0b4594;">${shortOp}</strong></span>
                        <span>Carrier: <strong>${u.sats.toLocaleString('en-US')} sats</strong></span>
                    </div>
                </div>
            `;
        }).join("");
    } catch (e) {
        listEl.innerHTML = `<div style="font-size:10px; color:#e76f51; text-align:center; padding:8px;">Unable to load UTXO Vault right now.</div>`;
    }
}

function selectNahUtxoPacket(idx) {
    const u = window.NAH_WALLET_STATE.nahUtxos[idx];
    if (!u) return;
    window.NAH_WALLET_STATE.selectedUtxo = u;
    const splitBox = document.getElementById("vault-splitter-box");
    if (!splitBox) return;
    splitBox.style.display = "block";
    splitBox.innerHTML = `
        <div style="font-size:10px; font-weight:900; color:#0b4594; margin-bottom:4px;">
            ✂️ SELECTED PACKET #${idx + 1}: <span style="color:#e76f51;">${u.nah.toLocaleString('en-US')} ${fmtUnit(u.nah, 'nah', 'nahs')}</span>
        </div>
        <div style="font-size:9px; color:#555; margin-bottom:4px;">
            Outpoint: ${u.outpoint} | Carrier Postage: ${u.sats} sats
        </div>
        <div style="font-size:9px; font-weight:900; color:#2a9d8f;">
            ✓ Ready for Runestone (946855:118) UTXO Splitter &amp; PSBT Listing (Phase 2B)
        </div>
    `;
}

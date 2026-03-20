import React, { useState, useEffect, useCallback } from "react";
import toast, { Toaster } from "react-hot-toast";
import {
  useWeb3Modal,
  useWeb3ModalProvider,
  useWeb3ModalAccount,
} from "@web3modal/ethers/react";
import { ethers } from "ethers";
import {
  Shield,
  ShieldOff,
  Send,
  Lock,
  Unlock,
  Inbox,
  Eye,
  EyeOff,
  Copy,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  KeyRound,
  ChevronDown,
  ArrowUpRight,
  ChevronRight,
} from "lucide-react";
import {
  deriveKeyFromWallet,
  generateECDHKeyPair,
  encrypt,
  decrypt,
  encryptForRecipient,
  decryptFromSender,
  encryptToStorage,
  decryptFromStorage,
} from "./lib/crypto";
import {
  TOKENS,
  NATIVE,
  fetchNativeBalance,
  fetchTokenBalance,
  fetchEncryptedBalance,
  fetchPublicKey,
  fetchPendingDeposits,
  deposit,
  withdraw,
  registerPublicKey,
  storePendingDeposit,
  clearPendingDeposits,
  relayTransfer,
  sendNativeINJ,
  CONTRACT_ADDRESS,
} from "./lib/contract";
import {
  playShield,
  playUnshield,
  playSend,
  playPrivateSend,
  playClaim,
  playError,
} from "./lib/sounds";
import "./App.css";

const trunc = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const fmt = (n, decimals = 4) => {
  const x = parseFloat(n);
  return isNaN(x) || n === null ? "—" : x.toFixed(decimals);
};

const PANELS = {
  SHIELD: "shield",
  UNSHIELD: "unshield",
  SEND: "send",
  PRIVATE_SEND: "private_send",
  CLAIM: "claim",
};

export default function App({ wcEnabled }) {
  const { open: openModal } = useWeb3Modal();
  const { address, isConnected } = useWeb3ModalAccount();
  const { walletProvider } = useWeb3ModalProvider();

  const [signer, setSigner] = useState(null);
  const [encKey, setEncKey] = useState("");
  const [ecdhPub, setEcdhPub] = useState("");
  const [ecdhPrivJwk, setEcdhPrivJwk] = useState(null);
  const [isKeyOnChain, setIsKeyOnChain] = useState(false);

  // Per-token state
  const [selectedToken, setSelectedToken] = useState(TOKENS[0]);
  const [publicBals, setPublicBals] = useState({}); // token.address -> string
  const [shieldedBals, setShieldedBals] = useState({}); // token.address -> string
  const [showShielded, setShowShielded] = useState(true);
  const [tokenMenuOpen, setTokenMenuOpen] = useState(false);

  const [panel, setPanel] = useState(null);
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [loading, setLoading] = useState({});

  const busy = (k, v) => setLoading((p) => ({ ...p, [k]: v }));

  const publicBal = publicBals[selectedToken.address] ?? null;
  const shieldedBal = shieldedBals[selectedToken.address] ?? "0";

  // ── Init on wallet connect ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isConnected || !walletProvider) {
      setSigner(null);
      setEncKey("");
      setPublicBals({});
      setShieldedBals({});
      return;
    }

    const init = async () => {
      try {
        const provider = new ethers.BrowserProvider(walletProvider);
        const s = await provider.getSigner();
        setSigner(s);

        const toastId = toast.loading("Deriving encryption key…");
        const key = await deriveKeyFromWallet(s);
        setEncKey(key);
        toast.dismiss(toastId);

        // ECDH key pair — private key encrypted at rest
        let pub = localStorage.getItem("injshield_ecdh_pub");
        const encPrivRaw = localStorage.getItem("injshield_ecdh_priv_enc");
        let priv = null;
        if (pub && encPrivRaw) {
          try { priv = await decryptFromStorage(encPrivRaw, key); }
          catch { pub = null; }
        }
        if (!pub || !priv) {
          const pair = await generateECDHKeyPair();
          pub = pair.publicKeyHex;
          priv = pair.privateKeyJwk;
          localStorage.setItem("injshield_ecdh_pub", pub);
          localStorage.setItem("injshield_ecdh_priv_enc", await encryptToStorage(priv, key));
          localStorage.removeItem("injshield_ecdh_priv");
        }
        setEcdhPub(pub);
        setEcdhPrivJwk(priv);

        // Load all token balances in parallel
        const [nativeBal, onChainKey, ...shieldedRaws] = await Promise.all([
          fetchNativeBalance(address, walletProvider),
          fetchPublicKey(address, walletProvider),
          ...TOKENS.map((t) => fetchEncryptedBalance(t.address, address, walletProvider)),
        ]);

        // Public balances
        const pubBalMap = { [NATIVE]: nativeBal };
        const tokenFetches = TOKENS.filter((t) => !t.native).map((t) =>
          fetchTokenBalance(t.address, address, walletProvider)
            .then((b) => ({ addr: t.address, b }))
            .catch(() => ({ addr: t.address, b: "0" }))
        );
        const tokenBals = await Promise.all(tokenFetches);
        tokenBals.forEach(({ addr, b }) => { pubBalMap[addr] = b; });
        setPublicBals(pubBalMap);

        setIsKeyOnChain(!!onChainKey && onChainKey.toLowerCase() === pub.toLowerCase());

        // Decrypt shielded balances
        const shieldMap = {};
        for (let i = 0; i < TOKENS.length; i++) {
          const enc = shieldedRaws[i];
          if (enc) {
            try { shieldMap[TOKENS[i].address] = await decrypt(enc, key); }
            catch { shieldMap[TOKENS[i].address] = "?"; }
          } else {
            shieldMap[TOKENS[i].address] = "0";
          }
        }
        setShieldedBals(shieldMap);

        toast.success(`Connected ${trunc(address)}`);
      } catch (err) {
        toast.error(err.message);
      }
    };

    init();
  }, [isConnected, walletProvider, address]);

  // ── Refresh ────────────────────────────────────────────────────────────────
  const refresh = useCallback(async () => {
    if (!address || !encKey) return;
    try {
      busy("refresh", true);
      const nativeBal = await fetchNativeBalance(address, walletProvider);
      const pubBalMap = { [NATIVE]: nativeBal };
      const tokenFetches = TOKENS.filter((t) => !t.native).map((t) =>
        fetchTokenBalance(t.address, address, walletProvider)
          .then((b) => ({ addr: t.address, b }))
          .catch(() => ({ addr: t.address, b: "0" }))
      );
      (await Promise.all(tokenFetches)).forEach(({ addr, b }) => { pubBalMap[addr] = b; });
      setPublicBals(pubBalMap);

      const shieldMap = {};
      for (const t of TOKENS) {
        const enc = await fetchEncryptedBalance(t.address, address, walletProvider);
        if (enc) {
          try { shieldMap[t.address] = await decrypt(enc, encKey); }
          catch { shieldMap[t.address] = "?"; }
        } else {
          shieldMap[t.address] = "0";
        }
      }
      setShieldedBals(shieldMap);
    } catch { toast.error("Refresh failed"); }
    finally { busy("refresh", false); }
  }, [address, walletProvider, encKey]);

  // ── Register ECDH key ──────────────────────────────────────────────────────
  const handleRegister = useCallback(async () => {
    try {
      busy("register", true);
      await registerPublicKey(signer, ecdhPub);
      setIsKeyOnChain(true);
      toast.success("Receive key registered");
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("register", false); }
  }, [signer, ecdhPub]);

  // ── Shield ─────────────────────────────────────────────────────────────────
  const handleShield = useCallback(async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter a valid amount");
    try {
      busy("shield", true);
      const cur = parseFloat(shieldedBals[selectedToken.address] || "0");
      const encrypted = await encrypt(String(cur + amt), encKey);
      await deposit(signer, selectedToken, String(amt), encrypted);
      setShieldedBals((p) => ({ ...p, [selectedToken.address]: String(cur + amt) }));
      const nativeBal = await fetchNativeBalance(address, walletProvider);
      if (selectedToken.native) {
        setPublicBals((p) => ({ ...p, [NATIVE]: nativeBal }));
      } else {
        const tb = await fetchTokenBalance(selectedToken.address, address, walletProvider);
        setPublicBals((p) => ({ ...p, [selectedToken.address]: tb, [NATIVE]: nativeBal }));
      }
      setAmount(""); setPanel(null);
      playShield();
      toast.success(`${amt} ${selectedToken.symbol} shielded`);
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("shield", false); }
  }, [signer, amount, encKey, shieldedBals, selectedToken, address, walletProvider]);

  // ── Unshield ───────────────────────────────────────────────────────────────
  const handleUnshield = useCallback(async () => {
    const amt = Number(amount);
    if (!amt || amt <= 0) return toast.error("Enter a valid amount");
    try {
      busy("unshield", true);
      const enc = await fetchEncryptedBalance(selectedToken.address, address, walletProvider);
      if (!enc) throw new Error("No shielded balance");
      const cur = Number(await decrypt(enc, encKey));
      if (amt > cur) throw new Error(`Max shielded: ${fmt(cur)} ${selectedToken.symbol}`);
      const newBal = cur - amt;
      const newEnc = newBal > 0 ? await encrypt(String(newBal), encKey) : "";
      await withdraw(signer, selectedToken, String(amt), newEnc);
      setShieldedBals((p) => ({ ...p, [selectedToken.address]: String(newBal) }));
      const nativeBal = await fetchNativeBalance(address, walletProvider);
      if (selectedToken.native) {
        setPublicBals((p) => ({ ...p, [NATIVE]: nativeBal }));
      } else {
        const tb = await fetchTokenBalance(selectedToken.address, address, walletProvider);
        setPublicBals((p) => ({ ...p, [selectedToken.address]: tb, [NATIVE]: nativeBal }));
      }
      setAmount(""); setPanel(null);
      playUnshield();
      toast.success(`${amt} ${selectedToken.symbol} returned to wallet`);
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("unshield", false); }
  }, [signer, amount, encKey, selectedToken, address, walletProvider]);

  // ── Public send ────────────────────────────────────────────────────────────
  const handleSend = useCallback(async () => {
    const amt = Number(amount);
    if (!recipient || !amt) return toast.error("Fill recipient and amount");
    try {
      busy("send", true);
      await sendNativeINJ(signer, recipient, String(amt));
      setPublicBals((p) => ({ ...p, [NATIVE]: await fetchNativeBalance(address, walletProvider) }));
      setAmount(""); setRecipient(""); setPanel(null);
      playSend();
      toast.success(`Sent ${amt} INJ`);
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("send", false); }
  }, [signer, amount, recipient, address, walletProvider]);

  // ── Private send ───────────────────────────────────────────────────────────
  const handlePrivateSend = useCallback(async () => {
    const amt = Number(amount);
    if (!recipient || !amt) return toast.error("Fill recipient and amount");
    try {
      busy("psend", true);
      const recvPub = await fetchPublicKey(recipient, walletProvider);
      if (!recvPub) throw new Error("Recipient hasn't registered an ECDH key");
      const enc = await fetchEncryptedBalance(selectedToken.address, address, walletProvider);
      if (!enc) throw new Error("No shielded balance");
      const cur = Number(await decrypt(enc, encKey));
      if (amt > cur) throw new Error(`Max shielded: ${fmt(cur)} ${selectedToken.symbol}`);
      const newMyBal = await encrypt(String(cur - amt), encKey);
      const { ciphertext, ephemeralPubKeyHex } = await encryptForRecipient(String(amt), recvPub);
      await relayTransfer(selectedToken.address, [address], [newMyBal], signer);
      await storePendingDeposit(signer, selectedToken.address, recipient, ephemeralPubKeyHex, ciphertext);
      setShieldedBals((p) => ({ ...p, [selectedToken.address]: String(cur - amt) }));
      setAmount(""); setRecipient(""); setPanel(null);
      playPrivateSend();
      toast.success(`${amt} ${selectedToken.symbol} sent privately`);
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("psend", false); }
  }, [signer, amount, recipient, encKey, selectedToken, address, walletProvider]);

  // ── Claim ──────────────────────────────────────────────────────────────────
  const handleClaim = useCallback(async () => {
    try {
      busy("claim", true);
      const pending = await fetchPendingDeposits(selectedToken.address, address, walletProvider);
      if (!pending.length) { toast("No pending transfers"); return; }
      let total = 0;
      for (const { ephemeralPubKeyHex, ciphertext } of pending)
        total += Number(await decryptFromSender(ciphertext, ephemeralPubKeyHex, ecdhPrivJwk));
      const enc = await fetchEncryptedBalance(selectedToken.address, address, walletProvider);
      const cur = enc ? Number(await decrypt(enc, encKey)) : 0;
      const newTotal = cur + total;
      await relayTransfer(selectedToken.address, [address], [await encrypt(String(newTotal), encKey)], signer);
      await clearPendingDeposits(signer, selectedToken.address);
      setShieldedBals((p) => ({ ...p, [selectedToken.address]: String(newTotal) }));
      setPanel(null);
      playClaim();
      toast.success(`Claimed ${fmt(total)} ${selectedToken.symbol} from ${pending.length} transfer(s)`);
    } catch (err) { toast.error(err.message); playError(); }
    finally { busy("claim", false); }
  }, [signer, encKey, ecdhPrivJwk, selectedToken, address, walletProvider]);

  const togglePanel = (id) => { setPanel((p) => (p === id ? null : id)); setAmount(""); setRecipient(""); };
  const copyAddr = () => { navigator.clipboard.writeText(address); toast.success("Copied"); };

  const totalShielded = TOKENS.reduce((sum, t) => sum + parseFloat(shieldedBals[t.address] || 0), 0);

  // ── Connect screen ─────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="connect-screen">
        <Toaster position="top-right" toastOptions={{ style: { background: "#1e1f2e", color: "#fff", border: "1px solid #2d2f45" } }} />
        <div className="connect-card">
          <div className="brand">
            <div className="brand-icon"><Shield size={28} strokeWidth={1.8} /></div>
            <div>
              <h1 className="brand-name">InjShield</h1>
              <p className="brand-tagline">Private payments on Injective</p>
            </div>
          </div>
          <div className="feature-list">
            <div className="feature-item"><Lock size={14} /><span>AES-256-GCM encrypted balances</span></div>
            <div className="feature-item"><Shield size={14} /><span>ECDH P-256 private transfers</span></div>
            <div className="feature-item"><Send size={14} /><span>Multi-token: INJ, WETH, USDT, USDC</span></div>
          </div>
          {!CONTRACT_ADDRESS && (
            <div className="warn-box"><AlertCircle size={13} /> Set REACT_APP_CONTRACT_ADDRESS in frontend/.env</div>
          )}
          {!wcEnabled && (
            <div className="warn-box"><AlertCircle size={13} /> Set REACT_APP_WC_PROJECT_ID for Web3Modal</div>
          )}
          <button className="btn-connect" onClick={() => openModal()}>
            <Shield size={16} /> Connect Wallet
          </button>
        </div>
      </div>
    );
  }

  // ── Wallet UI ──────────────────────────────────────────────────────────────
  return (
    <div className="app">
      <Toaster position="top-right" toastOptions={{ style: { background: "#1e1f2e", color: "#fff", border: "1px solid #2d2f45" } }} />

      {/* Header */}
      <header className="header">
        <div className="logo"><Shield size={16} strokeWidth={2} /><span>InjShield</span></div>
        <div className="header-right">
          {!isKeyOnChain && (
            <button className="btn-tag btn-tag--warn" onClick={handleRegister} disabled={loading.register}>
              {loading.register ? <RefreshCw size={11} className="spin" /> : <KeyRound size={11} />}
              Register key
            </button>
          )}
          <button className="wallet-pill" onClick={copyAddr}>
            <span className="dot-green" /><span>{trunc(address)}</span><Copy size={11} />
          </button>
        </div>
      </header>

      <div className="wallet-wrap">
        <div className="wallet-card">

          {/* Total shielded summary */}
          <div className="total-section">
            <p className="total-label">Total Shielded</p>
            <p className="total-amount">{fmt(totalShielded)} <span>USD equiv.</span></p>
            <button className="refresh-btn" onClick={refresh} disabled={loading.refresh}>
              <RefreshCw size={13} className={loading.refresh ? "spin" : ""} />
            </button>
          </div>

          {/* Action row */}
          <div className="action-row">
            {[
              { id: PANELS.SHIELD,       icon: <Lock size={16} />,   label: "Shield"   },
              { id: PANELS.UNSHIELD,     icon: <Unlock size={16} />, label: "Unshield" },
              { id: PANELS.SEND,         icon: <Send size={16} />,   label: "Send"     },
              { id: PANELS.PRIVATE_SEND, icon: <Shield size={16} />, label: "Private"  },
              { id: PANELS.CLAIM,        icon: <Inbox size={16} />,  label: "Claim"    },
            ].map(({ id, icon, label }) => (
              <button
                key={id}
                className={`action-btn ${panel === id ? "action-btn--active" : ""}`}
                onClick={() => togglePanel(id)}
              >
                <span className="action-btn-icon">{icon}</span>
                <span className="action-btn-label">{label}</span>
              </button>
            ))}
          </div>

          {/* Token list — one row per token */}
          <div className="token-list">
            {TOKENS.map((token) => {
              const pubB = publicBals[token.address] ?? null;
              const shB = shieldedBals[token.address] ?? "0";
              const isSelected = selectedToken.address === token.address;
              return (
                <div
                  key={token.address}
                  className={`token-row ${isSelected ? "token-row--selected" : ""}`}
                  onClick={() => setSelectedToken(token)}
                >
                  <div className="token-icon" style={{ background: token.color + "22", color: token.color }}>
                    <span className="token-symbol-icon">{token.symbol[0]}</span>
                  </div>
                  <div className="token-info">
                    <span className="token-name">{token.symbol}</span>
                    <span className="token-name-sub">{token.name}</span>
                  </div>
                  <div className="token-cols">
                    {/* Public side */}
                    <div className="token-col">
                      <span className="token-col-label"><ArrowUpRight size={10} /> Public</span>
                      <span className="token-balance">{fmt(pubB)}</span>
                      {isSelected && (
                        <button className="inline-action-btn" onClick={(e) => { e.stopPropagation(); togglePanel(PANELS.SHIELD); }} title="Shield">
                          <Lock size={11} /> Shield
                        </button>
                      )}
                    </div>
                    {/* Shielded side */}
                    <div className="token-col token-col--shielded">
                      <span className="token-col-label"><Lock size={10} /> Shielded</span>
                      <span className="token-balance token-balance--shielded">
                        {showShielded ? fmt(shB) : "••••"}
                      </span>
                      {isSelected && (
                        <button className="inline-action-btn inline-action-btn--purple" onClick={(e) => { e.stopPropagation(); togglePanel(PANELS.UNSHIELD); }} title="Unshield">
                          <Unlock size={11} /> Unshield
                        </button>
                      )}
                    </div>
                    <button className="eye-btn" onClick={(e) => { e.stopPropagation(); setShowShielded((s) => !s); }}>
                      {showShielded ? <EyeOff size={12} /> : <Eye size={12} />}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Selected token indicator */}
          <div className="selected-token-bar">
            <span style={{ color: selectedToken.color }}>●</span>
            <span>Acting on <strong>{selectedToken.symbol}</strong></span>
            <ChevronRight size={12} />
          </div>

          {/* Action panel */}
          {panel && (
            <div className="action-panel">
              <div className="panel-header">
                <span className="panel-title">
                  {panel === PANELS.SHIELD       && <><Lock size={14} /> Shield {selectedToken.symbol}</>}
                  {panel === PANELS.UNSHIELD     && <><Unlock size={14} /> Unshield {selectedToken.symbol}</>}
                  {panel === PANELS.SEND         && <><Send size={14} /> Send INJ</>}
                  {panel === PANELS.PRIVATE_SEND && <><Shield size={14} /> Private Send {selectedToken.symbol}</>}
                  {panel === PANELS.CLAIM        && <><Inbox size={14} /> Claim {selectedToken.symbol}</>}
                </span>
                <button className="panel-close" onClick={() => { setPanel(null); setAmount(""); setRecipient(""); }}>
                  <ChevronDown size={16} />
                </button>
              </div>

              {panel === PANELS.SHIELD && (
                <div className="panel-form">
                  <div className="input-row">
                    <input type="number" className="inp" placeholder="0.0000" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" step="0.0001" autoFocus />
                    <span className="inp-badge">{selectedToken.symbol}</span>
                  </div>
                  <p className="panel-hint">Wrap public {selectedToken.symbol} into the encrypted pool. Balance never readable on-chain.</p>
                  <button className="panel-btn panel-btn--purple" onClick={handleShield} disabled={loading.shield || !amount}>
                    {loading.shield ? <RefreshCw size={14} className="spin" /> : <Lock size={14} />}
                    {loading.shield ? "Shielding…" : "Confirm Shield"}
                  </button>
                </div>
              )}

              {panel === PANELS.UNSHIELD && (
                <div className="panel-form">
                  <div className="input-row">
                    <input type="number" className="inp" placeholder="0.0000" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" step="0.0001" autoFocus />
                    <span className="inp-badge">{selectedToken.symbol}</span>
                  </div>
                  <p className="panel-hint panel-hint--warn"><AlertCircle size={12} /> Withdrawal amount is visible on-chain.</p>
                  <button className="panel-btn" onClick={handleUnshield} disabled={loading.unshield || !amount}>
                    {loading.unshield ? <RefreshCw size={14} className="spin" /> : <Unlock size={14} />}
                    {loading.unshield ? "Unshielding…" : "Confirm Unshield"}
                  </button>
                </div>
              )}

              {panel === PANELS.SEND && (
                <div className="panel-form">
                  <input type="text" className="inp" placeholder="Recipient 0x…" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoFocus />
                  <div className="input-row" style={{ marginTop: 8 }}>
                    <input type="number" className="inp" placeholder="0.0000" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" step="0.0001" />
                    <span className="inp-badge">INJ</span>
                  </div>
                  <p className="panel-hint">Standard transfer — sender and amount are visible on-chain.</p>
                  <button className="panel-btn" onClick={handleSend} disabled={loading.send || !amount || !recipient}>
                    {loading.send ? <RefreshCw size={14} className="spin" /> : <Send size={14} />}
                    {loading.send ? "Sending…" : "Send"}
                  </button>
                </div>
              )}

              {panel === PANELS.PRIVATE_SEND && (
                <div className="panel-form">
                  <input type="text" className="inp" placeholder="Recipient 0x…" value={recipient} onChange={(e) => setRecipient(e.target.value)} autoFocus />
                  <div className="input-row" style={{ marginTop: 8 }}>
                    <input type="number" className="inp" placeholder="0.0000" value={amount} onChange={(e) => setAmount(e.target.value)} min="0" step="0.0001" />
                    <span className="inp-badge">{selectedToken.symbol}</span>
                  </div>
                  <p className="panel-hint">Amount encrypted via ECDH P-256 — only recipient can decrypt. Relayer hides your identity.</p>
                  <button className="panel-btn panel-btn--purple" onClick={handlePrivateSend} disabled={loading.psend || !amount || !recipient}>
                    {loading.psend ? <RefreshCw size={14} className="spin" /> : <Shield size={14} />}
                    {loading.psend ? "Sending privately…" : "Send Privately"}
                  </button>
                </div>
              )}

              {panel === PANELS.CLAIM && (
                <div className="panel-form panel-form--center">
                  <div className="claim-icon"><Inbox size={28} strokeWidth={1.5} /></div>
                  <p className="panel-hint" style={{ textAlign: "center" }}>
                    Decrypt and merge incoming private {selectedToken.symbol} transfers.
                  </p>
                  {!isKeyOnChain && (
                    <p className="panel-hint panel-hint--warn" style={{ textAlign: "center" }}>
                      <AlertCircle size={12} /> Register your ECDH key first.
                    </p>
                  )}
                  <button className="panel-btn panel-btn--purple" onClick={handleClaim} disabled={loading.claim}>
                    {loading.claim ? <RefreshCw size={14} className="spin" /> : <Inbox size={14} />}
                    {loading.claim ? "Claiming…" : "Claim Pending Transfers"}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Key status */}
          <div className={`key-status ${isKeyOnChain ? "key-status--ok" : "key-status--warn"}`}>
            {isKeyOnChain
              ? <><CheckCircle2 size={12} /><span>ECDH key active — receiving enabled</span></>
              : <><AlertCircle size={12} /><span>Register ECDH key to receive private transfers</span>
                  <button className="btn-tag btn-tag--xs" onClick={handleRegister} disabled={loading.register}>Register</button></>
            }
          </div>
        </div>
      </div>

      <footer className="footer">
        InjShield <span className="sep" /> AES-256-GCM · ECDH P-256 · Multi-token · Injective EVM
      </footer>
    </div>
  );
}

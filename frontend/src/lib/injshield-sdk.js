/**
 * InjShield SDK v1.0
 * ──────────────────────────────────────────────────────────────────────────────
 * Embed private shielded transfers into any Injective EVM dApp.
 *
 * Quick start:
 *   import { InjShieldSDK } from './injshield-sdk'
 *
 *   const sdk = new InjShieldSDK({
 *     contractAddress: '0x...',
 *     relayerUrl: 'https://your-relayer.example.com',
 *   })
 *
 *   // After user connects wallet (pass EIP-1193 provider)
 *   const { address } = await sdk.init(window.ethereum)
 *
 *   await sdk.registerReceiveKey()       // one-time, enables receiving
 *   await sdk.shield('1.0')             // deposit 1 INJ into private pool
 *   await sdk.sendPrivate('0x...', '0.5') // private transfer
 *   const { claimed } = await sdk.claim() // merge incoming transfers
 *   await sdk.unshield('0.5')           // withdraw back to wallet
 *
 * Privacy model:
 *   - Balances: AES-256-GCM encrypted, only owner can decrypt via wallet sig
 *   - Transfers: ECDH P-256 per-transfer ephemeral keys, only receiver decrypts
 *   - Sender identity: hidden via relayer for balance updates
 *   - Amounts: never stored in plaintext on-chain
 */

import { ethers } from "ethers";
import {
  deriveKeyFromWallet,
  generateECDHKeyPair,
  encrypt,
  decrypt,
  encryptForRecipient,
  decryptFromSender,
} from "./crypto";
import {
  deposit,
  withdraw,
  fetchEncryptedBalance,
  fetchNativeBalance,
  fetchPublicKey,
  fetchPendingDeposits,
  registerPublicKey,
  storePendingDeposit,
  clearPendingDeposits,
  relayTransfer,
  sendNativeINJ,
} from "./contract";

export class InjShieldSDK {
  /**
   * @param {object} opts
   * @param {string} opts.contractAddress  - InjShield contract address
   * @param {string} [opts.relayerUrl]     - Relayer endpoint (default: localhost:4000)
   */
  constructor({ contractAddress, relayerUrl } = {}) {
    this.contractAddress = contractAddress;
    this.relayerUrl = relayerUrl || "http://localhost:4000";
    this._signer = null;
    this._walletProvider = null;
    this._address = null;
    this._encKey = null;
    this._ecdhPub = null;
    this._ecdhPrivJwk = null;
    this._ready = false;
  }

  // ── Setup ───────────────────────────────────────────────────────────────────

  /**
   * Initialize SDK with a connected wallet's EIP-1193 provider.
   * Derives encryption keys from the wallet — user signs once, no key backup needed.
   *
   * @param {object} walletProvider - EIP-1193 provider (window.ethereum, Web3Modal, etc.)
   * @returns {{ address: string, ecdhPublicKey: string }}
   */
  async init(walletProvider) {
    this._walletProvider = walletProvider;
    const provider = new ethers.BrowserProvider(walletProvider);
    this._signer = await provider.getSigner();
    this._address = await this._signer.getAddress();

    // AES-256-GCM key derived from wallet signature — deterministic, no backup needed
    this._encKey = await deriveKeyFromWallet(this._signer);

    // ECDH P-256 key pair for receiving private transfers
    const storedPub = localStorage.getItem("injshield_ecdh_pub");
    const storedPriv = localStorage.getItem("injshield_ecdh_priv");
    if (storedPub && storedPriv) {
      this._ecdhPub = storedPub;
      this._ecdhPrivJwk = JSON.parse(storedPriv);
    } else {
      const pair = await generateECDHKeyPair();
      this._ecdhPub = pair.publicKeyHex;
      this._ecdhPrivJwk = pair.privateKeyJwk;
      localStorage.setItem("injshield_ecdh_pub", this._ecdhPub);
      localStorage.setItem("injshield_ecdh_priv", JSON.stringify(this._ecdhPrivJwk));
    }

    this._ready = true;
    return { address: this._address, ecdhPublicKey: this._ecdhPub };
  }

  _check() {
    if (!this._ready) throw new Error("InjShieldSDK: call init(walletProvider) first");
  }

  // ── Queries ─────────────────────────────────────────────────────────────────

  /** Returns decrypted shielded balance as a string (e.g. "4.5000") */
  async getShieldedBalance() {
    this._check();
    const enc = await fetchEncryptedBalance(this._address, this._walletProvider);
    if (!enc) return "0";
    return decrypt(enc, this._encKey);
  }

  /** Returns native (unshielded) INJ balance as a string */
  async getPublicBalance() {
    this._check();
    return fetchNativeBalance(this._address, this._walletProvider);
  }

  /** Returns true if ECDH receive key is registered on-chain */
  async isReceiveKeyRegistered() {
    this._check();
    const onChain = await fetchPublicKey(this._address, this._walletProvider);
    return !!onChain && onChain.toLowerCase() === this._ecdhPub.toLowerCase();
  }

  /** Returns count of pending incoming transfers */
  async getPendingCount() {
    this._check();
    const pending = await fetchPendingDeposits(this._address, this._walletProvider);
    return pending.length;
  }

  // ── Actions ─────────────────────────────────────────────────────────────────

  /**
   * Register ECDH public key on-chain.
   * Required once before users can receive private transfers.
   */
  async registerReceiveKey() {
    this._check();
    return registerPublicKey(this._signer, this._ecdhPub);
  }

  /**
   * Shield (wrap) INJ into the private pool.
   * Balance is AES-encrypted before touching the chain.
   *
   * @param {string} amount - Amount in INJ (e.g. "1.5")
   */
  async shield(amount) {
    this._check();
    const currentBal = parseFloat(await this.getShieldedBalance());
    const newBal = currentBal + parseFloat(amount);
    const encrypted = await encrypt(String(newBal), this._encKey);
    return deposit(this._signer, encrypted, amount);
  }

  /**
   * Unshield (unwrap) INJ back to public wallet.
   * Note: withdrawal amount is visible on-chain.
   *
   * @param {string} amount - Amount in INJ
   */
  async unshield(amount) {
    this._check();
    const currentBal = parseFloat(await this.getShieldedBalance());
    const parsed = parseFloat(amount);
    if (parsed > currentBal) throw new Error("Insufficient shielded balance");
    const newBal = currentBal - parsed;
    const newEncBal = newBal > 0 ? await encrypt(String(newBal), this._encKey) : "";
    return withdraw(this._signer, ethers.parseEther(amount), newEncBal);
  }

  /**
   * Send a private transfer to another InjShield user.
   * Amount is ECDH P-256 encrypted — only the recipient can decrypt.
   * Relayer submits the balance update to hide sender identity.
   *
   * @param {string} toAddress - Recipient EVM address
   * @param {string} amount    - Amount in INJ
   */
  async sendPrivate(toAddress, amount) {
    this._check();
    const receiverPubKey = await fetchPublicKey(toAddress, this._walletProvider);
    if (!receiverPubKey)
      throw new Error("Recipient has not registered an ECDH key on InjShield");

    const currentBal = parseFloat(await this.getShieldedBalance());
    const parsed = parseFloat(amount);
    if (parsed > currentBal) throw new Error("Insufficient shielded balance");

    const newMyBal = await encrypt(String(currentBal - parsed), this._encKey);
    const { ciphertext, ephemeralPubKeyHex } = await encryptForRecipient(amount, receiverPubKey);

    await relayTransfer([this._address], [newMyBal]);
    await storePendingDeposit(this._signer, toAddress, ephemeralPubKeyHex, ciphertext);
  }

  /**
   * Send a regular (non-private) INJ transfer.
   *
   * @param {string} toAddress - Recipient EVM address
   * @param {string} amount    - Amount in INJ
   */
  async sendPublic(toAddress, amount) {
    this._check();
    return sendNativeINJ(this._signer, toAddress, amount);
  }

  /**
   * Claim all incoming private transfers and merge into shielded balance.
   *
   * @returns {{ claimed: number, count: number }}
   */
  async claim() {
    this._check();
    const pending = await fetchPendingDeposits(this._address, this._walletProvider);
    if (pending.length === 0) return { claimed: 0, count: 0 };

    let total = 0;
    for (const { ephemeralPubKeyHex, ciphertext } of pending) {
      total += parseFloat(
        await decryptFromSender(ciphertext, ephemeralPubKeyHex, this._ecdhPrivJwk)
      );
    }

    const currentBal = parseFloat(await this.getShieldedBalance());
    const newTotal = currentBal + total;
    const newEncBal = await encrypt(String(newTotal), this._encKey);

    await relayTransfer([this._address], [newEncBal]);
    await clearPendingDeposits(this._signer);

    return { claimed: total, count: pending.length };
  }
}

export default InjShieldSDK;

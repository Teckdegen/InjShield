# InjShield — Private Multi-Token Payments on Injective

Shield, move, and unshield tokens privately on Injective EVM.
Balances are AES-256-GCM encrypted on-chain. Keys never leave the browser. Transfers use ECDH P-256 — only the recipient can decrypt the amount.

---

## What is (and isn't) hidden

| What | Visible on-chain? | Notes |
|------|:-----------------:|-------|
| Your shielded balance | **No** | Stored as AES-256-GCM ciphertext — unreadable without your wallet |
| Private transfer amount | **No** | ECDH-encrypted with ephemeral key — only receiver can decrypt |
| Sender identity (balance update) | **No** | Relayer submits the tx; if relayer is offline, user self-relays |
| Withdrawal amount | **No** | `Withdraw` event emits only the user address, not the amount |
| Sender/receiver link on private sends | **No** | `PendingDepositStored` emits only an opaque `keccak256` tag |
| Who has a shielded account | **Yes** | Any address that called `deposit` is visible |
| Transaction timing | **Yes** | Block timestamps are always public |
| Deposit amount | **Yes** | ERC-20 `transferFrom` and native `msg.value` are observable |

**Bottom line:** once tokens are shielded, all movements and balances are fully hidden. The only observable fact is that an address has interacted with the contract.

---

## Architecture

```
User (Browser)                    Relayer (Node)             Injective EVM
  │                                     │                         │
  ├─ Sign message → derive AES-256 key  │                         │
  ├─ Derive ECDH P-256 key pair         │                         │
  │  (private key AES-encrypted in localStorage)                  │
  │                                     │                         │
  ├─ registerPublicKey(pubKey) ──────────────────────────────────► │
  │                                     │                         │
  ├─ deposit(token, amount, AES(bal)) ──────────────────────────► │ holds tokens
  │                                     │                         │
  ╔══ Private Transfer ═══════════════════════════════════════════════════════════╗
  ║  1. Fetch receiver's ECDH pubkey from chain                                  ║
  ║  2. Generate ephemeral ECDH key pair (fresh per transfer → forward secrecy)  ║
  ║  3. Derive shared secret: ECDH(ephemeral_priv, receiver_pub)                 ║
  ║  4. Encrypt amount with shared secret (only receiver can read)               ║
  ║  5. Re-encrypt sender's updated balance with sender's AES key               ║
  ║  6. POST /relay → updateBalances(token, [sender], [newBal]) ───────────────► ║
  ║     (if relayer offline → selfUpdateBalance() from sender wallet)            ║
  ║  7. storePendingDeposit(token, receiver, ephemPubKey ∥ ciphertext) ────────► ║
  ╚═══════════════════════════════════════════════════════════════════════════════╝
  │
Receiver (Browser)                                               │
  ├─ getPendingDeposits(token, receiver) ◄──────────────────────── │
  ├─ ECDH(receiver_priv, ephemPubKey) → shared secret             │
  ├─ Decrypt ciphertext → amount                                   │
  ├─ Merge with existing balance, re-encrypt                       │
  ├─ POST /relay → updateBalances(token, [receiver], [newBal]) ──► │
  │  (fallback: selfUpdateBalance() if relayer offline)            │
  └─ clearPendingDeposits(token) ──────────────────────────────── ► │
```

---

## Supported Tokens

| Token | Type | Notes |
|-------|------|-------|
| INJ | Native | `address(0)` — no approval needed |
| WETH | ERC-20 | Set `REACT_APP_WETH_ADDRESS` in `frontend/.env` |
| USDT | ERC-20 | Set `REACT_APP_USDT_ADDRESS` in `frontend/.env` |
| USDC | ERC-20 | Set `REACT_APP_USDC_ADDRESS` in `frontend/.env` |

Any ERC-20 token on Injective EVM can be added to the `TOKENS` list in `frontend/src/lib/contract.js`.

---

## Build & Run

### Prerequisites

- Node.js v18–v22 (v25 works with `--legacy-peer-deps`)
- Two funded Injective EVM wallets: one for deployment, one for the relayer
- Free WalletConnect project ID from [cloud.walletconnect.com](https://cloud.walletconnect.com)

### 1. Install dependencies

```bash
npm install --legacy-peer-deps
cd relayer && npm install && cd ..
cd frontend && npm install && cd ..
```

### 2. Configure environment

Root `.env`:
```
DEPLOYER_PRIVATE_KEY=0x...
RELAYER_PRIVATE_KEY=0x...
RELAYER_ADDRESS=0x...
CONTRACT_ADDRESS=          # fill after deploy
RPC_URL=https://inevm-rpc.testnet.injective.network
```

`frontend/.env`:
```
REACT_APP_CONTRACT_ADDRESS=    # fill after deploy
REACT_APP_WC_PROJECT_ID=       # WalletConnect project ID
REACT_APP_RELAYER_URL=http://localhost:4000
REACT_APP_RPC_URL=https://inevm-rpc.testnet.injective.network
REACT_APP_WETH_ADDRESS=0x...
REACT_APP_USDT_ADDRESS=0x...
REACT_APP_USDC_ADDRESS=0x...
```

### 3. Compile & deploy

```bash
npm run compile
npm run deploy
# → prints CONTRACT_ADDRESS=0x...
```

Copy the address into both `.env` files.

### 4. Run

```bash
npm run dev        # starts relayer (port 4000) + frontend (port 3000) together

# or separately:
npm run relayer    # http://localhost:4000
npm run frontend   # http://localhost:3000
```

---

## User Flow

1. **Connect Wallet** — signs a fixed message to derive your AES-256 balance encryption key. Deterministic: same wallet always produces the same key, even if localStorage is cleared.
2. **Register ECDH Key** — publishes your P-256 public key on-chain (one-time). Required to receive private transfers. Private key is AES-encrypted before being stored in localStorage.
3. **Shield** — encrypts your token balance locally, locks tokens in the contract. Balance becomes invisible on-chain.
4. **Unshield** — withdraws tokens back to your wallet. Withdrawal amount is visible on-chain (required by EVM).
5. **Private Send** — encrypts the amount using ECDH with the recipient's public key. Only the recipient can decrypt. Relayer hides the sender.
6. **Claim** — decrypts incoming private transfers using your ECDH private key, merges them into your balance.

---

## Relayer & Self-Relay Fallback

The relayer server (`relayer/`) submits `updateBalances` transactions on behalf of users so the user's wallet is not linked to the balance update on-chain.

**If the relayer server is offline**, the frontend automatically falls back to `selfUpdateBalance()` — a contract function that lets any user update only their own encrypted balance directly. The user pays gas themselves in this case. Funds are always safe regardless of relayer status.

```
Relayer online  → relayer pays gas, user wallet hidden from update tx
Relayer offline → user pays gas directly via selfUpdateBalance()
```

---

## Tech Stack

| Layer | Tech |
|-------|------|
| Smart contract | Solidity 0.8.20, Hardhat |
| Symmetric crypto | AES-256-GCM (Web Crypto API, non-extractable keys) |
| Key exchange | ECDH P-256 (Web Crypto API, ephemeral per transfer) |
| Key derivation | SHA-256(wallet signature) → AES key |
| Relayer | Express.js + ethers.js |
| Frontend | React 18, Web3Modal, ethers.js, lucide-react |
| Chain | Injective EVM (testnet chain ID 1738 / mainnet 2525) |

---

## Known Limitations

- **Deposit amount visible** — the initial shield amount is observable (ERC-20 `transferFrom` / `msg.value` are always on-chain). Only post-deposit movements and balances are private.
- **No ZK proofs** — balance arithmetic is enforced off-chain (client-side). A SNARK for state transitions would eliminate the need to trust the client.
- **Relayer is trusted for liveness** — it can censor but cannot steal funds. The self-relay fallback removes the liveness dependency.
- **Single-chain** — Cosmos/IBC assets on the Injective native side are not supported; only Injective EVM tokens.

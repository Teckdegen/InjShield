import { ethers } from "ethers";

export const CONTRACT_ADDRESS = process.env.REACT_APP_CONTRACT_ADDRESS;
export const RELAYER_URL = process.env.REACT_APP_RELAYER_URL || "http://localhost:4000";
const PUBLIC_RPC = process.env.REACT_APP_RPC_URL || "https://inevm-rpc.testnet.injective.network";

// address(0) = native INJ
export const NATIVE = "0x0000000000000000000000000000000000000000";

// ── Token registry ─────────────────────────────────────────────────────────────
// Fill in ERC-20 addresses for the network you deploy on.
// Testnet addresses below — update for mainnet.
export const TOKENS = [
  {
    symbol: "INJ",
    name: "Injective",
    address: NATIVE,
    decimals: 18,
    native: true,
    color: "#00b2ff",
  },
  {
    symbol: "WETH",
    name: "Wrapped Ether",
    address: process.env.REACT_APP_WETH_ADDRESS || "0x0000000000000000000000000000000000000001",
    decimals: 18,
    native: false,
    color: "#627EEA",
  },
  {
    symbol: "USDT",
    name: "Tether USD",
    address: process.env.REACT_APP_USDT_ADDRESS || "0x0000000000000000000000000000000000000002",
    decimals: 6,
    native: false,
    color: "#26A17B",
  },
  {
    symbol: "USDC",
    name: "USD Coin",
    address: process.env.REACT_APP_USDC_ADDRESS || "0x0000000000000000000000000000000000000003",
    decimals: 6,
    native: false,
    color: "#2775CA",
  },
];

const ABI = [
  "function deposit(address token, uint256 amount, bytes calldata encryptedBalance) external payable",
  "function withdraw(address token, uint256 amount, bytes calldata newEncryptedBalance) external",
  "function updateBalances(address token, address[] calldata users, bytes[] calldata balances) external",
  "function getEncryptedBalance(address token, address user) external view returns (bytes memory)",
  "function totalDeposited(address, address) external view returns (uint256)",
  "function registerPublicKey(bytes calldata pubKey) external",
  "function getPublicKey(address user) external view returns (bytes memory)",
  "function storePendingDeposit(address token, address receiver, bytes calldata payload) external",
  "function getPendingDeposits(address token, address user) external view returns (bytes[] memory)",
  "function clearPendingDeposits(address token) external",
  // Self-relay fallback — user pays gas when relayer server is down
  "function selfUpdateBalance(address token, bytes calldata newEncryptedBalance) external",
];

const ERC20_ABI = [
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
];

// ── Providers ──────────────────────────────────────────────────────────────────

function readProvider(walletProvider) {
  return walletProvider
    ? new ethers.BrowserProvider(walletProvider)
    : new ethers.JsonRpcProvider(PUBLIC_RPC);
}

function readContract(walletProvider) {
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, readProvider(walletProvider));
}

function writeContract(signer) {
  return new ethers.Contract(CONTRACT_ADDRESS, ABI, signer);
}

// ── Read ───────────────────────────────────────────────────────────────────────

export async function fetchNativeBalance(address, walletProvider) {
  const provider = readProvider(walletProvider);
  return ethers.formatEther(await provider.getBalance(address));
}

export async function fetchTokenBalance(tokenAddress, userAddress, walletProvider) {
  const provider = readProvider(walletProvider);
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [raw, decimals] = await Promise.all([
    erc20.balanceOf(userAddress),
    erc20.decimals(),
  ]);
  return ethers.formatUnits(raw, decimals);
}

export async function fetchEncryptedBalance(tokenAddress, userAddress, walletProvider) {
  const raw = await readContract(walletProvider).getEncryptedBalance(tokenAddress, userAddress);
  if (raw === "0x") return null;
  return ethers.toUtf8String(raw);
}

export async function fetchPublicKey(address, walletProvider) {
  const raw = await readContract(walletProvider).getPublicKey(address);
  if (raw === "0x" || raw.length <= 2) return null;
  return raw.slice(2);
}

export async function fetchPendingDeposits(tokenAddress, userAddress, walletProvider) {
  const raws = await readContract(walletProvider).getPendingDeposits(tokenAddress, userAddress);
  return raws.map((raw) => {
    const bytes = ethers.getBytes(raw);
    const ephemeralPubKeyHex = Array.from(bytes.slice(0, 65))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const ciphertext = ethers.toUtf8String(bytes.slice(65));
    return { ephemeralPubKeyHex, ciphertext };
  });
}

// ── ERC-20 approval helper ─────────────────────────────────────────────────────

export async function ensureAllowance(signer, tokenAddress, amountWei) {
  const provider = new ethers.BrowserProvider(signer.provider);
  const userAddress = await signer.getAddress();
  const erc20 = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const current = await erc20.allowance(userAddress, CONTRACT_ADDRESS);
  if (current < amountWei) {
    const tx = await erc20.approve(CONTRACT_ADDRESS, amountWei);
    await tx.wait();
  }
}

// ── Write ──────────────────────────────────────────────────────────────────────

export async function deposit(signer, token, amount, encryptedPayload) {
  const enc = ethers.toUtf8Bytes(encryptedPayload);
  if (token.native) {
    const tx = await writeContract(signer).deposit(
      NATIVE,
      0,
      enc,
      { value: ethers.parseEther(amount) }
    );
    return tx.wait();
  } else {
    const amountWei = ethers.parseUnits(amount, token.decimals);
    await ensureAllowance(signer, token.address, amountWei);
    const tx = await writeContract(signer).deposit(token.address, amountWei, enc);
    return tx.wait();
  }
}

export async function withdraw(signer, token, amountHuman, newEncryptedBalance) {
  const amountWei = ethers.parseUnits(amountHuman, token.decimals);
  const encBalBytes = newEncryptedBalance
    ? ethers.toUtf8Bytes(newEncryptedBalance)
    : new Uint8Array(0);
  const tx = await writeContract(signer).withdraw(token.address, amountWei, encBalBytes);
  return tx.wait();
}

export async function registerPublicKey(signer, publicKeyHex) {
  const tx = await writeContract(signer).registerPublicKey(
    ethers.getBytes("0x" + publicKeyHex)
  );
  return tx.wait();
}

export async function storePendingDeposit(signer, tokenAddress, receiverAddress, ephemeralPubKeyHex, ciphertext) {
  const ephemBytes = ethers.getBytes("0x" + ephemeralPubKeyHex);
  const cipherBytes = ethers.toUtf8Bytes(ciphertext);
  const payload = new Uint8Array(ephemBytes.length + cipherBytes.length);
  payload.set(ephemBytes);
  payload.set(cipherBytes, ephemBytes.length);
  const tx = await writeContract(signer).storePendingDeposit(tokenAddress, receiverAddress, payload);
  return tx.wait();
}

export async function clearPendingDeposits(signer, tokenAddress) {
  const tx = await writeContract(signer).clearPendingDeposits(tokenAddress);
  return tx.wait();
}

export async function sendNativeINJ(signer, to, ethAmount) {
  const tx = await signer.sendTransaction({
    to,
    value: ethers.parseEther(ethAmount),
  });
  return tx.wait();
}

// ── Relayer (with self-relay fallback) ────────────────────────────────────────

/**
 * Try the relayer server first (relayer pays gas, hides identity).
 * If the server is unreachable or returns an error, fall back to
 * selfUpdateBalance() — user pays gas directly from their wallet.
 *
 * @param {string}   tokenAddress
 * @param {string[]} users
 * @param {string[]} encryptedBalances
 * @param {object}   signer  — ethers signer, required for self-relay fallback
 */
export async function relayTransfer(tokenAddress, users, encryptedBalances, signer) {
  // ── Try server relayer ───────────────────────────────────────────────────
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000); // 8 s timeout
    const res = await fetch(`${RELAYER_URL}/relay`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: tokenAddress, users, balances: encryptedBalances }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (res.ok) return res.json();
    // Server returned an error — fall through to self-relay
    const errBody = await res.json().catch(() => ({}));
    console.warn("Relayer server error, falling back to self-relay:", errBody.error);
  } catch (fetchErr) {
    // Network error / timeout — fall through to self-relay
    console.warn("Relayer unreachable, falling back to self-relay:", fetchErr.message);
  }

  // ── Self-relay fallback ──────────────────────────────────────────────────
  if (!signer) throw new Error("Relayer offline and no signer provided for self-relay");

  // selfUpdateBalance only accepts a single user (msg.sender), so we loop
  const contract = writeContract(signer);
  const receipts = [];
  for (let i = 0; i < users.length; i++) {
    const tx = await contract.selfUpdateBalance(
      tokenAddress,
      ethers.toUtf8Bytes(encryptedBalances[i])
    );
    receipts.push(await tx.wait());
  }
  return { success: true, selfRelayed: true, txHash: receipts[0]?.hash };
}

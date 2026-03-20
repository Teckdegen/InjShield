const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { ethers } = require("ethers");
require("dotenv").config({ path: "../.env" });

const ABI = [
  "function updateBalances(address token, address[] calldata users, bytes[] calldata balances) external",
  "function getEncryptedBalance(address token, address user) external view returns (bytes memory)",
];

const app = express();

const corsOrigin = process.env.CORS_ORIGIN || "http://localhost:3000";
app.use(cors({ origin: corsOrigin, methods: ["GET", "POST"] }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

const relayLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many relay requests — slow down." },
});

const RPC_URL = process.env.RPC_URL || "https://inevm-rpc.testnet.injective.network";
const RELAYER_KEY = process.env.RELAYER_PRIVATE_KEY;
const CONTRACT = process.env.CONTRACT_ADDRESS;

if (!RELAYER_KEY || !CONTRACT) {
  console.error("Missing RELAYER_PRIVATE_KEY or CONTRACT_ADDRESS in .env");
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const wallet = new ethers.Wallet(RELAYER_KEY, provider);
const contract = new ethers.Contract(CONTRACT, ABI, wallet);

const NATIVE = "0x0000000000000000000000000000000000000000";

app.get("/health", (_req, res) => {
  res.json({ status: "ok", relayer: wallet.address, contract: CONTRACT });
});

// POST /relay  { token, users[], balances[] }
app.post("/relay", relayLimiter, async (req, res) => {
  try {
    const { token = NATIVE, users, balances } = req.body;

    if (!users || !balances || users.length !== balances.length)
      return res.status(400).json({ error: "users[] and balances[] required with matching lengths" });

    if (users.length === 0)
      return res.status(400).json({ error: "Empty arrays" });

    if (users.length > 10)
      return res.status(400).json({ error: "Batch too large (max 10)" });

    if (!ethers.isAddress(token))
      return res.status(400).json({ error: `Invalid token address: ${token}` });

    for (const addr of users) {
      if (!ethers.isAddress(addr))
        return res.status(400).json({ error: `Invalid address: ${addr}` });
    }

    const balanceBytes = balances.map((b) => ethers.toUtf8Bytes(b));

    console.log(`Relaying update — token: ${token}, users: ${users.length}`);

    const tx = await contract.updateBalances(token, users, balanceBytes);
    console.log("TX submitted:", tx.hash);
    const receipt = await tx.wait();
    console.log("TX confirmed in block:", receipt.blockNumber);

    res.json({ success: true, txHash: tx.hash, blockNumber: receipt.blockNumber });
  } catch (err) {
    console.error("Relay error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /balance/:token/:address
app.get("/balance/:token/:address", async (req, res) => {
  try {
    const { token, address } = req.params;
    if (!ethers.isAddress(token))
      return res.status(400).json({ error: "Invalid token address" });
    if (!ethers.isAddress(address))
      return res.status(400).json({ error: "Invalid user address" });

    const enc = await contract.getEncryptedBalance(token, address);
    const decoded = enc === "0x" ? "" : ethers.toUtf8String(enc);
    res.json({ encrypted: decoded });
  } catch (err) {
    console.error("Balance fetch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.RELAYER_PORT || 4000;
app.listen(PORT, () => {
  console.log(`\n🛡️  InjShield Relayer running on http://localhost:${PORT}`);
  console.log(`   Relayer wallet: ${wallet.address}`);
  console.log(`   Contract:       ${CONTRACT}`);
  console.log(`   CORS origin:    ${corsOrigin}`);
  console.log(`   RPC:            ${RPC_URL}\n`);
});

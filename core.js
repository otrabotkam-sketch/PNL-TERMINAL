// core.js — общая логика: адаптеры бирж, хранение свечей, статистика, движок стратегии.
// Подключается и десктоп-версией, и Telegram Mini App — UI-код здесь не трогаем.

// ---------- подпись HMAC-SHA256 через Web Crypto (без внешних библиотек) ----------
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function round(n, d) { const p = 10 ** d; return Math.round(n * p) / p; }

// ---------- адаптеры бирж ----------
// Публичные данные (свечи/цена) — без ключей. Ордера — только на testnet соответствующей биржи.
const EXCHANGES = {
  binance: {
    id: 'binance',
    label: 'Binance USDT-M Futures',
    testnetInfoUrl: 'https://testnet.binancefuture.com',
    publicBase: 'https://fapi.binance.com',
    testnetBase: 'https://testnet.binancefuture.com',
    exampleSymbols: ['BTCUSDT', 'ETHUSDT', 'XAUUSDT', 'XAGUSDT', 'CLUSDT', 'BZUSDT'],

    async fetchKlines(symbol, startTime, endTime) {
      const out = [];
      let cursor = startTime;
      while (cursor < endTime) {
        const url = `${this.publicBase}/fapi/v1/klines?symbol=${symbol}&interval=1h&startTime=${cursor}&endTime=${endTime}&limit=1500`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Binance ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (data.length === 0) break;
        for (const k of data) out.push([k[0], parseFloat(k[4])]);
        const last = data[data.length - 1][0];
        if (last <= cursor) break;
        cursor = last + 1;
        if (data.length < 1500) break;
      }
      return out;
    },

    async fetchPrice(symbol) {
      const res = await fetch(`${this.publicBase}/fapi/v1/ticker/price?symbol=${symbol}`);
      const d = await res.json();
      return parseFloat(d.price);
    },

    async placeOrder(symbol, side, qty, apiKey, apiSecret) {
      const timestamp = Date.now();
      const params = `symbol=${symbol}&side=${side}&type=MARKET&quantity=${qty}&timestamp=${timestamp}&recvWindow=5000`;
      const signature = await hmacSha256Hex(apiSecret, params);
      const url = `${this.testnetBase}/fapi/v1/order?${params}&signature=${signature}`;
      const res = await fetch(url, { method: 'POST', headers: { 'X-MBX-APIKEY': apiKey } });
      const body = await res.json();
      if (!res.ok) throw new Error(JSON.stringify(body));
      return body;
    }
  },

  bybit: {
    id: 'bybit',
    label: 'Bybit Linear Perpetual (USDT)',
    testnetInfoUrl: 'https://testnet.bybit.com',
    publicBase: 'https://api.bybit.com',
    testnetBase: 'https://api-testnet.bybit.com',
    exampleSymbols: ['BTCUSDT', 'ETHUSDT', 'XAUUSDT', 'XAGUSDT', 'CLUSDT'],

    async fetchKlines(symbol, startTime, endTime) {
      const out = [];
      let cursor = startTime;
      while (cursor < endTime) {
        const url = `${this.publicBase}/v5/market/kline?category=linear&symbol=${symbol}&interval=60&start=${cursor}&end=${endTime}&limit=1000`;
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Bybit ${res.status}: ${await res.text()}`);
        const j = await res.json();
        if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
        const rows = j.result.list; // приходят от новых к старым: [start,open,high,low,close,volume,turnover]
        if (rows.length === 0) break;
        const asc = rows.slice().reverse();
        for (const r of asc) out.push([parseInt(r[0], 10), parseFloat(r[4])]);
        const lastTime = parseInt(asc[asc.length - 1][0], 10);
        if (lastTime <= cursor) break;
        cursor = lastTime + 1;
        if (rows.length < 1000) break;
      }
      return out;
    },

    async fetchPrice(symbol) {
      const res = await fetch(`${this.publicBase}/v5/market/tickers?category=linear&symbol=${symbol}`);
      const j = await res.json();
      if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
      return parseFloat(j.result.list[0].lastPrice);
    },

    async placeOrder(symbol, side, qty, apiKey, apiSecret) {
      const timestamp = Date.now().toString();
      const recvWindow = '5000';
      const body = JSON.stringify({ category: 'linear', symbol, side: side === 'BUY' ? 'Buy' : 'Sell', orderType: 'Market', qty: String(qty) });
      const signStr = timestamp + apiKey + recvWindow + body;
      const signature = await hmacSha256Hex(apiSecret, signStr);
      const res = await fetch(`${this.testnetBase}/v5/order/create`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-SIGN': signature,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN-TYPE': '2'
        },
        body
      });
      const j = await res.json();
      if (j.retCode !== 0) throw new Error(`Bybit: ${j.retMsg}`);
      return j;
    }
  }
};

// ---------- локальное хранилище свечей (localStorage, отдельно по бирже+символу) ----------
function storageKey(exchangeId, symbol) { return `pairbot_${exchangeId}_${symbol.toUpperCase()}`; }

function loadCandles(exchangeId, symbol) {
  try { return JSON.parse(localStorage.getItem(storageKey(exchangeId, symbol))) || []; }
  catch (e) { return []; }
}

function saveCandles(exchangeId, symbol, arr) {
  localStorage.setItem(storageKey(exchangeId, symbol), JSON.stringify(arr));
}

async function loadOrUpdateHistory(exchangeId, symbol, onLog) {
  const ex = EXCHANGES[exchangeId];
  const existing = loadCandles(exchangeId, symbol);
  const now = Date.now();
  let startTime;
  if (existing.length === 0) {
    startTime = now - 365 * 24 * 60 * 60 * 1000;
    onLog && onLog(`${symbol}: качаю год истории с нуля…`);
  } else {
    startTime = existing[existing.length - 1][0] + 1;
    onLog && onLog(`${symbol}: догружаю новые свечи с ${new Date(startTime).toLocaleString()}…`);
  }
  const fresh = await ex.fetchKlines(symbol, startTime, now);
  const merged = existing.concat(fresh);
  const seen = new Set();
  const dedup = [];
  for (const c of merged) { if (!seen.has(c[0])) { seen.add(c[0]); dedup.push(c); } }
  dedup.sort((a, b) => a[0] - b[0]);
  saveCandles(exchangeId, symbol, dedup);
  onLog && onLog(`${symbol}: сохранено свечей — ${dedup.length} (новых: ${fresh.length}).`);
  return dedup;
}

// ---------- статистика по отношению A/B ----------
function computeStats(candlesA, candlesB, windowSel) {
  if (candlesA.length === 0 || candlesB.length === 0) return null;
  const mapB = new Map(candlesB.map(c => [c[0], c[1]]));
  const ratios = [];
  for (const [t, closeA] of candlesA) {
    const closeB = mapB.get(t);
    if (closeB) ratios.push({ t, ratio: closeA / closeB });
  }
  const windowed = windowSel > 0 ? ratios.slice(-windowSel) : ratios;
  if (windowed.length < 10) return { error: 'not_enough_data', series: [] };
  const vals = windowed.map(r => r.ratio);
  const mean = vals.reduce((s, v) => s + v, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  const std = Math.sqrt(variance);
  const series = ratios.map(r => ({ t: r.t, ratio: r.ratio, z: std ? (r.ratio - mean) / std : 0 }));
  return { mean, std, series, n: windowed.length };
}

// ---------- движок стратегии, не зависящий от UI ----------
// hooks: onLog(msg,cls), onTick({priceA,priceB,ratio,z,position}), onPosition(position)
class PairBotEngine {
  constructor({ exchangeId, symA, symB, stats, openZ, closeZ, notional, mode, apiKey, apiSecret, hooks }) {
    Object.assign(this, { exchangeId, symA, symB, stats, openZ, closeZ, notional, mode, apiKey, apiSecret });
    this.hooks = hooks || {};
    this.position = 'flat';
    this.timer = null;
  }
  log(msg, cls) { this.hooks.onLog && this.hooks.onLog(msg, cls); }

  async tick() {
    const ex = EXCHANGES[this.exchangeId];
    try {
      const [priceA, priceB] = await Promise.all([ex.fetchPrice(this.symA), ex.fetchPrice(this.symB)]);
      const ratio = priceA / priceB;
      const z = this.stats && this.stats.std ? (ratio - this.stats.mean) / this.stats.std : null;
      this.hooks.onTick && this.hooks.onTick({ priceA, priceB, ratio, z, position: this.position });
      if (z === null) return;

      if (this.position === 'flat') {
        if (Math.abs(z) >= this.openZ) {
          const shortSpread = z >= this.openZ; // A относительно дорог
          const qtyA = round(this.notional / priceA, 4);
          const qtyB = round(this.notional / priceB, 4);
          const sideA = shortSpread ? 'SELL' : 'BUY';
          const sideB = shortSpread ? 'BUY' : 'SELL';
          this.log(`Сигнал входа (z=${z.toFixed(2)}): ${sideA} ${this.symA} ${qtyA}, ${sideB} ${this.symB} ${qtyB} [${this.mode}]`);
          if (this.mode === 'testnet') {
            await ex.placeOrder(this.symA, sideA, qtyA, this.apiKey, this.apiSecret);
            await ex.placeOrder(this.symB, sideB, qtyB, this.apiKey, this.apiSecret);
          }
          this.position = shortSpread ? 'short' : 'long';
          this.qtyA = qtyA; this.qtyB = qtyB; this.sideA = sideA; this.sideB = sideB;
          this.hooks.onPosition && this.hooks.onPosition(this.position);
        }
      } else {
        if (Math.abs(z) <= this.closeZ) {
          const closeSideA = this.sideA === 'BUY' ? 'SELL' : 'BUY';
          const closeSideB = this.sideB === 'BUY' ? 'SELL' : 'BUY';
          this.log(`Сигнал выхода (z=${z.toFixed(2)}): закрываю — ${closeSideA} ${this.symA} ${this.qtyA}, ${closeSideB} ${this.symB} ${this.qtyB} [${this.mode}]`);
          if (this.mode === 'testnet') {
            await ex.placeOrder(this.symA, closeSideA, this.qtyA, this.apiKey, this.apiSecret);
            await ex.placeOrder(this.symB, closeSideB, this.qtyB, this.apiKey, this.apiSecret);
          }
          this.position = 'flat';
          this.hooks.onPosition && this.hooks.onPosition(this.position);
        }
      }
    } catch (e) {
      this.log('Ошибка в цикле: ' + e.message, 'err');
    }
  }

  start(pollSec) {
    this.tick();
    this.timer = setInterval(() => this.tick(), Math.max(5, pollSec) * 1000);
  }
  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

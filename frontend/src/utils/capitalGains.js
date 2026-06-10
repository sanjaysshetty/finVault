// Shared FIFO gain calculators used by CapitalGains page and TaxReturn page.
// All functions are pure — no React, no API calls.
import { safeNum, round2 } from "./format.js";

export function daysBetween(d1, d2) {
  return (new Date(d2).getTime() - new Date(d1).getTime()) / 86400000;
}

export function toArr(data) {
  return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
}

export function calcStocks(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  const sorted = [...txs].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const lots = {};
  let st = 0, lt = 0;
  const details = [];

  for (const t of sorted) {
    const sym  = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const qty  = safeNum(t.shares, 0), price = safeNum(t.price, 0), fees = safeNum(t.fees, 0);
    if (qty <= 0) continue;
    if (!lots[sym]) lots[sym] = [];
    if (type === "BUY") {
      lots[sym].push({ date: t.date || "", qty, cpu: (qty * price + fees) / qty });
    } else if (type === "SELL") {
      const netPu = (qty * price - fees) / qty;
      const isCY  = t.date >= yS && t.date <= yE;
      let rem = qty;
      while (rem > 0 && lots[sym].length > 0) {
        const lot  = lots[sym][0];
        const used = Math.min(rem, lot.qty);
        const days = lot.date ? daysBetween(lot.date, t.date) : 0;
        const gain = used * (netPu - lot.cpu);
        const term = days > 365 ? "LT" : "ST";
        if (isCY) {
          term === "LT" ? (lt += gain) : (st += gain);
          details.push({ symbol: sym, buyDate: lot.date, sellDate: t.date, shares: used, cpu: lot.cpu, netPu, days: Math.floor(days), gain: round2(gain), term });
        }
        lot.qty -= used; rem -= used;
        if (lot.qty <= 0) lots[sym].shift();
      }
    }
  }
  return { st: round2(st), lt: round2(lt), details };
}

export function calcCrypto(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  const sorted = [...txs].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const lots = {};
  let st = 0, lt = 0;
  const details = [];

  for (const t of sorted) {
    const sym  = String(t.symbol || "").toUpperCase().trim();
    if (!sym) continue;
    const type = String(t.type || "BUY").toUpperCase();
    const qty  = safeNum(t.quantity, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    if (qty <= 0) continue;
    if (!lots[sym]) lots[sym] = [];
    if (type === "BUY") {
      lots[sym].push({ date: t.date || "", qty, cpu: (qty * price + fees) / qty });
    } else if (type === "SELL") {
      const netPu = (qty * price - fees) / qty;
      const isCY  = t.date >= yS && t.date <= yE;
      let rem = qty;
      while (rem > 0 && lots[sym].length > 0) {
        const lot  = lots[sym][0];
        const used = Math.min(rem, lot.qty);
        const days = lot.date ? daysBetween(lot.date, t.date) : 0;
        const gain = used * (netPu - lot.cpu);
        const term = days > 365 ? "LT" : "ST";
        if (isCY) {
          term === "LT" ? (lt += gain) : (st += gain);
          details.push({ symbol: sym, buyDate: lot.date, sellDate: t.date, qty: used, cpu: lot.cpu, netPu, days: Math.floor(days), gain: round2(gain), term });
        }
        lot.qty -= used; rem -= used;
        if (lot.qty <= 0) lots[sym].shift();
      }
    }
  }
  return { st: round2(st), lt: round2(lt), details };
}

export function calcBullion(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  const sorted = [...txs].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const lots = {};
  let st = 0, lt = 0;
  const details = [];

  for (const t of sorted) {
    const metal = String(t.metal || "GOLD").toUpperCase();
    const type  = String(t.type  || "BUY").toUpperCase();
    const qty   = safeNum(t.quantityOz, 0), price = safeNum(t.unitPrice, 0), fees = safeNum(t.fees, 0);
    if (qty <= 0) continue;
    if (!lots[metal]) lots[metal] = [];
    if (type === "BUY") {
      lots[metal].push({ date: t.date || "", qty, cpu: (qty * price + fees) / qty });
    } else if (type === "SELL") {
      const netPu = (qty * price - fees) / qty;
      const isCY  = t.date >= yS && t.date <= yE;
      let rem = qty;
      while (rem > 0 && lots[metal].length > 0) {
        const lot  = lots[metal][0];
        const used = Math.min(rem, lot.qty);
        const days = lot.date ? daysBetween(lot.date, t.date) : 0;
        const gain = used * (netPu - lot.cpu);
        const term = days > 365 ? "LT" : "ST";
        if (isCY) {
          term === "LT" ? (lt += gain) : (st += gain);
          details.push({ metal, buyDate: lot.date, sellDate: t.date, oz: used, cpu: lot.cpu, netPu, days: Math.floor(days), gain: round2(gain), term });
        }
        lot.qty -= used; rem -= used;
        if (lot.qty <= 0) lots[metal].shift();
      }
    }
  }
  return { st: round2(st), lt: round2(lt), details };
}

export function calcOptions(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  let st = 0, lt = 0;
  const details = [];

  const CLOSE_LEGS = new Set(["CLOSE", "ROLL_CLOSE", "ASSIGN"]);
  const OPEN_LEGS  = new Set(["OPEN",  "ROLL_OPEN"]);

  const v2Txs     = txs.filter(t => t.positionId && t.leg);
  const legacyTxs = txs.filter(t => !(t.positionId && t.leg));

  const byPos = {};
  for (const t of v2Txs) {
    if (!byPos[t.positionId]) byPos[t.positionId] = { opens: [], closes: [] };
    if (CLOSE_LEGS.has(t.leg))     byPos[t.positionId].closes.push(t);
    else if (OPEN_LEGS.has(t.leg)) byPos[t.positionId].opens.push(t);
  }

  for (const pos of Object.values(byPos)) {
    if (!pos.opens.length && pos.closes.length) {
      const pid = pos.closes[0].positionId;
      const legacyOpen = legacyTxs.find(t => (t.txId || t.assetId) === pid);
      if (legacyOpen) pos.opens.push(legacyOpen);
    }
  }

  for (const pos of Object.values(byPos)) {
    if (!pos.closes.length || !pos.opens.length) continue;
    const openLeg  = pos.opens[0];
    const closeLeg = pos.closes[0];
    const closeDate = String(closeLeg.openDate || closeLeg.closeDate || "").trim();
    if (!closeDate || closeDate < yS || closeDate > yE) continue;
    const openDate = String(openLeg.openDate || "").trim();
    const typeU    = String(openLeg.type || "").toUpperCase();
    const qty      = safeNum(openLeg.qty, 0);
    if (qty <= 0) continue;
    const openFill  = safeNum(openLeg.fill, 0);
    const closeFill = safeNum(closeLeg.fill, 0);
    const openFee   = safeNum(openLeg.fee, 0);
    const closeFee  = safeNum(closeLeg.fee, 0);
    const totalFee  = openFee + closeFee;
    let pl;
    if      (typeU === "SELL") pl = (openFill - closeFill) * qty * 100 - totalFee;
    else if (typeU === "BUY")  pl = (closeFill - openFill) * qty * 100 - totalFee;
    else if (typeU === "ASS")  pl = (closeFill - openFill) * qty * 100 - totalFee;
    else continue;
    const days = openDate ? daysBetween(openDate, closeDate) : 0;
    const term = days > 365 ? "LT" : "ST";
    term === "LT" ? (lt += pl) : (st += pl);
    details.push({
      ticker: String(openLeg.ticker || "").toUpperCase(),
      type: typeU, strike: openLeg.strikes || "—",
      event: String(openLeg.event || "").toLowerCase(),
      openDate, closeDate, days: Math.floor(days),
      fill: openFill, closePrice: closeFill, qty, fee: round2(totalFee), pl: round2(pl), term,
    });
  }

  for (const t of legacyTxs) {
    const closeDate = String(t.closeDate || "").trim();
    if (!closeDate || closeDate < yS || closeDate > yE) continue;
    const typeU = String(t.type || "").toUpperCase();
    const qty   = safeNum(t.qty, 0);
    const fill  = safeNum(t.fill, 0);
    const fee   = safeNum(t.fee, 0);
    const close = (t.closePrice !== "" && t.closePrice != null) ? safeNum(t.closePrice, NaN) : NaN;
    if (!Number.isFinite(close)) continue;
    let pl;
    if      (typeU === "SELL") pl = (fill - close - fee / 100) * qty * 100;
    else if (typeU === "BUY")  pl = (close - fill - fee / 100) * qty * 100;
    else if (typeU === "ASS")  pl = (close - fill - fee / 100) * qty * 100;
    else if (typeU === "SDI")  pl = (close - fill) * qty - fee;
    else continue;
    const openDate = String(t.openDate || "").trim();
    const days = openDate ? daysBetween(openDate, closeDate) : 0;
    const term = days > 365 ? "LT" : "ST";
    term === "LT" ? (lt += pl) : (st += pl);
    details.push({
      ticker: String(t.ticker || "").toUpperCase(),
      type: typeU, strike: t.strikes || "—",
      event: String(t.event || "").toLowerCase(),
      openDate, closeDate, days: Math.floor(days),
      fill, closePrice: close, qty, fee, pl: round2(pl), term,
    });
  }

  details.sort((a, b) => String(b.closeDate || "").localeCompare(String(a.closeDate || "")));
  return { st: round2(st), lt: round2(lt), details };
}

export function calcFutures(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  const sorted = [...txs].sort((a, b) => {
    const d = String(a.tradeDate || "").localeCompare(String(b.tradeDate || ""));
    return d !== 0 ? d : String(a.createdAt || "").localeCompare(String(b.createdAt || ""));
  });
  const state = {};
  let netPL = 0;
  const details = [];

  for (const tx of sorted) {
    const ticker = String(tx.ticker || "").toUpperCase();
    if (!ticker) continue;
    if (!state[ticker]) state[ticker] = { longQ: [], shortQ: [] };
    const s     = state[ticker];
    const type  = String(tx.type || "").toUpperCase();
    const pv    = safeNum(tx.pointValue, 50);
    const qty   = safeNum(tx.qty, 0);
    const price = safeNum(tx.price, 0);
    const fees  = safeNum(tx.fees, 0);
    const fpq   = qty > 0 ? fees / qty : 0;
    const td    = tx.tradeDate || "";
    const isCY  = td >= yS && td <= yE;

    if (type === "BUY") {
      let rem = qty;
      while (rem > 0 && s.shortQ.length > 0) {
        const o  = s.shortQ[0];
        const cq = Math.min(rem, o.qty);
        const pl = (o.price - price) * cq * pv - cq * fpq - cq * o.fpq;
        if (isCY) {
          netPL += pl;
          details.push({ ticker, direction: "SHORT→COVER", openDate: o.openDate || "", closeDate: td, qty: cq, entryPrice: o.price, exitPrice: price, pointValue: pv, pl: round2(pl) });
        }
        o.qty -= cq; rem -= cq;
        if (o.qty <= 0) s.shortQ.shift();
      }
      if (rem > 0) s.longQ.push({ price, qty: rem, fpq, openDate: td });
    } else if (type === "SELL") {
      let rem = qty;
      while (rem > 0 && s.longQ.length > 0) {
        const o  = s.longQ[0];
        const cq = Math.min(rem, o.qty);
        const pl = (price - o.price) * cq * pv - cq * fpq - cq * o.fpq;
        if (isCY) {
          netPL += pl;
          details.push({ ticker, direction: "LONG→SELL", openDate: o.openDate || "", closeDate: td, qty: cq, entryPrice: o.price, exitPrice: price, pointValue: pv, pl: round2(pl) });
        }
        o.qty -= cq; rem -= cq;
        if (o.qty <= 0) s.longQ.shift();
      }
      if (rem > 0) s.shortQ.push({ price, qty: rem, fpq, openDate: td });
    } else if (type === "SUMMARY") {
      if (isCY) {
        const pl = safeNum(tx.grossPL, 0);
        netPL += pl;
        details.push({ ticker, direction: "SUMMARY", openDate: td, closeDate: td, qty: safeNum(tx.qty, 0), entryPrice: 0, exitPrice: 0, pointValue: pv, pl: round2(pl) });
      }
    }
  }
  return { st: round2(netPL * 0.4), lt: round2(netPL * 0.6), netPL: round2(netPL), details };
}

export function computeScheduleD(stocks, crypto, bullion, options, futures) {
  const rawST    = stocks.st + crypto.st + options.st + futures.st + bullion.st;
  const rawRegLT = stocks.lt + crypto.lt + options.lt + futures.lt;
  const rawCollLT = bullion.lt;

  let netST    = rawST;
  let netRegLT = rawRegLT;
  let netCollLT = rawCollLT;

  if (netST < 0) {
    if (netCollLT > 0) { const u = Math.min(-netST, netCollLT); netCollLT -= u; netST += u; }
    if (netST < 0 && netRegLT > 0) { const u = Math.min(-netST, netRegLT); netRegLT -= u; netST += u; }
  }
  if (netRegLT < 0 && netST > 0) { const u = Math.min(-netRegLT, netST); netST -= u; netRegLT += u; }
  if (netCollLT < 0 && netST > 0) { const u = Math.min(-netCollLT, netST); netST -= u; netCollLT += u; }

  const totalNet       = round2(netST + netRegLT + netCollLT);
  const deductibleLoss = totalNet < 0 ? Math.max(totalNet, -3000) : 0;
  const carryforward   = totalNet < -3000 ? round2(-(totalNet + 3000)) : 0;

  return {
    rawST: round2(rawST), rawRegLT: round2(rawRegLT), rawCollLT: round2(rawCollLT),
    netST: round2(netST), netRegLT: round2(netRegLT), netCollLT: round2(netCollLT),
    totalNet, deductibleLoss: round2(deductibleLoss), carryforward,
  };
}

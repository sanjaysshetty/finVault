import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import { api, queryKeys } from "../api/client.js";
import { PageHeader } from "../components/ui/PageHeader.jsx";
import { PageIcons } from "../components/ui/PageIcons.jsx";
import { safeNum, round2, formatMoney, plColorClass } from "../utils/format.js";

// ── IRS Tax Brackets (2025, Single Filer) ─────────────────────────────────
const BRACKETS = [
  { label: "10 – 12%", ordinary: 0.12, lt: 0.00, collLT: 0.12 },
  { label: "22%",      ordinary: 0.22, lt: 0.15, collLT: 0.22 },
  { label: "24%",      ordinary: 0.24, lt: 0.15, collLT: 0.24 },
  { label: "32%",      ordinary: 0.32, lt: 0.15, collLT: 0.28 },
  { label: "35%",      ordinary: 0.35, lt: 0.15, collLT: 0.28 },
  { label: "37%",      ordinary: 0.37, lt: 0.20, collLT: 0.28 },
];

const CY = new Date().getFullYear();
const YEARS = [CY, CY - 1, CY - 2, CY - 3];

// ── Helpers ────────────────────────────────────────────────────────────────

function toArr(data) {
  return Array.isArray(data?.items) ? data.items : Array.isArray(data) ? data : [];
}

function daysBetween(d1, d2) {
  return (new Date(d2).getTime() - new Date(d1).getTime()) / 86400000;
}

function fmtDate(d) {
  if (!d) return "—";
  try { return new Date(d + "T12:00:00Z").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return d; }
}

// ── Gain calculators (return aggregate + per-lot detail) ──────────────────

function calcStocks(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  const sorted = [...txs].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")));
  const lots = {}; // sym → [{date, qty, cpu}]
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

function calcCrypto(txs, year) {
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

function calcBullion(txs, year) {
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

function calcOptions(txs, year) {
  const [yS, yE] = [`${year}-01-01`, `${year}-12-31`];
  let st = 0, lt = 0;
  const details = [];

  for (const t of txs) {
    const closeDate = String(t.closeDate || "").trim();
    if (!closeDate || closeDate < yS || closeDate > yE) continue;
    const typeU = String(t.type || "").toUpperCase();
    const qty   = safeNum(t.qty, 0);
    const fill  = safeNum(t.fill, 0);
    const fee   = safeNum(t.fee, 0);
    const close = (t.closePrice !== "" && t.closePrice != null)
      ? safeNum(t.closePrice, NaN) : NaN;
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
      type: typeU,
      strike: t.strikes || "—",
      event: String(t.event || "").toLowerCase(),
      openDate,
      closeDate,
      days: Math.floor(days),
      fill,
      closePrice: close,
      qty,
      fee,
      pl: round2(pl),
      term,
    });
  }
  return { st: round2(st), lt: round2(lt), details };
}

function calcFutures(txs, year) {
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

// ── Schedule D Netting ─────────────────────────────────────────────────────

function computeScheduleD(stocks, crypto, bullion, options, futures) {
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

function estimateTax(schedD, bracket) {
  const { netST, netRegLT, netCollLT } = schedD;
  const { ordinary, lt, collLT } = bracket;
  const stTax   = netST    > 0 ? round2(netST    * ordinary)                    : 0;
  const regTax  = netRegLT > 0 ? round2(netRegLT * lt)                          : 0;
  const collTax = netCollLT > 0 ? round2(netCollLT * Math.min(collLT, ordinary)) : 0;
  return { stTax, regTax, collTax, total: round2(stTax + regTax + collTax) };
}

// ── UI helpers ─────────────────────────────────────────────────────────────

function fmtGain(n) {
  const cls  = n > 0 ? "text-emerald-400" : n < 0 ? "text-red-400" : "text-slate-500";
  const sign = n > 0 ? "+" : "";
  return <span className={`font-semibold tabular-nums ${cls}`}>{sign}{formatMoney(n)}</span>;
}

function TermBadge({ term }) {
  return term === "LT"
    ? <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-blue-500/[0.15] text-blue-400">LT</span>
    : <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-500/[0.15] text-amber-400">ST</span>;
}

// ── Detail tables ──────────────────────────────────────────────────────────

function StocksDetail({ details }) {
  if (!details.length) return <EmptyDetail />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {["Symbol","Buy Date","Sell Date","Days","Shares","Cost/sh","Proceeds/sh","Gain / Loss","Term"].map(h => (
              <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {details.map((d, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-semibold text-slate-200">{d.symbol}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.buyDate)}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.sellDate)}</td>
              <td className="px-3 py-2 text-slate-400">{d.days}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{d.shares.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.cpu)}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.netPu)}</td>
              <td className="px-3 py-2">{fmtGain(d.gain)}</td>
              <td className="px-3 py-2"><TermBadge term={d.term} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CryptoDetail({ details }) {
  if (!details.length) return <EmptyDetail />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {["Symbol","Buy Date","Sell Date","Days","Qty","Cost/unit","Proceeds/unit","Gain / Loss","Term"].map(h => (
              <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {details.map((d, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-semibold text-slate-200">{d.symbol}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.buyDate)}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.sellDate)}</td>
              <td className="px-3 py-2 text-slate-400">{d.days}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{d.qty.toLocaleString("en-US", { maximumFractionDigits: 8 })}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.cpu)}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.netPu)}</td>
              <td className="px-3 py-2">{fmtGain(d.gain)}</td>
              <td className="px-3 py-2"><TermBadge term={d.term} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BullionDetail({ details }) {
  if (!details.length) return <EmptyDetail />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {["Metal","Buy Date","Sell Date","Days","Oz","Cost/oz","Proceeds/oz","Gain / Loss","Term"].map(h => (
              <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {details.map((d, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-semibold text-slate-200">{d.metal}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.buyDate)}</td>
              <td className="px-3 py-2 text-slate-400">{fmtDate(d.sellDate)}</td>
              <td className="px-3 py-2 text-slate-400">{d.days}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{d.oz.toFixed(3)}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.cpu)}</td>
              <td className="px-3 py-2 text-slate-400 tabular-nums">{formatMoney(d.netPu)}</td>
              <td className="px-3 py-2">{fmtGain(d.gain)}</td>
              <td className="px-3 py-2"><TermBadge term={d.term} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OptionsDetail({ details }) {
  if (!details.length) return <EmptyDetail />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-xs">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {["Ticker","Type","Event","Strike","Open Date","Close Date","Days","Fill","Close","Qty","Fee","P&L","Term"].map(h => (
              <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {details.map((d, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-semibold text-slate-200">{d.ticker || "—"}</td>
              <td className="px-3 py-2 text-slate-400">{d.type}</td>
              <td className="px-3 py-2 text-slate-400 capitalize">{d.event || "—"}</td>
              <td className="px-3 py-2 text-slate-400">{d.strike}</td>
              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(d.openDate)}</td>
              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(d.closeDate)}</td>
              <td className="px-3 py-2 text-slate-400">{d.days}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{formatMoney(d.fill)}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{formatMoney(d.closePrice)}</td>
              <td className="px-3 py-2 text-slate-400">{d.qty}</td>
              <td className="px-3 py-2 text-slate-500 tabular-nums">{formatMoney(d.fee)}</td>
              <td className="px-3 py-2">{fmtGain(d.pl)}</td>
              <td className="px-3 py-2"><TermBadge term={d.term} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FuturesDetail({ details, netPL }) {
  if (!details.length) return <EmptyDetail />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[680px] text-xs">
        <thead>
          <tr className="border-b border-white/[0.06]">
            {["Ticker","Direction","Open Date","Close Date","Qty","Entry","Exit","Pt Val","Trade P&L","Sec. 1256 Split"].map(h => (
              <th key={h} className="px-3 py-2 text-left font-semibold uppercase tracking-wide text-slate-600 whitespace-nowrap">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {details.map((d, i) => (
            <tr key={i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="px-3 py-2 font-semibold text-slate-200">{d.ticker}</td>
              <td className="px-3 py-2 text-slate-400">{d.direction}</td>
              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(d.openDate)}</td>
              <td className="px-3 py-2 text-slate-400 whitespace-nowrap">{fmtDate(d.closeDate)}</td>
              <td className="px-3 py-2 text-slate-400">{d.qty}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{d.direction === "SUMMARY" ? "—" : d.entryPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-slate-300 tabular-nums">{d.direction === "SUMMARY" ? "—" : d.exitPrice.toLocaleString("en-US", { minimumFractionDigits: 2 })}</td>
              <td className="px-3 py-2 text-slate-400">{d.pointValue}</td>
              <td className="px-3 py-2">{fmtGain(d.pl)}</td>
              <td className="px-3 py-2 text-slate-600 whitespace-nowrap">40% ST / 60% LT on net</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-white/[0.06]">
            <td colSpan={8} className="px-3 py-2 text-right text-xs text-slate-500 font-semibold">Net P&L → 40% ST / 60% LT:</td>
            <td className="px-3 py-2">
              <span className={`font-bold tabular-nums ${netPL >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                {netPL >= 0 ? "+" : ""}{formatMoney(netPL)}
              </span>
            </td>
            <td className="px-3 py-2 text-slate-600 text-xs whitespace-nowrap">
              ST {formatMoney(round2(netPL * 0.4))} · LT {formatMoney(round2(netPL * 0.6))}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function EmptyDetail() {
  return (
    <div className="px-4 py-6 text-center text-xs text-slate-600">
      No closed positions in this tax year.
    </div>
  );
}

// ── Asset row with collapsible detail ──────────────────────────────────────

function AssetRow({ label, note, st, lt, total, stLabel = "Short-Term", ltLabel = "Long-Term", expanded, onToggle, children, count }) {
  return (
    <div className="border-b border-white/[0.04] last:border-0">
      {/* Summary row */}
      <div
        className="grid items-center px-4 py-3.5 cursor-pointer hover:bg-white/[0.03] transition-colors
          [grid-template-columns:1fr_120px_120px_120px_32px] gap-x-2 min-w-[560px]"
        onClick={onToggle}
      >
        <div>
          <div className="text-sm font-semibold text-slate-200">{label}
            {count > 0 && <span className="ml-2 text-[11px] text-slate-600">{count} lot{count !== 1 ? "s" : ""}</span>}
          </div>
          {note && <div className="text-[11px] text-slate-600 mt-0.5">{note}</div>}
        </div>
        <div className="text-right">
          {fmtGain(st)}
          <div className="text-[10px] text-slate-600 mt-0.5">{stLabel}</div>
        </div>
        <div className="text-right">
          {fmtGain(lt)}
          <div className="text-[10px] text-slate-600 mt-0.5">{ltLabel}</div>
        </div>
        <div className="text-right">
          {fmtGain(total)}
          <div className="text-[10px] text-slate-600 mt-0.5">Net</div>
        </div>
        <div className="flex justify-center">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
            className={`w-3.5 h-3.5 text-slate-600 transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 9l6 6 6-6" />
          </svg>
        </div>
      </div>

      {/* Detail table */}
      {expanded && (
        <div className="border-t border-white/[0.04] bg-white/[0.01]">
          {children}
        </div>
      )}
    </div>
  );
}

// ── Summary & tax UI components ────────────────────────────────────────────

function SummaryCard({ label, value, sub }) {
  return (
    <div className="rounded-2xl border border-white/[0.07] bg-white/[0.02] px-5 py-4 flex flex-col gap-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`text-xl font-black tracking-tight tabular-nums ${plColorClass(value)}`}
        style={{ fontFamily: "Epilogue, sans-serif" }}>
        {value > 0 ? "+" : ""}{formatMoney(value)}
      </div>
      {sub && <div className="text-[11px] text-slate-600">{sub}</div>}
    </div>
  );
}

function TaxCard({ value }) {
  return (
    <div className="rounded-2xl border border-amber-500/[0.2] bg-amber-500/[0.04] px-5 py-4 flex flex-col gap-1">
      <div className="text-xs font-semibold uppercase tracking-wide text-amber-600/80">Est. Tax Liability</div>
      <div className="text-xl font-black tracking-tight tabular-nums text-amber-400"
        style={{ fontFamily: "Epilogue, sans-serif" }}>
        {formatMoney(value)}
      </div>
      <div className="text-[11px] text-slate-600">Bracket-based estimate</div>
    </div>
  );
}

function NettingRow({ label, value, sub }) {
  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div>
        <div className="text-sm text-slate-400">{label}</div>
        {sub && <div className="text-[11px] text-slate-600">{sub}</div>}
      </div>
      {fmtGain(value)}
    </div>
  );
}

// ── Page ───────────────────────────────────────────────────────────────────

export default function CapitalGains() {
  const [year, setYear]             = useState(CY);
  const [bracketIdx, setBracketIdx] = useState(2);
  const [expanded, setExpanded]     = useState({});
  const bracket = BRACKETS[bracketIdx];

  const toggle = (key) => setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));

  const results = useQueries({
    queries: [
      { queryKey: queryKeys.stocksTx(),  queryFn: () => api.get("/assets/stocks/transactions"),  staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.cryptoTx(),  queryFn: () => api.get("/assets/crypto/transactions"),  staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.bullionTx(), queryFn: () => api.get("/assets/bullion/transactions"), staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.optionsTx(), queryFn: () => api.get("/assets/options/transactions"), staleTime: 5 * 60 * 1000 },
      { queryKey: queryKeys.futuresTx(), queryFn: () => api.get("/assets/futures/transactions"), staleTime: 5 * 60 * 1000 },
    ],
  });

  const isLoading = results.some((r) => r.isLoading);
  const isError   = results.some((r) => r.isError);

  const gains = useMemo(() => {
    if (isLoading || isError) return null;
    const [sTx, cTx, bTx, oTx, fTx] = results.map((r) => toArr(r.data));
    const stocks  = calcStocks(sTx, year);
    const crypto  = calcCrypto(cTx, year);
    const bullion = calcBullion(bTx, year);
    const options = calcOptions(oTx, year);
    const futures = calcFutures(fTx, year);
    const schedD  = computeScheduleD(stocks, crypto, bullion, options, futures);
    return { stocks, crypto, bullion, options, futures, schedD };
  }, [results, year, isLoading, isError]); // eslint-disable-line react-hooks/exhaustive-deps

  const tax = gains ? estimateTax(gains.schedD, bracket) : null;

  return (
    <div className="flex flex-col gap-6 p-6 max-w-5xl mx-auto">

      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeader
          title="Capital Gains"
          subtitle={`${year} realized gains · IRS Schedule D`}
          icon={PageIcons.capitalGains}
        />
        <div className="flex items-center gap-2 shrink-0">
          <label className="text-xs text-slate-500 whitespace-nowrap">Tax Year</label>
          <select
            value={year}
            onChange={(e) => { setYear(Number(e.target.value)); setExpanded({}); }}
            className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500/50 cursor-pointer"
          >
            {YEARS.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {isLoading && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] px-4 py-12 text-center text-slate-500 text-sm">
          Loading transactions…
        </div>
      )}
      {isError && (
        <div className="rounded-2xl border border-red-500/[0.2] bg-red-500/[0.05] px-4 py-8 text-center text-red-400 text-sm">
          Failed to load transaction data.
        </div>
      )}

      {gains && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard label="Short-Term Gains"  value={gains.schedD.rawST}     sub="Ordinary income rate" />
            <SummaryCard label="LT Regular Gains"  value={gains.schedD.rawRegLT}  sub={`${(bracket.lt * 100).toFixed(0)}% rate · stocks, crypto, options`} />
            <SummaryCard label="Collectibles LT"   value={gains.schedD.rawCollLT} sub="Max 28% · bullion" />
            <TaxCard value={tax.total} />
          </div>

          {/* Asset breakdown with collapsible detail */}
          <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wide text-slate-500">
                Realized Gains by Asset Type
              </span>
              <span className="text-[11px] text-slate-600">Click a row to see transaction detail</span>
            </div>
            <div className="overflow-x-auto">
              {/* Column headers */}
              <div className="grid items-center px-4 py-2 bg-white/[0.01]
                [grid-template-columns:1fr_120px_120px_120px_32px] gap-x-2 min-w-[560px]">
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600">Asset</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600 text-right">Short-Term</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600 text-right">Long-Term</span>
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-600 text-right">Net</span>
                <span />
              </div>

              <AssetRow
                label="Stocks" note="Standard ST / LT · FIFO"
                st={gains.stocks.st} lt={gains.stocks.lt}
                total={round2(gains.stocks.st + gains.stocks.lt)}
                count={gains.stocks.details.length}
                expanded={!!expanded.stocks} onToggle={() => toggle("stocks")}
              >
                <StocksDetail details={gains.stocks.details} />
              </AssetRow>

              <AssetRow
                label="Crypto" note="Property · IRS Notice 2014-21 · FIFO"
                st={gains.crypto.st} lt={gains.crypto.lt}
                total={round2(gains.crypto.st + gains.crypto.lt)}
                count={gains.crypto.details.length}
                expanded={!!expanded.crypto} onToggle={() => toggle("crypto")}
              >
                <CryptoDetail details={gains.crypto.details} />
              </AssetRow>

              <AssetRow
                label="Bullion" note="Collectibles · IRC §1(h)(4) · FIFO"
                st={gains.bullion.st} lt={gains.bullion.lt}
                total={round2(gains.bullion.st + gains.bullion.lt)}
                ltLabel="LT (Collectibles ≤28%)"
                count={gains.bullion.details.length}
                expanded={!!expanded.bullion} onToggle={() => toggle("bullion")}
              >
                <BullionDetail details={gains.bullion.details} />
              </AssetRow>

              <AssetRow
                label="Options" note="Closed positions only · openDate → closeDate"
                st={gains.options.st} lt={gains.options.lt}
                total={round2(gains.options.st + gains.options.lt)}
                count={gains.options.details.length}
                expanded={!!expanded.options} onToggle={() => toggle("options")}
              >
                <OptionsDetail details={gains.options.details} />
              </AssetRow>

              <AssetRow
                label="Futures" note="Section 1256 · 60 / 40 rule"
                st={gains.futures.st} lt={gains.futures.lt}
                total={gains.futures.netPL}
                stLabel="40% ST allocation" ltLabel="60% LT allocation"
                count={gains.futures.details.length}
                expanded={!!expanded.futures} onToggle={() => toggle("futures")}
              >
                <FuturesDetail details={gains.futures.details} netPL={gains.futures.netPL} />
              </AssetRow>
            </div>
          </div>

          {/* Schedule D + Tax estimate */}
          <div className="grid md:grid-cols-2 gap-4">
            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02]">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Schedule D — After Netting</span>
              </div>
              <div className="py-1">
                <NettingRow label="Net Short-Term (Line 7)"     value={gains.schedD.netST}    sub="After cross-netting" />
                <NettingRow label="Net LT Regular (15 / 20%)"   value={gains.schedD.netRegLT} sub="Stocks · Crypto · Options · Futures 60%" />
                <NettingRow label="Net LT Collectibles (≤28%)"  value={gains.schedD.netCollLT} sub="Bullion" />
                <div className="mx-4 my-1 h-px bg-white/[0.06]" />
                <NettingRow label="Total Net (Line 16)" value={gains.schedD.totalNet} />
                {gains.schedD.deductibleLoss < 0 && (
                  <div className="mx-4 mt-2 mb-1 rounded-xl bg-blue-500/[0.08] border border-blue-500/[0.15] px-3 py-2.5">
                    <div className="text-xs font-semibold text-blue-400">Capital Loss Deduction</div>
                    <div className="text-xs text-slate-400 mt-1 leading-relaxed">
                      {formatMoney(Math.abs(gains.schedD.deductibleLoss))} deductible against ordinary income this year.
                      {gains.schedD.carryforward > 0 && (
                        <> {formatMoney(gains.schedD.carryforward)} carries forward to {year + 1}.</>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
              <div className="px-4 py-3 border-b border-white/[0.06] bg-white/[0.02] flex items-center justify-between gap-2">
                <span className="text-xs font-bold uppercase tracking-wide text-slate-500">Estimated Tax</span>
                <div className="flex items-center gap-2">
                  <label className="text-[11px] text-slate-600 whitespace-nowrap">Bracket</label>
                  <select
                    value={bracketIdx}
                    onChange={(e) => setBracketIdx(Number(e.target.value))}
                    className="bg-white/[0.06] border border-white/[0.08] rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-blue-500/50 cursor-pointer"
                  >
                    {BRACKETS.map((b, i) => <option key={b.label} value={i}>{b.label}</option>)}
                  </select>
                </div>
              </div>
              <div className="py-1">
                <div className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <div className="text-sm text-slate-400">Short-Term Tax</div>
                    <div className="text-[11px] text-slate-600">{formatMoney(gains.schedD.netST > 0 ? gains.schedD.netST : 0)} × {(bracket.ordinary * 100).toFixed(0)}%</div>
                  </div>
                  <span className="text-sm font-semibold text-amber-400 tabular-nums">{formatMoney(tax.stTax)}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <div className="text-sm text-slate-400">LT Regular Tax</div>
                    <div className="text-[11px] text-slate-600">{formatMoney(gains.schedD.netRegLT > 0 ? gains.schedD.netRegLT : 0)} × {(bracket.lt * 100).toFixed(0)}%</div>
                  </div>
                  <span className="text-sm font-semibold text-amber-400 tabular-nums">{formatMoney(tax.regTax)}</span>
                </div>
                <div className="flex items-center justify-between px-4 py-2.5">
                  <div>
                    <div className="text-sm text-slate-400">Collectibles Tax</div>
                    <div className="text-[11px] text-slate-600">{formatMoney(gains.schedD.netCollLT > 0 ? gains.schedD.netCollLT : 0)} × {(Math.min(bracket.collLT, bracket.ordinary) * 100).toFixed(0)}%</div>
                  </div>
                  <span className="text-sm font-semibold text-amber-400 tabular-nums">{formatMoney(tax.collTax)}</span>
                </div>
                <div className="mx-4 my-1 h-px bg-white/[0.06]" />
                <div className="flex items-center justify-between px-4 py-3">
                  <span className="text-sm font-bold text-slate-200">Total Estimated Tax</span>
                  <span className="text-xl font-black text-amber-400 tabular-nums" style={{ fontFamily: "Epilogue, sans-serif" }}>
                    {formatMoney(tax.total)}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* IRS notes */}
          <div className="rounded-xl border border-white/[0.05] bg-white/[0.01] px-4 py-3">
            <div className="text-xs text-slate-600 leading-relaxed space-y-1">
              <p><span className="text-slate-500 font-semibold">FIFO</span> cost basis used for stocks, crypto, and bullion. Each detail row shows one buy-lot matched against a sell. Holding period &gt; 365 days = long-term.</p>
              <p><span className="text-slate-500 font-semibold">Options</span> classified by openDate → closeDate holding period. Only closed positions (closeDate set and in selected year) appear.</p>
              <p><span className="text-slate-500 font-semibold">Section 1256</span> futures: 60% LT / 40% ST applied to the net annual P&L, not per-trade. Each row shows the raw trade P&L before the split.</p>
              <p><span className="text-slate-500 font-semibold">Estimate only.</span> Wash sales, open positions, NIIT (3.8%), state taxes, and AMT not included. Consult a tax professional.</p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

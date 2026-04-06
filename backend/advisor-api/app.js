"use strict";

const https = require("https");
const { json, badRequest } = require("finvault-shared/http");
const { queryByGSI1 } = require("finvault-shared/ddb");
const { resolveContext, assertRead } = require("finvault-shared/resolveContext");

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-sonnet-4-6";

/* ── Resolve context ─────────────────────────────────────────── */
async function resolveCtxCached(event) {
  if (!event._ctx) event._ctx = await resolveContext(event);
  return event._ctx;
}

/* ── Fetch all portfolio asset types ─────────────────────────── */
async function fetchPortfolio(userId) {
  const [
    stocks, options, crypto, bullion,
    futures, fixedIncome, otherAssets,
    insurance, nav,
  ] = await Promise.all([
    queryByGSI1(userId, "STOCK_TX#").catch(() => []),
    queryByGSI1(userId, "OPTIONS_TX#").catch(() => []),
    queryByGSI1(userId, "CRYPTO_TX#").catch(() => []),
    queryByGSI1(userId, "BULLION_TX#").catch(() => []),
    queryByGSI1(userId, "FUTURES_TX#").catch(() => []),
    queryByGSI1(userId, "FIXED_INCOME#").catch(() => []),
    queryByGSI1(userId, "OTHERASSET#").catch(() => []),
    queryByGSI1(userId, "INSURANCE#").catch(() => []),
    queryByGSI1(userId, "NAV_LIABILITIES#").catch(() => []),
  ]);
  return { stocks, options, crypto, bullion, futures, fixedIncome, otherAssets, insurance, nav };
}

/* ── Build a concise portfolio summary for the system prompt ─── */
function buildPortfolioSummary(portfolio) {
  const lines = [];

  // Stocks
  const stockMap = {};
  for (const tx of portfolio.stocks) {
    const sym = tx.symbol || tx.ticker || "?";
    if (!stockMap[sym]) stockMap[sym] = { shares: 0, cost: 0, country: tx.country || "USA" };
    const s = stockMap[sym];
    const shares = Number(tx.shares || 0);
    const price = Number(tx.price || 0);
    if (String(tx.type || "").toUpperCase() === "BUY") {
      s.shares += shares; s.cost += shares * price;
    } else {
      s.shares -= shares; s.cost -= shares * price;
    }
  }
  const stockLines = Object.entries(stockMap)
    .filter(([, v]) => v.shares > 0.001)
    .map(([sym, v]) => {
      const avg = v.shares > 0 ? (v.cost / v.shares).toFixed(2) : "0";
      return `  ${sym}: ${v.shares.toFixed(2)} shares @ avg $${avg} (${v.country})`;
    });
  if (stockLines.length) {
    lines.push("STOCKS:");
    lines.push(...stockLines);
  }

  // Options (open positions only)
  const openOptions = portfolio.options.filter(tx => {
    const leg = String(tx.leg || "").toUpperCase();
    const isCloseLeg = ["CLOSE", "ROLL_CLOSE"].includes(leg);
    if (isCloseLeg) return false;
    if (tx.closePrice !== "" && tx.closePrice !== null && tx.closePrice !== undefined) return false;
    if (tx.closeDate && String(tx.closeDate).trim() !== "") return false;
    return true;
  });
  if (openOptions.length) {
    lines.push("\nOPEN OPTIONS POSITIONS:");
    for (const o of openOptions) {
      lines.push(`  ${o.ticker} ${o.event?.toUpperCase()} ${o.strikes} exp ${o.expiry} | ${o.type} ${o.qty} contracts @ $${o.fill}`);
    }
  }

  // Crypto
  const cryptoMap = {};
  for (const tx of portfolio.crypto) {
    const sym = tx.symbol || tx.ticker || "?";
    if (!cryptoMap[sym]) cryptoMap[sym] = { qty: 0, cost: 0 };
    const c = cryptoMap[sym];
    const qty = Number(tx.qty || tx.shares || 0);
    const price = Number(tx.price || tx.fill || 0);
    if (String(tx.type || "").toUpperCase() === "BUY") {
      c.qty += qty; c.cost += qty * price;
    } else {
      c.qty -= qty; c.cost -= qty * price;
    }
  }
  const cryptoLines = Object.entries(cryptoMap)
    .filter(([, v]) => v.qty > 0.00001)
    .map(([sym, v]) => {
      const avg = v.qty > 0 ? (v.cost / v.qty).toFixed(2) : "0";
      return `  ${sym}: ${v.qty.toFixed(6)} @ avg $${avg}`;
    });
  if (cryptoLines.length) {
    lines.push("\nCRYPTO:");
    lines.push(...cryptoLines);
  }

  // Bullion
  const bullionMap = {};
  for (const tx of portfolio.bullion) {
    const metal = (tx.metal || tx.type || "?").toUpperCase();
    if (!bullionMap[metal]) bullionMap[metal] = { qty: 0 };
    const qty = Number(tx.qty || tx.weight || tx.grams || 0);
    bullionMap[metal].qty += qty;
  }
  const bullionLines = Object.entries(bullionMap)
    .filter(([, v]) => v.qty > 0)
    .map(([metal, v]) => `  ${metal}: ${v.qty} units`);
  if (bullionLines.length) {
    lines.push("\nBULLION:");
    lines.push(...bullionLines);
  }

  // Fixed Income
  if (portfolio.fixedIncome.length) {
    lines.push("\nFIXED INCOME:");
    for (const fi of portfolio.fixedIncome) {
      lines.push(`  ${fi.name || fi.ticker || "Bond"}: $${fi.principal || fi.face || fi.amount || "?"} @ ${fi.rate || fi.coupon || "?"}% | Maturity: ${fi.maturity || fi.expiry || "?"}`);
    }
  }

  // Other Assets
  if (portfolio.otherAssets.length) {
    lines.push("\nOTHER ASSETS:");
    for (const a of portfolio.otherAssets) {
      lines.push(`  ${a.name || a.ticker || "Asset"}: $${a.value || a.currentValue || "?"}`);
    }
  }

  // NAV/Liabilities
  if (portfolio.nav.length) {
    const liabilities = portfolio.nav.filter(n => n.assetType === "NAV_LIABILITIES");
    if (liabilities.length) {
      lines.push("\nLIABILITIES:");
      for (const l of liabilities) {
        lines.push(`  ${l.name || l.description || "Liability"}: $${l.balance || l.amount || "?"}`);
      }
    }
  }

  return lines.length ? lines.join("\n") : "No portfolio data available.";
}

/* ── Build system prompt ─────────────────────────────────────── */
function buildSystemPrompt(goals, portfolioSummary) {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a highly personalized AI financial advisor. Today's date is ${today}.

INVESTOR PROFILE:
- Risk Tolerance: ${goals.riskTolerance || "Moderate"}
- Investment Objective: ${goals.objective || "Balanced Growth"}
- Time Horizon: ${goals.timeHorizon || "5-10 years"}
- Target Annual Return: ${goals.targetReturn ? goals.targetReturn + "%" : "Not specified"}
- Monthly Contribution: ${goals.monthlyContribution ? "$" + goals.monthlyContribution : "Not specified"}
- Special Considerations: ${goals.notes || "None"}

CURRENT PORTFOLIO:
${portfolioSummary}

INSTRUCTIONS:
- Provide highly personalized, actionable financial advice tailored to this investor's specific portfolio, goals, and risk profile.
- Draw on your knowledge of current macroeconomic conditions, Federal Reserve policy, inflation trends, interest rate environment, global geopolitical developments, sector trends, and market dynamics as of your knowledge cutoff. Also consider potential black swan events — low-probability, high-impact risks such as sudden liquidity crises, sovereign debt shocks, geopolitical escalations, systemic financial contagion, or unexpected policy shocks — and how they could affect this portfolio.
- Be specific: reference actual holdings when relevant, suggest concrete actions, and explain your reasoning.
- Always frame advice in the context of the investor's risk tolerance and time horizon.
- When discussing options strategies, reference the investor's open positions.
- Be direct and concise. Avoid generic disclaimers. The investor understands markets.
- If asked about a specific stock, sector, or strategy, give a direct opinion while acknowledging uncertainty.
- Flag any concentration risks, hedging opportunities, or rebalancing needs you observe in the portfolio.`;
}

/* ── Call Anthropic API ──────────────────────────────────────── */
function callAnthropic(systemPrompt, history) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: systemPrompt,
      messages: history,
    });

    const req = https.request(
      {
        hostname: "api.anthropic.com",
        path: "/v1/messages",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.error) return reject(new Error(parsed.error.message || "Anthropic error"));
            const text = parsed.content?.[0]?.text || "";
            resolve(text);
          } catch (e) {
            reject(new Error("Failed to parse Anthropic response"));
          }
        });
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

/* ── Handler ─────────────────────────────────────────────────── */
exports.handler = async (event) => {
  const method = event.requestContext?.http?.method || event.httpMethod || "GET";
  const path   = event.rawPath || event.path || "";

  if (method === "POST" && path === "/advisor/chat") {
    try {
      const ctx = await resolveCtxCached(event);
      assertRead(ctx, "advisor");

      const body = event.body ? JSON.parse(event.isBase64Encoded
        ? Buffer.from(event.body, "base64").toString()
        : event.body
      ) : {};

      const { message, history = [], goals = {} } = body;
      if (!message || !String(message).trim()) return badRequest("message is required");

      if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === "REPLACE") {
        return json(500, { message: "Advisor service is not configured (missing API key)" });
      }

      // Fetch portfolio + build context
      const portfolio = await fetchPortfolio(ctx.accountId);
      const portfolioSummary = buildPortfolioSummary(portfolio);
      const systemPrompt = buildSystemPrompt(goals, portfolioSummary);

      // Build message list: history + new user message
      const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: "user", content: String(message).trim() },
      ];

      const reply = await callAnthropic(systemPrompt, messages);
      return json(200, { reply });
    } catch (err) {
      const status = err.statusCode || 500;
      return json(status, { message: err.message || "Internal server error" });
    }
  }

  return json(404, { message: "Not found" });
};

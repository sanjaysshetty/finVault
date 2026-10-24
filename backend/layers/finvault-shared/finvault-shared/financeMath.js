function freqToN(freq) {
  switch ((freq || "YEARLY").toUpperCase()) {
    case "DAILY": return 365;
    case "MONTHLY": return 12;
    case "QUARTERLY": return 4;
    case "YEARLY":
    default: return 1;
  }
}

function yearsBetween(startISO, endISO) {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const ms = end - start;
  const days = ms / (1000 * 60 * 60 * 24);
  return Math.max(0, days / 365.25);
}

function addMonths(dateISO, months) {
  const d = new Date(dateISO);
  const day = d.getDate();
  d.setMonth(d.getMonth() + Number(months || 0));
  if (d.getDate() !== day) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function computeValue({ principal, annualRate, startDate, asOfDate, interestType, compoundFrequency }) {
  const P = Number(principal);
  const r = Number(annualRate);

  if (!Number.isFinite(P) || !Number.isFinite(r) || !startDate) {
    return { value: Number.isFinite(P) ? P : 0, interest: 0 };
  }

  const t = yearsBetween(startDate, asOfDate);
  const type = (interestType || "SIMPLE").toUpperCase();

  let value = P;
  if (type === "COMPOUND") {
    const n = freqToN(compoundFrequency);
    value = P * Math.pow(1 + r / n, n * t);
  } else {
    value = P * (1 + r * t);
  }

  return { value, interest: value - P };
}

module.exports = { freqToN, yearsBetween, addMonths, computeValue };

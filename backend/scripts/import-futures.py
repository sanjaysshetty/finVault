#!/usr/bin/env python3
"""
Import Robinhood Derivatives monthly statement PDFs into the finAssets
DynamoDB table as FUTURES_TX records.

Parses the "Purchase and Sale Summary" section of each PDF:
  - One record per row (aggregated monthly round-trip per symbol)
  - Stores grossPL (Gross P&L) directly from the statement

Usage:
  python3 import-futures.py            # writes to DynamoDB
  python3 import-futures.py --dry-run  # preview only, no writes

Requires: pdfplumber, boto3  (install in the contracts/.venv)

Options:
  --user-id <id>    Cognito sub (userId) to write records under.
                    Defaults to the first userId found in the table.
  --pdf-dir <path>  Directory containing the PDF statements.
                    Defaults to /Users/sanjayshetty/Playground/beforClaude/contracts
  --dry-run         Preview parsed records without writing to DynamoDB.
"""

import re, sys, uuid, os, argparse
from datetime import datetime, timezone
import pdfplumber
import boto3

# ── Defaults ──────────────────────────────────────────────────────────────────
DEFAULT_TABLE  = "finAssets"
DEFAULT_REGION = "us-east-1"
DEFAULT_PDF_DIR = "/Users/sanjayshetty/Playground/beforClaude/contracts"

MONTH_NAMES = {1:"Jan",2:"Feb",3:"Mar",4:"Apr",5:"May",6:"Jun",
               7:"Jul",8:"Aug",9:"Sep",10:"Oct",11:"Nov",12:"Dec"}

# ── Helpers ────────────────────────────────────────────────────────────────────
def fmt_contract_month(year, month):
    return f"{MONTH_NAMES[int(month)]}{str(int(year))[-2:]}"

# ── Parse "Purchase and Sale Summary" ─────────────────────────────────────────
# Row format (single clean line):
# DATE  US  QTY_LONG  QTY_SHORT  SYMBOL  YEAR  MONTH  EXCHANGE  EXP_DATE  GROSS_PL  USD  DESCRIPTION
SUMMARY_RE = re.compile(
    r'^(\d{4}-\d{2}-\d{2})\s+US\s+(\d+)\s+(\d+)\s+([A-Z]+)\s+(\d{4})\s+(\d+)\s+\w+\s+[\d-]+\s+([-\d.]+)\s+USD'
)

def parse_summary(section_text):
    records = []
    for line in section_text.splitlines():
        m = SUMMARY_RE.match(line.strip())
        if not m:
            continue
        date, qty_long, qty_short, symbol, year, month, gross_pl = m.groups()
        records.append(dict(
            tradeDate=date,
            ticker=symbol,
            contractMonth=fmt_contract_month(year, month),
            qty=int(qty_long),       # long qty == short qty for completed round trips
            grossPL=float(gross_pl),
        ))
    return records

# ── Section splitter ───────────────────────────────────────────────────────────
SECTION_HEADERS = [
    "Monthly Trade Confirmations",
    "Trade Confirmation Summary",
    "Purchase and Sale Summary",
    "Purchase and Sale",
    "Open Positions",
    "Journal Entries",
]

def split_sections(full_text):
    positions = {}
    for h in SECTION_HEADERS:
        idx = full_text.find(h)
        if idx >= 0:
            positions[h] = idx
    sorted_hdrs = sorted(positions.items(), key=lambda x: x[1])

    sections = {}
    for i, (name, start) in enumerate(sorted_hdrs):
        end = sorted_hdrs[i + 1][1] if i + 1 < len(sorted_hdrs) else len(full_text)
        sections[name] = full_text[start + len(name): end]
    return sections

# ── Parse one PDF ──────────────────────────────────────────────────────────────
def parse_pdf(filepath):
    with pdfplumber.open(filepath) as pdf:
        full_text = "\n".join(page.extract_text() or "" for page in pdf.pages)

    sections = split_sections(full_text)
    return parse_summary(sections.get("Purchase and Sale Summary", ""))

# ── DynamoDB item builder ──────────────────────────────────────────────────────
def make_item(record, user_id):
    tx_id = str(uuid.uuid4())
    now   = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    return {
        "userId":        {"S": user_id},
        "assetId":       {"S": tx_id},
        "txId":          {"S": tx_id},
        "assetType":     {"S": "FUTURES_TX"},
        "gsi1pk":        {"S": user_id},
        "gsi1sk":        {"S": f"FUTURES_TX#{record['tradeDate']}#{tx_id}"},
        "type":          {"S": "SUMMARY"},
        "ticker":        {"S": record["ticker"]},
        "contractMonth": {"S": record["contractMonth"]},
        "tradeDate":     {"S": record["tradeDate"]},
        "qty":           {"N": str(record["qty"])},
        "grossPL":       {"N": str(record["grossPL"])},
        "notes":         {"S": ""},
        "createdAt":     {"S": now},
    }

# ── Main ───────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="Import Robinhood futures PDFs into DynamoDB.")
    parser.add_argument("--user-id",  default=None,            help="Cognito userId (sub) to write records under")
    parser.add_argument("--pdf-dir",  default=DEFAULT_PDF_DIR, help="Directory containing PDF statements")
    parser.add_argument("--table",    default=DEFAULT_TABLE,   help="DynamoDB table name (default: finAssets)")
    parser.add_argument("--region",   default=DEFAULT_REGION,  help="AWS region (default: us-east-1)")
    parser.add_argument("--profile",  default=None,            help="AWS CLI profile name (e.g. finvault-sb)")
    parser.add_argument("--dry-run",  action="store_true",     help="Preview only, no DynamoDB writes")
    args = parser.parse_args()

    # Build boto3 session (respects --profile if given)
    session = boto3.Session(profile_name=args.profile) if args.profile else boto3.Session()

    # Resolve userId
    user_id = args.user_id
    if not user_id:
        ddb = session.client("dynamodb", region_name=args.region)
        resp = ddb.scan(TableName=args.table, Limit=1, ProjectionExpression="userId")
        items = resp.get("Items", [])
        if not items:
            print("ERROR: No existing items in table and --user-id not provided.")
            sys.exit(1)
        user_id = items[0]["userId"]["S"]
        print(f"Auto-detected userId: {user_id}")

    pdfs = sorted(f for f in os.listdir(args.pdf_dir) if f.endswith(".pdf"))

    all_records = []
    for pdf in pdfs:
        path = os.path.join(args.pdf_dir, pdf)
        print(f"Parsing {pdf}…")
        records = parse_pdf(path)
        print(f"  {len(records)} summary rows found")
        all_records.extend(records)

    print(f"\nTotal records: {len(all_records)}")
    print(f"{'Date':<12} {'Ticker':<6} {'Qty':>5} {'Contract':<10} {'Gross P&L':>12}")
    print("-" * 52)
    for r in sorted(all_records, key=lambda x: (x["tradeDate"], x["ticker"])):
        pl_str = f"{r['grossPL']:>12.2f}"
        print(f"{r['tradeDate']:<12} {r['ticker']:<6} {r['qty']:>5} {r['contractMonth']:<10} {pl_str}")

    if args.dry_run:
        print("\n[dry-run] No writes made.")
        return

    ddb = session.client("dynamodb", region_name=args.region)
    written = 0
    for record in all_records:
        ddb.put_item(TableName=args.table, Item=make_item(record, user_id))
        written += 1

    print(f"\nWrote {written} items to '{args.table}'.")

if __name__ == "__main__":
    main()

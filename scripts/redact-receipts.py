#!/usr/bin/env python3
"""
Redact personal information from receipt PDFs (test/fixtures/pdf/) so they
can be shared, matching the statement fixtures' redaction.

The receipt PDFs use normal fonts and readable text, so the same content-
stream surgery as redact-statements.py applies: pypdf visits every text run,
flags the runs carrying personal identifiers, blanks those runs' text
operands, and paints a black bar over the region.

Redacted identifiers: the account holder's name, personal email
(@labnotes), home street address (1050 … Flower St, Apt 503), home zip codes
(90015, 94606), the card suffix (1476), and any phone-number digit run.
Merchant contact details (e.g. teaching@zoehong.com, the Paddle/Shopify
addresses) are left intact.

Usage: redact-receipts.py [dir]
Reads *.pdf from DIR (default: test/fixtures/pdf) and redacts them in place.
"""
import importlib.util
import os
import re
import sys

# redact-statements.py has a hyphen, so it can't be imported normally.
_here = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location(
    "redact_statements", os.path.join(_here, "redact-statements.py")
)
_rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_rs)
redact_pdf = _rs.redact_pdf

RECEIPT_PII = [
    re.compile(r"\b(assaf|arkin)\b", re.I),  # account-holder name
    re.compile(r"@labnotes", re.I),  # personal email
    re.compile(r"1050\s+(south\s+)?flower", re.I),  # home street
    re.compile(r"\bapt\s+503\b", re.I),  # unit
    re.compile(r"\b(90015|94606)\b"),  # home zip codes
    re.compile(r"\b1476\b"),  # card suffix
]


def is_pii(text: str) -> bool:
    t = text.replace("\x00", "").replace("\n", " ").strip()
    if not t:
        return False
    digits = sum(1 for c in t if c.isdigit())
    nonspace = sum(1 for c in t if not c.isspace())
    # Phone numbers are mostly digits (the run "1 415 310 1050" splits on
    # null bytes); a merchant address line is not mostly digits.
    if digits >= 10 and nonspace > 0 and digits / nonspace >= 0.6:
        return True
    tl = t.lower()
    return any(rx.search(tl) for rx in RECEIPT_PII)


def main():
    default_dir = os.path.normpath(
        os.path.join(_here, "..", "test", "fixtures", "pdf")
    )
    src_dir = sys.argv[1] if len(sys.argv) > 1 else default_dir
    for name in sorted(os.listdir(src_dir)):
        if not name.lower().endswith(".pdf"):
            continue
        src = os.path.join(src_dir, name)
        tmp = f"{src}.redacted"
        stats = redact_pdf(src, tmp, is_pii)
        if stats.get("error"):
            print(f"SKIP {name}: {stats['error']}")
            os.path.exists(tmp) and os.remove(tmp)
            continue
        os.replace(tmp, src)
        line = (
            f"{name}: {stats['flagged']} flagged runs, "
            f"{stats['ops_scrubbed']} ops scrubbed, {stats['bars']} bars "
            f"({stats['runs']} text runs)"
        )
        for p in stats["problems"]:
            line += f"  [PROBLEM: {p}]"
        print(line)


if __name__ == "__main__":
    main()

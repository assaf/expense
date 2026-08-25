#!/usr/bin/env python3
"""
Redact personal information from the HTML email fixtures (test/fixtures/emails/)
so they can be shared, matching the statement/receipt fixtures' redaction.

Each committed .html is quoted-printable encoded (saved raw from the MIME
source). This script decodes it, replaces the account holder's personal
identifiers with REDACTED, and writes the clean HTML back in place; the same
form the inbound pipeline would receive from Resend.

Redacted: emails on the holder's domains (@labnotes.org / @arkin.me), the
holder's name, the home street/unit/zip, the card suffix, and account numbers
(Spectrum/Verizon endings, the Cloudflare account id, the Quicksilver
reference code). Merchant contact details, receipt/invoice/transaction
numbers, and merchant addresses are left intact.

Usage: redact-emails.py [dir]
Reads *.html from DIR (default: test/fixtures/emails) and redacts them in
place.
"""
import os
import quopri
import re
import sys

# Order matters: emails first, so the name rule doesn't match the "assaf"
# inside "assaf@labnotes.org".
RULES = [
    # emails on the holder's domains (incl. subdomains like receipts@expense.)
    (re.compile(r"[\w.+-]+@(?:[\w-]+\.)*(?:labnotes\.org|arkin\.me)", re.I), "REDACTED"),
    # full name, then surname / first name
    (re.compile(r"\bAssaf Arkin\b", re.I), "REDACTED"),
    (re.compile(r"\bAssaf\b", re.I), "REDACTED"),
    (re.compile(r"\bArkin\b", re.I), "REDACTED"),
    # home street address
    (re.compile(r"1050\s+S\s+Flower\s+St", re.I), "REDACTED"),
    (re.compile(r"\bApt\s+503\b", re.I), "REDACTED"),
    (re.compile(r"\b90015\b"), "REDACTED"),
    # card suffix
    (re.compile(r"\b1476\b"), "REDACTED"),
    # account numbers
    (re.compile(r"8838-00001"), "REDACTED"),
    (re.compile(r"\b3870\b"), "REDACTED"),
    (re.compile(r"28ba0cb08c23885f1a56e468f57c27a6"), "REDACTED"),
    (re.compile(r"TRXABX\s+10003\s+867530\s+1057"), "REDACTED"),
]


def main():
    default_dir = os.path.normpath(
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "test", "fixtures", "emails")
    )
    src_dir = sys.argv[1] if len(sys.argv) > 1 else default_dir
    for name in sorted(os.listdir(src_dir)):
        if not name.lower().endswith(".html"):
            continue
        path = os.path.join(src_dir, name)
        raw = open(path, "rb").read()
        html = quopri.decodestring(raw).decode("utf-8")
        total = 0
        for rx, repl in RULES:
            html, n = rx.subn(repl, html)
            total += n
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(html)
        print(f"{name}: {total} replacements")


if __name__ == "__main__":
    main()

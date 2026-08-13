#!/usr/bin/env python3
"""
Redact personal information from bank statement PDFs so they can be shared.

These statements encode their text with custom fonts (raw strings in the
content streams are byte codes, not readable text), so redaction works in
two passes:

1. pypdf's text-extraction visitors decode the text and give the position
   of every run and every text-drawing operation (descending into the Form
   XObjects the banks use to hold each page's content). Runs carrying
   personal identifiers (names, emails, home address, card/account
   numbers, MICR lines, anything that is >= 60% digits with >= 10 digits)
   are flagged.
2. The content streams (page + nested forms) are re-parsed op by op —
   pypdf visits operations in exactly the order they appear, so ops pair
   with the visitor's positions 1:1. Flagged ops have their text replaced
   with same-length spaces in the string's OWN encoding (UTF-16BE where
   the source used it — plain ASCII spaces would decode as dagger glyphs)
   and a black bar is painted over the region.

Forms are shared across pages (Chase reuses its header XObjects), so all
reads happen on pristine data and every mutation is applied once at the
end. Edited streams are written decoded with the /Filter removed (pypdf
writes stream data raw; some banks also chain Ascii85 filters that a
zlib re-encode would corrupt).

Usage: redact_statements.py DIR [outdir]
Reads *.pdf from DIR (default: current dir), writes redacted copies to
OUTDIR (default: DIR/Redacted). The originals are never modified.

Requires: pypdf (pip install pypdf).
"""
import os
import re
import sys
import zipfile

from pypdf import PdfReader, PdfWriter
from pypdf._page import ContentStream
from pypdf.generic import (
    ArrayObject,
    ByteStringObject,
    DecodedStreamObject,
    FloatObject,
    NameObject,
    NullObject,
    TextStringObject,
)

# --- PII rules ---------------------------------------------------------------

# Names are word-boundary matches — "arkin" must not match "PARKING".
NAME_RE = re.compile(r"\b(assaf|arkin|jennifer|jyzoe)\b", re.IGNORECASE)
EMAILS = ["@labnotes", "@gmail"]
ADDRESS = ["1050 s flower", "apt 503", "90015-5106"]
ACCOUNTS = ["ending in", "xxxx xxxx", "2-12004", "2-13010"]


def _is_pii(text: str) -> bool:
    t = text.replace("\n", " ").strip()
    if not t:
        return False
    digits = sum(1 for c in t if c.isdigit())
    nonspace = sum(1 for c in t if not c.isspace())
    # Card numbers, MICR lines, account codes, phone numbers: the run is
    # mostly digits. (A merchant line like "Kindle … 888-802-3080 … 4.99"
    # is not mostly digits, so its phone number stays.)
    if digits >= 10 and nonspace > 0 and digits / nonspace >= 0.6:
        return True
    tl = t.lower()
    if NAME_RE.search(t):
        return True
    return any(p in tl for p in EMAILS + ADDRESS + ACCOUNTS)


# --- Operand surgery ---------------------------------------------------------

def _raw_bytes(obj):
    r = obj.get_original_bytes()
    if r.startswith(b"(") and r.endswith(b")"):
        r = r[1:-1]
    return r


def _blank_bytes(_raw: bytes) -> bytes:
    """Replace a text run with nothing. These fonts encode strings as
    Identity-H glyph codes; a space code (0x0020) is not mapped in every
    font's ToUnicode and decodes as garbage, so the safest blank is an
    empty string — nothing extracts, and the redaction bar covers the
    region."""
    return b""


def replace_text_args(args, op):
    """Replace the text operand(s) with same-length spaces (own encoding)."""
    if op == b"'":
        # ' tx ty string
        return [args[0], args[1], ByteStringObject(_blank_bytes(_raw_bytes(args[2])))]
    if len(args) == 0:
        return args
    a0 = args[0]
    if isinstance(a0, ArrayObject):
        # TJ: alternating strings and kerning offsets.
        new = []
        for el in a0:
            if isinstance(el, TextStringObject) or hasattr(el, "get_original_bytes"):
                new.append(ByteStringObject(_blank_bytes(_raw_bytes(el))))
            else:
                new.append(el)
        return [ArrayObject(new)]
    if isinstance(a0, TextStringObject) or hasattr(a0, "get_original_bytes"):
        return [ByteStringObject(_blank_bytes(_raw_bytes(a0)))]
    return args


def _norm(v):
    """pypdf parses some operands (TJ kerning, cm numbers) as raw int/float;
    its serializer needs generic objects."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return FloatObject(float(v))
    return v


def normalize_ops(ops):
    out = []
    for args, op in ops:
        nargs = []
        for a in args:
            if isinstance(a, ArrayObject):
                nargs.append(ArrayObject([_norm(el) for el in a]))
            else:
                nargs.append(_norm(a))
        out.append((nargs, op))
    return out


def _parse(data, pdf):
    wrap = DecodedStreamObject()
    wrap.set_data(data)
    return ContentStream(wrap, pdf)


def redact_pdf(src_path: str, dst_path: str, is_pii=_is_pii) -> dict:
    reader = PdfReader(src_path)
    if reader.is_encrypted:
        # Owner-password-only statements (Chase) open with an empty password;
        # pypdf leaves is_encrypted True even after a successful decrypt.
        try:
            result = reader.decrypt("")
        except Exception:
            result = 0
        if not result:
            return {"error": "encrypted"}
    writer = PdfWriter()
    writer.append(reader)

    # Collected edits, applied once at the end: id(resolved object) →
    # pristine stream bytes; which text-op indices to scrub; bars to paint.
    pristine = {}
    scrub_masks = {}
    refs = {}
    bar_ops = {}

    stats = {"runs": 0, "flagged": 0, "ops_scrubbed": 0, "bars": 0}
    problems = []

    for pageno, page in enumerate(writer.pages):
        # --- Pass 1: decoded text runs + per-op positions (visitor). -------
        text_op_pos = []  # (x, y) per text op, in stream order
        runs = []         # (text, x, y, fs)

        def vob(op, args, cm, tm):
            if op in (b"Tj", b"TJ", b"'"):
                text_op_pos.append(
                    (cm[0] * tm[4] + cm[2] * tm[5] + cm[4],
                     cm[1] * tm[4] + cm[3] * tm[5] + cm[5])
                )

        def vt(text, cm, tm, font, fs):
            runs.append(
                (text,
                 cm[0] * tm[4] + cm[2] * tm[5] + cm[4],
                 cm[1] * tm[4] + cm[3] * tm[5] + cm[5],
                 float(fs) if fs else 10.0)
            )

        page.extract_text(visitor_operand_before=vob, visitor_text=vt)

        flagged = [(t, x, y, fs) for (t, x, y, fs) in runs if is_pii(t)]
        stats["runs"] += len(runs)
        stats["flagged"] += len(flagged)

        # Group the text ops into lines by baseline, then scrub every op on
        # a line that carries a flagged run. Runs and ops can disagree about
        # a line's position (right-aligned account numbers sit beyond the
        # run's width, header rows draw at two baselines), so line-level
        # matching is more reliable than x/y spans.
        lines = []
        for i, (x, y) in enumerate(text_op_pos):
            for ln in lines:
                if abs(y - ln[0]) <= 4:
                    ln[1].append(i)
                    break
            else:
                lines.append([y, [i]])

        scrub_page = set()
        bars = []
        for (text, x, y, fs) in flagged:
            # pypdf sometimes accumulates a whole page into one run at (0,0)
            # — skip those (the per-line runs cover the same text).
            if x < 1 and y < 1:
                continue
            best = None
            for ln in lines:
                if best is None or abs(y - ln[0]) < abs(y - best[0]):
                    best = ln
            if best is not None and abs(y - best[0]) <= 12:
                scrub_page.update(best[1])
            # Redaction bar over the flagged region (skip absurd spans).
            if fs <= 40 and len(text) * fs * 0.55 < 700:
                bars.append((x - 2, y - fs * 0.3, len(text) * fs * 0.55 + 4, fs * 1.4))
        stats["ops_scrubbed"] += len(scrub_page)

        # --- Pass 2: walk the content streams, record what to edit. --------
        top_level = page.get("/Contents")
        streams = (
            list(top_level) if isinstance(top_level, ArrayObject) else [top_level]
        )
        streams = [s for s in streams if s is not None and s.get_object() is not None]
        text_idx = [0]

        def walk(stream_obj, resources, pdf):
            key = id(stream_obj)
            if key not in pristine:
                pristine[key] = stream_obj.get_data()
                refs[key] = stream_obj
            cs = _parse(pristine[key], pdf)
            mask = scrub_masks.setdefault(key, set())
            # Scrub indices are per-stream LOCAL (the apply pass re-parses each
            # stream alone), so track both the global index (to pair with the
            # visitor's page-wide order) and the local one.
            local = [0]
            for args, op in cs.operations:
                if op == b"Do":
                    xo = (resources or {}).get("/XObject", {})
                    obj = xo.get(args[0]) if args else None
                    if obj is not None:
                        obj = obj.get_object()
                    if obj is not None and obj.get("/Subtype") == "/Form":
                        walk(obj, obj.get("/Resources") or {}, pdf)
                elif op in (b"Tj", b"TJ", b"'"):
                    if text_idx[0] in scrub_page:
                        mask.add(local[0])
                    local[0] += 1
                    text_idx[0] += 1

        for s in streams:
            walk(s.get_object(), page.get("/Resources"), writer)

        if text_idx[0] != len(text_op_pos):
            problems.append(
                f"page {pageno + 1}: op count mismatch "
                f"(visitor {len(text_op_pos)} vs walk {text_idx[0]})"
            )

        # Bars go on the page's last top-level stream, painted last.
        if bars and streams:
            key = id(streams[-1].get_object())
            if key not in pristine:
                pristine[key] = streams[-1].get_object().get_data()
                refs[key] = streams[-1].get_object()
            bar_ops.setdefault(key, []).extend(bars)
            stats["bars"] += len(bars)

    # --- Apply: scrub text + paint bars, writing edited streams decoded. ---
    for key, mask in scrub_masks.items():
        if not mask and key not in bar_ops:
            continue
        cs = _parse(pristine[key], writer)
        ops = list(cs.operations)
        new_ops = []
        idx = 0
        for args, op in ops:
            if op in (b"Tj", b"TJ", b"'"):
                if idx in mask:
                    args = replace_text_args(args, op)
                idx += 1
            new_ops.append((args, op))
        for (x, y, w, h) in bar_ops.get(key, []):
            new_ops.append(([FloatObject(0), FloatObject(0), FloatObject(0)], b"rg"))
            new_ops.append(([FloatObject(x), FloatObject(y), FloatObject(w), FloatObject(h)], b"re"))
            new_ops.append(([], b"f"))
        cs.operations = normalize_ops(new_ops)
        obj = refs[key]
        # Write the edited content decoded with no filter — pypdf writes
        # stream data raw, and some banks chain Ascii85 filters that a
        # re-encode would corrupt. Decoded content is valid PDF.
        if NameObject("/Filter") in obj:
            del obj[NameObject("/Filter")]
        obj._data = cs.get_data()

    with open(dst_path, "wb") as fh:
        writer.write(fh)
    stats["problems"] = problems
    return stats


def redact_text(text: str) -> tuple[str, int]:
    """Redact personal info from plain text statements (CSV, QBO/OFX, and
    the XML inside .xlsx files): names, card endings, the QBO account id,
    and long digit runs. Returns the redacted text and the replacement
    count."""
    rules = [
        # Card-holder names (word boundaries — "arkin" is in "PARKING").
        (re.compile(r"\b(ASSAF ARKIN|JENNIFER HONG)\b", re.I), "REDACTED"),
        # Card endings: -12004, -13010, |12004 — but never an amount like
        # -1260.08 (the lookahead excludes digits followed by a decimal).
        (re.compile(r"(?<=[-|])\d{4,5}(?![\d.])"), "XXXX"),
        # QBO account id (<ACCTID>H9ACO0O8N1XWTBJ|12004</ACCTID>).
        (re.compile(r"(?<=<ACCTID>)[^<]+(?=</ACCTID>)", re.I), "REDACTED"),
        # Card numbers / long phone digits in MEMO fields.
        (re.compile(r"\b\d{15,}\b"), "X" * 15),
    ]
    out = text
    total = 0
    for rx, repl in rules:
        out, n = rx.subn(repl, out)
        total += n
    return out, total


def redact_xlsx(src_path: str, dst_path: str) -> int:
    """Redact the XML inside an .xlsx (shared strings + sheets) and re-zip."""
    total = 0
    with zipfile.ZipFile(src_path, "r") as zin, zipfile.ZipFile(
        dst_path, "w", zipfile.ZIP_DEFLATED
    ) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename.lower().endswith((".xml", ".rels", ".txt")):
                text = data.decode("utf-8")
                new, n = redact_text(text)
                total += n
                data = new.encode("utf-8")
            zout.writestr(item, data)
    return total


def main():
    src_dir = sys.argv[1] if len(sys.argv) > 1 else "."
    out_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(src_dir, "Redacted")
    os.makedirs(out_dir, exist_ok=True)
    for name in sorted(os.listdir(src_dir)):
        if name.startswith(".") or name == "Redacted":
            continue
        src = os.path.join(src_dir, name)
        dst = os.path.join(out_dir, name)
        ext = name.lower().rsplit(".", 1)[-1]
        if ext == "pdf":
            stats = redact_pdf(src, dst)
            if stats.get("error"):
                print(f"SKIP {name}: {stats['error']}")
                continue
            line = (
                f"{name}: {stats['flagged']} flagged runs, "
                f"{stats['ops_scrubbed']} ops scrubbed, {stats['bars']} bars "
                f"({stats['runs']} text runs) → {dst}"
            )
            for p in stats["problems"]:
                line += f"  [PROBLEM: {p}]"
            print(line)
        elif ext in ("csv", "qbo", "qfx", "ofx"):
            with open(src, encoding="utf-8", errors="replace") as fh:
                text = fh.read()
            out, n = redact_text(text)
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(out)
            print(f"{name}: {n} replacements → {dst}")
        elif ext == "xlsx":
            n = redact_xlsx(src, dst)
            print(f"{name}: {n} replacements → {dst}")
        else:
            continue


if __name__ == "__main__":
    main()

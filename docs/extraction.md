# Receipt extraction (LLM cost & pipeline)

How a receipt becomes structured data — and how the app keeps the DeepSeek
bill small. Entry points: the editor draft flow (`/api/expense` intents
`draft-upload` + `ocr`), the inbound-email pipeline (`app/lib/inbound-email.server.ts`),
and the MCP `capture_receipt` tool. All extraction lives in
`app/lib/receipt-ai.server.ts` (prompt/client/skip) and
`app/lib/receipt-ocr.server.ts` (PDF rasterize, tesseract fallback).

## The pipeline

1. **Text-first**: email bodies and PDF text layers already have text for free —
   no OCR needed. Images go to DeepSeek vision (downscaled first, see below).
2. **Known-merchant skip**: before any model call, text inputs are matched
   against the account's merchants from the last 90 days
   (`readKnownMerchants`, `app/lib/db/expenses.ts`). A word-bounded substring
   match (longest name wins — "amc" can't fire on "camcorder") plus a
   deterministically parsed total (`parseReceiptAmount`: explicit total line
   first, both decimal conventions `1,234.56` / `1.234,56`, then the last
   symbol-marked amount skipping tip/change lines; refunds never match) yields
   a full `ExtractionResult` with **zero tokens** — merchant/category/report
   come from the account's own history. `tryKnownMerchantExtraction` logs
   `[extraction] known-merchant skip: <merchant>`.
3. **Cache**: `extractReceipt` hashes the input (image bytes or text) per
   account and checks `receipt_extractions` (7-day TTL, expired rows swept on
   write). Same receipt re-uploaded (retry, second draft, MCP + web) returns
   the stored result — logged `[extraction] cache hit: <merchant>`.
4. **The model call**, only when both above miss: `max_tokens` 400 for
   extraction / 80 for the attachment classifier; receipt text capped at
   6,000 chars kept as head 4k + tail 2k (merchant/date top, total bottom);
   JSON mode, thinking disabled, temperature 0.1.

## Cost knobs (all env-tunable)

- `RECEIPT_VISION_MAX_WIDTH` (default 768, clamped 384–1536) — the normalized
  image is downscaled before the vision call. DeepSeek auto-resizes image
  input to ~800×800 and caps each image at 384 tokens, so this cuts request
  bandwidth (base64 payload), not billed tokens — image cost is already
  capped provider-side. Raise if dense receipts come back under-recognized;
  the stored/displayed image is untouched.
- `RECEIPT_OCR_MODE` (`auto` default | `deepseek` | `tesseract`) — `auto`
  reads the image with the vision model first (no local OCR CPU on the
  happy path; the model is also the better reader for photocopies, glare,
  skew) and falls back to tesseract only when the model can't name a
  total + merchant or the provider errors; `deepseek` is vision-only;
  `tesseract` is local-only.
- `LLM_MODEL` (default `deepseek-v4-flash`; legacy `DEEPSEEK_MODEL` still
  honored) — the text-extraction model. `LLM_VISION_MODEL` (defaults to
  `LLM_MODEL`) is used for image calls — DeepSeek's hosted vision model is
  `deepseek-v4-flash-vision-exp` (experimental; a reasoning model, so image
  calls also use `LLM_VISION_MAX_TOKENS`, default 1500, and send the same
  `thinking: disabled` the text models get — leaving it off burns the
  output budget on reasoning_content). `LLM_BASE_URL`/`LLM_API_KEY` point the
  OpenAI-compatible client at any provider (default DeepSeek; e.g.
  OpenRouter). `LLM_MAX_TOKENS` (default 500) caps the model's output —
  raise it when switching to a reasoning model, whose chain-of-thought
  tokens count against the cap.

## Tesseract

`ocrImage` reuses a **singleton worker** (created lazily, reset on error) —
no per-call WASM init, and traineddata downloads from the CDN once per
process instead of per image. Only used for the vision-unsupported fallback
and the `tesseract` mode; the email/PDF paths never OCR.

## Why the image path is NOT OCR-first

An earlier iteration OCR'd every image upload locally to catch repeat
merchants before paying for vision. It added seconds of latency to every
upload (cold tesseract = WASM + ~4MB traineddata) and its abandoned workers
starved the shared test server. The skip only runs where the text is already
free (email body, PDF text layer); images are vision-first with the cache as
the re-upload guard. If repeat-merchant images ever need the skip, the
pre-check must bound its latency (deadline + worker terminate), not just
resolve early.

## Security bounds

- Uploads: `readUploadedFile` rejects files > 15MB (`MAX_UPLOAD_BYTES`,
  matching the MCP cap) with `uploadErrorMessage("too-large")`.
- Decode: all sharp entry points in `image-normalize.ts` set
  `limitInputPixels: 2^26` (64MP) — a lying-header decompression bomb fails
  at open, before allocating; over-cap inputs degrade to pass-through, never
  a 500.
- Server-side URL fetches: `fetchPublicUrl` (SSRF: literal + DNS-resolved
  private checks, per-hop redirect re-checks) + `readBodyLimited` streams the
  body with a hard cap so `capture_receipt` can't buffer an unbounded
  response into memory.

## Operational notes

- Savings are observable in the logs: skip/cache-hit lines are the signal.
- Extraction failures are `captureWarning`/`captureError` (Sentry in prod) —
  not silent `console.warn`.
- The `receipt_extractions` table self-sweeps on write; no cron needed.
- The post-deploy smoke (`/api/smoke`) exercises the full pipeline
  (pdfkit → pdfjs → tesseract → MCP round trip).

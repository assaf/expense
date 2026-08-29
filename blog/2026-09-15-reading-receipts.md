# How Expense reads a receipt

Every receipt that lands in [Expense](https://expense.labnotes.org/?ref=labnotes.org) has to become structured data: merchant, date, amount, category. A language model can do that, but model calls cost money and seconds, so the pipeline is designed around not making them. Most receipts never reach a model.

The order goes like this.

Text first. Email bodies and PDF text layers already contain the receipt as text, so there's nothing to read. Parse it directly.

Then the known-merchant skip. If you've bought from this merchant in the last 90 days and the total is explicit enough to parse deterministically (both 1,234.56 and 1.234,56 conventions), the expense fills itself from your own history: your category, your report. Zero tokens.

Then the cache. The same bytes uploaded again within a week, a retry or the same receipt through the web and the MCP tool, returns the stored result instead of recomputing.

Whatever's left goes to the model with a tight prompt and hard output caps. Images are read by the vision model rather than local OCR; it copes better with glare, skew, and photocopies. Tesseract only steps in when the provider itself errors.

The fun part is the logs. The skip and cache-hit lines outnumber the model calls by a wide margin, which is the whole point.

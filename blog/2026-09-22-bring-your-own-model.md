# Bring your own model

The model that reads receipts in [Expense](https://expense.labnotes.org/?ref=labnotes.org) is now a setting, not a fact of the codebase. It ships with DeepSeek, but any OpenAI-compatible endpoint works: point `LLM_BASE_URL` and `LLM_API_KEY` at your provider and everything else stays the same. `LLM_MODEL` picks the text model, `LLM_VISION_MODEL` the one that reads receipt images, `LLM_MAX_TOKENS` caps output.

Why bother? Price, mostly. Extraction calls are small but they add up, and providers differ by an order of magnitude for what is, honestly, a simple job. Privacy is the other one: some people would rather their receipts go to a provider they chose, even self-hosted. And there's the redundancy argument: when a provider has a bad week, you change a URL and move on.

One warning if you switch to a reasoning model: their thinking tokens count against the output cap, so raise `LLM_MAX_TOKENS` or extractions come back truncated. The app sends thinking-disabled in every request, but not every provider honors that identically.

The default stays DeepSeek's flash model. It's cheap, it's fast, and for turning a receipt into four fields it's more than enough. The point of the setting is that "more than enough" is now your call to make.

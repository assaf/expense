import PostalMime from "postal-mime";
import type { Email as ParsedEmail } from "postal-mime";
import type {
  AttachmentMeta,
  InboundDeps,
  ReceivedEmail,
} from "~/lib/inbound-email.server";

/**
 * Shared PostalMime adapter behind the two inbound pipelines' JMAP fetch
 * collaborators (fetchReceivedEmail / listAttachments / downloadAttachment).
 *
 * Those collaborators are called repeatedly for the same email (and fetch +
 * list run concurrently in the pipelines), so the raw download and MIME
 * parse are memoized per cache key. Entries expire after PARSE_TTL_MS and
 * the cache is size-capped; destroyed emails are invalidated immediately by
 * the owning module.
 *
 * The transports differ only in (a) how a raw email is fetched, (b) how the
 * cache key is derived from an email id, and (c) the error message when an
 * attachment id wasn't produced by that transport — all three are injected
 * by `mimeFetchDeps`.
 */

/** The raw-email metadata both transports produce (fastmail.server's
 * RawEmail and email-connection-mail's RawConnectionEmail share the shape). */
interface MimeInboundRawEmail {
  raw: Buffer;
  receivedAt: string;
  subject: string;
  from: string | null;
  to: string[];
  messageId: string;
}

/** The one mailbox operation the shared MIME machinery needs. */
export interface MimeInboundAdapter {
  rawEmail(id: string): Promise<MimeInboundRawEmail>;
}

interface ParsedEntry {
  raw: MimeInboundRawEmail;
  email: ParsedEmail;
  fetchedAt: number;
}

const PARSE_TTL_MS = 10 * 60_000;
const PARSE_CACHE_MAX = 20;

function toBytes(content: ArrayBuffer | Uint8Array | string): Buffer {
  return Buffer.from(content as ArrayBuffer);
}

/** One TTL+LRU parse cache per transport module. Keys must be unique across
 * everything sharing an instance — connected accounts namespace theirs with
 * `${connectionId}:${emailId}`; the FastMail transport uses the raw id. */
export interface MimeInboundCache {
  parsedEmail(
    key: string,
    id: string,
    adapter: MimeInboundAdapter,
  ): Promise<ParsedEntry>;
  /** Drop one cache entry (destroyed / trashed emails). */
  invalidate(key: string): void;
  /** Clear everything (test hook; also used after setup changes). */
  clear(): void;
}

export function createMimeInboundCache(): MimeInboundCache {
  const parseCache = new Map<string, Promise<ParsedEntry>>();
  return {
    async parsedEmail(key, id, adapter) {
      const existing = parseCache.get(key);
      if (existing) {
        const entry = await existing;
        if (Date.now() - entry.fetchedAt < PARSE_TTL_MS) return entry;
        parseCache.delete(key);
      }
      const promise = (async () => {
        const raw = await adapter.rawEmail(id);
        const email = await PostalMime.parse(raw.raw);
        return { raw, email, fetchedAt: Date.now() };
      })();
      if (parseCache.size >= PARSE_CACHE_MAX) {
        const oldest = parseCache.keys().next().value;
        if (oldest !== undefined) parseCache.delete(oldest);
      }
      parseCache.set(key, promise);
      return promise;
    },
    invalidate: (key) => {
      parseCache.delete(key);
    },
    clear: () => {
      parseCache.clear();
    },
  };
}

export function headerRecord(
  headers: ParsedEmail["headers"],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) out[h.key] = h.value;
  return out;
}

/** Fastmail `contentId` may carry angle brackets; HTML references use `cid:` without them. */
function normalizeContentId(contentId: string | undefined): string | null {
  if (!contentId) return null;
  return contentId.replace(/^<|>$/g, "");
}

/** Attachment metadata for one MIME part; `id` encodes `emailId:index` so
 * downloadAttachment can resolve the blob without a second JMAP call. */
function attachmentMeta(
  emailId: string,
  attachment: ParsedEmail["attachments"][number],
  index: number,
): AttachmentMeta {
  return {
    id: `${emailId}:${index}`,
    filename: attachment.filename ?? `attachment-${index + 1}`,
    size: toBytes(attachment.content).byteLength,
    content_type: attachment.mimeType,
    content_disposition: attachment.disposition,
    content_id: normalizeContentId(attachment.contentId),
    download_url: null,
    expires_at: null,
  };
}

/** Build the three fetch collaborators over one adapter + cache. The cache
 * is shared per transport module; `adapter` is bound per InboundDeps so
 * tests can inject fakes exactly as before. */
export function mimeFetchDeps(
  cache: MimeInboundCache,
  adapter: MimeInboundAdapter,
  options: {
    /** Cache-key derivation from an email id: the FastMail transport uses
     * the raw id; connected accounts namespace `${connectionId}:${emailId}`. */
    cacheKey(emailId: string): string;
    /** Error suffix when an attachment id doesn't decode as `emailId:index`. */
    foreignAttachmentSuffix: string;
  },
): Pick<
  InboundDeps,
  "fetchReceivedEmail" | "listAttachments" | "downloadAttachment"
> {
  const parsed = (emailId: string) =>
    cache.parsedEmail(options.cacheKey(emailId), emailId, adapter);
  return {
    fetchReceivedEmail: async (emailId): Promise<ReceivedEmail> => {
      const { raw, email } = await parsed(emailId);
      return {
        id: emailId,
        from: raw.from ?? "",
        to: raw.to,
        subject: email.subject ?? raw.subject,
        html: email.html ?? null,
        text: email.text ?? null,
        headers: headerRecord(email.headers),
        created_at: raw.receivedAt,
        message_id: email.messageId ?? raw.messageId,
      };
    },
    listAttachments: async (emailId): Promise<AttachmentMeta[]> => {
      const { email } = await parsed(emailId);
      return email.attachments.map((a, index) =>
        attachmentMeta(emailId, a, index),
      );
    },
    downloadAttachment: async (meta): Promise<Buffer> => {
      const m = /^(.+):(\d+)$/.exec(meta.id ?? "");
      if (!m) {
        throw new Error(
          `Cannot resolve attachment "${meta.id}" — ${options.foreignAttachmentSuffix}`,
        );
      }
      const { email } = await parsed(m[1]!);
      const attachment = email.attachments[Number(m[2]!)];
      if (!attachment) throw new Error(`Attachment ${meta.id} not found`);
      return toBytes(attachment.content);
    },
  };
}

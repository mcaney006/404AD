import type { Request, Response } from "./protocol";

/**
 * Typed wrapper around `chrome.runtime.sendMessage`.
 *
 * Chrome resolves the promise with `undefined` and sets `lastError` when the
 * service worker is asleep or has thrown. Surfacing that as a rejection means
 * callers cannot accidentally treat a dropped message as an empty result.
 */
export async function send<T extends Request>(message: T): Promise<Response<T["type"]>> {
  const reply = (await chrome.runtime.sendMessage(message)) as
    | { ok: true; data: Response<T["type"]> }
    | { ok: false; error: string }
    | undefined;

  if (chrome.runtime.lastError) {
    throw new Error(chrome.runtime.lastError.message ?? "message failed");
  }
  if (reply === undefined) {
    throw new Error(`404AD: no response to ${message.type}`);
  }
  if (!reply.ok) {
    throw new Error(reply.error);
  }
  return reply.data;
}

/** Best-effort send for fire-and-forget notifications from content scripts. */
export function notify<T extends Request>(message: T): void {
  void chrome.runtime.sendMessage(message).catch(() => {
    // The worker may be restarting. A dropped counter update is not worth
    // retrying, and is certainly not worth an unhandled rejection.
  });
}

// Optional request features the server may reject. If a request fails with an error mentioning one
// that's still on (and, with `when`, that the request actually carried), it's switched off for the
// session and the request retried without it. `caps` entries switch off state.caps[key].
// Pure, so it is unit tested under Node.
//
// Media entries come first (their errors often mention "tool" or "content" too) and are stricter:
// switching vision or documents off is sticky and wrong if the failure was really a proxy page,
// a crash while processing an image, or a too-large request.

export const FALLBACKS = [
  { key: 'toolImages', media: true, when: (u) => u.toolImages, match: /image|content|multimodal|array/i },
  { key: 'documents', media: true, caps: true, when: (u) => u.files, match: /file|document|content|type/i, notice: 'This server can’t read attached files, so text files are sent inline and other files are skipped.' },
  { key: 'vision', media: true, caps: true, when: (u) => u.images, match: /image|vision|multimodal|mmproj/i, notice: 'This model doesn’t accept images, so images and screenshots are off for this session.' },
  { key: 'toolsSupported', match: /tool|jinja|function.?call/i, notice: 'This server doesn’t accept tool calls, so widgets and panes are off for this session.' },
  { key: 'sendReasoning', match: /reasoning/i },
  { key: 'requestUsage', match: /stream_options|include_usage/i },
];

const HTML_PAGE = /^\s*<|<html|<!doctype/i;
const NOT_A_CAPABILITY = /context|too (long|large)|exceed|out of memory|\boom\b|timeout|timed out/i;

/** Whether an error can mean "this server rejects that kind of media" (a 4xx stating a reason). */
function mediaRejection(err) {
  return err.status >= 400 && err.status < 500 && err.status !== 413
    && !HTML_PAGE.test(err.message) && !NOT_A_CAPABILITY.test(err.message);
}

/**
 * The fallback to apply for a failed request, or null.
 * @param {Error & {status?:number}} err
 * @param {{images:boolean, toolImages:boolean, files:boolean}} used media the request carried
 * @param {(f:object) => boolean} isOn whether a fallback's feature is still on
 */
export function fallbackFor(err, used, isOn) {
  if (!(err.status >= 400 && err.status < 600)) return null;
  return FALLBACKS.find((f) => isOn(f)
    && (!f.when || f.when(used))
    && (!f.media || mediaRejection(err))
    && f.match.test(err.message)) || null;
}

import { THREAD_READER_MARKER } from '../../src/inbox/thread-read';

/** Wrap an OpenRouter mock so thread-reader calls get `reading` (default: null,
 *  which makes the reader give up and the old path run) and never reach, or
 *  shift, the wrapped mock's own call sequence. */
export function withReader(inner: typeof fetch, reading: unknown = null): typeof fetch {
  return (async (url: string, init: RequestInit) => {
    if (String(url).includes('openrouter')) {
      const sys = JSON.parse(String(init.body)).messages?.[0]?.content ?? '';
      if (sys.startsWith(THREAD_READER_MARKER)) {
        const content = reading === null ? '{"senderRole":"invalid"}' : JSON.stringify(reading);
        return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { cost: 0 } }), { status: 200 });
      }
    }
    return inner(url as any, init);
  }) as unknown as typeof fetch;
}

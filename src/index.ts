// Minimal entry so the Workers test pool can initialize.
// Replaced by the full Hono app in Task 12.
export default {
  async fetch(): Promise<Response> {
    return new Response('PawScout Worker (foundation)');
  }
};

const handlers = new Map();

export const bus = {
  on(event, handler) {
    if (!handlers.has(event)) handlers.set(event, new Set());
    handlers.get(event).add(handler);
    return () => this.off(event, handler);
  },
  off(event, handler) {
    handlers.get(event)?.delete(handler);
  },
  async emit(event, payload) {
    const list = [...(handlers.get(event) || [])];
    const results = [];
    for (const handler of list) {
      try {
        results.push(await handler(payload));
      } catch (err) {
        console.error(`[bus] ${event}`, err);
      }
    }
    return results;
  },
};

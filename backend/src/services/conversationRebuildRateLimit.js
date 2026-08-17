import { RateLimiterMemory } from 'rate-limiter-flexible';

const limiter = new RateLimiterMemory({ points: 2, duration: 60 });

export async function consumeConversationRebuildRateLimit(userId) {
  try { await limiter.consume(userId); }
  catch { const error = new Error('Conversation rebuild rate limit exceeded'); error.statusCode = 429; throw error; }
}

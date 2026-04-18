import type { Handler } from '../types.js';

const FIVE_MINUTES = 5 * 60 * 1000;

export const pulseHandler: Handler = {
  name: 'pulse',
  trigger: (state) => {
    if (state.lastFiredAt === null) return true;
    return state.now - state.lastFiredAt >= FIVE_MINUTES;
  },
  run: async () => ({
    skip: true,
    reason: `alive at ${new Date().toISOString()}`,
  }),
};

// Complexity drives both the model and how many turns an agent plans ahead.

export interface ModelPolicy {
  small: string; // complexity 1–2
  large: string; // complexity 3–5
}

export const modelFor = (complexity: number, policy: ModelPolicy) => (complexity <= 2 ? policy.small : policy.large);

export const lookaheadFor = (complexity: number) => (complexity <= 2 ? 1 : complexity === 3 ? 2 : 4);

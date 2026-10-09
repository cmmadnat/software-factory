// Spend accounting, independent of which backend produced it.

export interface Usage {
  tokensIn: number;
  tokensOut: number;
  premiumRequests: number;
  nanoAiu: number;
  costUsd: number;
}

export const zeroUsage = (): Usage => ({ tokensIn: 0, tokensOut: 0, premiumRequests: 0, nanoAiu: 0, costUsd: 0 });

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    tokensIn: a.tokensIn + b.tokensIn,
    tokensOut: a.tokensOut + b.tokensOut,
    premiumRequests: a.premiumRequests + b.premiumRequests,
    nanoAiu: a.nanoAiu + b.nanoAiu,
    costUsd: a.costUsd + b.costUsd,
  };
}

export const usdFromNanoAiu = (nanoAiu: number, usdPerAiu: number) => (nanoAiu / 1e9) * usdPerAiu;

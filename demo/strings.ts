// Demo strings. docs/copy.md is the single source: every value in COPY appears verbatim in its
// "Demo strings" section (noJs in "Widget strings"), and resultsFor follows the copy.md pattern
// `N result(s) for "query"` (singular at 1). tests/copy.test.ts checks all of it.

export const COPY = {
  // Top bar and mode tag
  brand: "Toll demo",
  navForms: "Forms",
  navHammer: "Bot hammer",
  navAgent: "Agent hammer",
  modeWorkOnly: "work-only",
  modePaymentsOn: "test payments on",
  modePaymentsPaused: "test payments paused",
  // Forms page
  introTitle: "Every form on this page is protected",
  introLede: "Use them like a normal visitor. Each one runs an invisible check in the background, and the counts on the right update as you go. Then try the same endpoint without a pass.",
  liveStats: "Live stats",
  contact: "Contact",
  contactSub: "A write. Gated as",
  comments: "Comments",
  commentsSub: "In-memory thread. Gated as write; your pass covers about 20 comments for 15 minutes.",
  addComment: "Add a comment",
  postComment: "Post comment",
  search: "Search",
  searchSub: "A search that POSTs. Gated as search (cheaper than a write).",
  noPassTitle: "Try it without a pass",
  noPassSub: "The same contact endpoint, called the way a script would.",
  noPassButton: "Send without a pass",
  rejected403: "✕ Rejected · 403",
  name: "Name",
  email: "Email",
  message: "Message",
  send: "Send",
  sentPill: "✓ Accepted · 200",
  // Stats (phase 1)
  statAccepted: "Accepted",
  statRejected: "Rejected",
  statMeanSolve: "Mean solve time",
  // Stats and owner block (phase 2)
  statPaid: "Paid requests",
  statCollected: "Usage value collected",
  siteOwner: "Site owner",
  payoutsLabel: "Collect usage payouts",
  payoutsHelp: "High-volume clients can pay per request. You withdraw from the dashboard.",
  // Template: {fee} = fee_bps / 100, trailing zeros dropped (copy.md "Money"; fillFee in settlement-ln)
  balanceCaption: "available to withdraw · after the {fee}% platform fee",
  // From copy.md "Money": what the demo shows when the USD rate is unavailable
  rateUnavailable: "Rate unavailable",
  // Hammer page
  hammerTitle: "Bot hammer",
  hammerLede: "Fire 50 writes at the contact endpoint, first as a script that skips the check, then through the widget's background worker. Each square is one request.",
  runWithout: "50 writes without the check",
  runWith: "50 writes with the check",
  runWithoutSub: "Plain POSTs, no worker, no pass.",
  runWithSub: "Each request solves in the worker first, like a visitor's browser.",
  run50: "Run 50",
  accepted: "accepted",
  rejected: "rejected",
  meanSolve: "mean solve",
  legendAccepted: "✓ accepted",
  legendRejected: "✕ rejected",
  legendPending: "not sent yet",
  agentSub: "An automated client sends 20 writes with no widget. It pays each request instead of doing the work, using the test payment backend.",
  agentPaid: "paid requests",
  agentCollected: "usage value collected",
  agentReplayedMany: "replayed payments rejected",
  agentReplayedOne: "replayed payment rejected",
  // Shared with the widget (copy.md "Widget strings")
  noJs: "This form needs JavaScript.",
} as const;

/** copy.md: search line `N result(s) for "query"`, singular at 1. */
export const resultsFor = (n: number, q: string) => `${n} result${n === 1 ? "" : "s"} for "${q}"`;

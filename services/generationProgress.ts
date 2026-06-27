// Unified generation-progress contract (HWK-A5).
//
// The copilot has four generation paths that historically each carried their own
// callback/return shape — the "generate by a different engine here or there"
// inconsistency the PO called out:
//
//   1. stageChat  (services/governanceChat.ts → agentOrchestrator `StreamCallbacks`):
//        onThought(text) · onAnswer(text) · onDone(full) · onError(err)
//   2. /ask       (services/copilotClient.ts `AskCallbacks`):
//        onSources(srcs) · onAnswer(text) · onDone(full) · onError(err)
//   3. /draft     (services/copilotClient.ts `draftStream` → `DraftProgressEvent`):
//        progress(stage, done, total)   [HWK-A1] → rendered as a step timeline [HWK-A2]
//   4. web-research (services/geminiService.ts `generateGroundedDocument`):
//        returns a GroundedDoc (no streaming today)
//
// This module defines ONE event shape (`ProgressEvent`) that every path can emit,
// plus thin adapters so a caller writes a single handler and routes any path
// through it. Paths are migrated incrementally; stageChat and /ask are migrated
// first (see GovCopilot). The remaining paths (/draft already emits structured
// `step` events; web-research) converge onto this contract as they are touched.
import type { StreamCallbacks } from './agentOrchestrator';
import type { AskCallbacks, CopilotSource } from './copilotClient';

export type ProgressEvent =
  | { type: 'thought'; text: string }                              // a reasoning fragment
  | { type: 'delta'; text: string }                                // a final-answer fragment
  | { type: 'sources'; items: CopilotSource[] }                    // grounding sources
  | { type: 'step'; stage: string; done: number; total: number }   // a long-run stage [A1/A2]
  | { type: 'done'; text: string }
  | { type: 'error'; err: unknown };

export type GenerationProgressHandler = (ev: ProgressEvent) => void;

// Adapt the unified handler to the stageChat / agentOrchestrator `StreamCallbacks` shape.
export function toStreamCallbacks(h: GenerationProgressHandler): StreamCallbacks {
  return {
    onThought: text => h({ type: 'thought', text }),
    onAnswer: text => h({ type: 'delta', text }),
    onDone: text => h({ type: 'done', text }),
    onError: err => h({ type: 'error', err }),
  };
}

// Adapt the unified handler to the /ask `AskCallbacks` shape.
export function toAskCallbacks(h: GenerationProgressHandler): AskCallbacks {
  return {
    onSources: items => h({ type: 'sources', items }),
    onAnswer: text => h({ type: 'delta', text }),
    onDone: text => h({ type: 'done', text }),
    onError: err => h({ type: 'error', err }),
  };
}

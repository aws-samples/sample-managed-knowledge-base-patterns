/** Wait for a retrieval instruction's content review. The SDK has no waiter for this resource. */

import {
  type BedrockAgentClient,
  GetRetrievalInstructionCommand,
  type GetRetrievalInstructionResponse,
} from '@aws-sdk/client-bedrock-agent';
import { progress } from './output';

export const IN_PROGRESS: readonly string[] = ['CREATING', 'UPDATING'];
export const INTERVAL_S = 2;
export const TIMEOUT_S = 600;

export type Sleep = (seconds: number) => Promise<void>;
export type Clock = () => number;

export const sleep: Sleep = (seconds) =>
  new Promise((resolve) => setTimeout(resolve, seconds * 1000));
export const monotonic: Clock = () => performance.now() / 1000;

export interface Review {
  final: GetRetrievalInstructionResponse; // the last GetRetrievalInstruction response
  elapsedS: number;
  timedOut: boolean;
}

export interface WaitOptions {
  first?: GetRetrievalInstructionResponse;
  timeoutS?: number;
  intervalS?: number;
  sleep?: Sleep;
  clock?: Clock;
}

export type Wait = (
  agent: BedrockAgentClient,
  instructionId: string,
  options?: WaitOptions,
) => Promise<Review>;

export function inProgress(response: GetRetrievalInstructionResponse): boolean {
  return IN_PROGRESS.includes(String(response.lastTransitionStatus));
}

/** Poll every `intervalS` until lastTransitionStatus is no longer CREATING or UPDATING, or time runs out. */
export const waitForReview: Wait = async (agent, instructionId, options = {}) => {
  const timeoutS = options.timeoutS ?? TIMEOUT_S;
  const intervalS = options.intervalS ?? INTERVAL_S;
  const pause = options.sleep ?? sleep;
  const clock = options.clock ?? monotonic;
  const get = () =>
    agent.send(
      new GetRetrievalInstructionCommand({ retrievalInstructionId: instructionId }),
    );
  const start = clock();
  let current = options.first ?? (await get());
  for (;;) {
    const elapsed = clock() - start;
    if (!inProgress(current))
      return { final: current, elapsedS: elapsed, timedOut: false };
    if (elapsed >= timeoutS)
      return { final: current, elapsedS: elapsed, timedOut: true };
    progress(
      `waiting for review: ${current.lastTransitionStatus}, ${Math.trunc(elapsed)} s`,
    );
    await pause(intervalS);
    current = await get();
  }
};

/** Each review reason as `fieldName: code: message`. */
export function reasons(final: GetRetrievalInstructionResponse): string[] {
  return (final.lastTransitionStatusReasons ?? []).map((r) =>
    [r.fieldName, r.code, r.message].filter((part) => part).join(': '),
  );
}

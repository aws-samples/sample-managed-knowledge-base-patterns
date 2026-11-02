/**
 * AgenticRetrieveStream requests and the stream reader.
 *
 * There are two senders. `askAsTenant()` is the post's snippet, for a request with a tenant line
 * and a pinned version. `sendRequest(buildRequest(...))` sends everything else. Both take a filter
 * only as a `TenantFilter` from tenancy.ts, and both return a `StreamResult` from `readStream()`.
 */

import {
  AgenticRetrieveStreamCommand,
  type AgenticRetrieveStreamCommandInput,
  type AgenticRetrieveStreamResponseOutput,
  type AgenticRetrieveTraceEventAttributes,
  type BedrockAgentRuntimeClient,
  BedrockAgentRuntimeServiceException,
} from '@aws-sdk/client-bedrock-agent-runtime';
import { keyFromExpansionMessage, keyFromSourceUri } from './corpus';
import type { TenantFilter, TenantRequest } from './tenancy';

export const MAX_RETRIEVERS = 5;

export interface RetrievedDocument {
  step: string; // "SpeculativeRetrieval", "Retrieval", "FullDocumentExpansion", or "result"
  key: string | null; // S3 key such as "docs/global/global-returns-policy-v2-0.md"; null when the event names none
  retriever: string | null; // knowledge base ID that returned it; null when the event doesn't say
}

export interface StreamResult {
  applied: { id?: string; version?: string } | null; // appliedInstruction of the first Planning trace event
  answer: string | null; // result.generatedResponse.answer; null when absent or empty
  responseText: string; // responseEvent.text chunks, joined in order
  documents: RetrievedDocument[]; // in stream order
  error: { code: string; message: string } | null; // an exception event raised mid-stream
  planning: Record<string, unknown> | null; // attributes of the first Planning trace event, for ask --trace
}

export interface StreamResponse {
  stream?: AsyncIterable<AgenticRetrieveStreamResponseOutput> | undefined;
}

export interface RequestOptions {
  question: string;
  retrievers: readonly (readonly [string, TenantFilter | null])[]; // [knowledge base ID, filter or null]
  tenantLine: string | null;
  instructionId: string | null;
  version: string | null;
  generateResponse?: boolean;
}

/** One request: the tenant line before the question, a filter per retriever, and the pinned instruction. */
export function buildRequest(
  options: RequestOptions,
): AgenticRetrieveStreamCommandInput {
  const { question, retrievers, tenantLine, instructionId, version } = options;
  if (retrievers.length < 1 || retrievers.length > MAX_RETRIEVERS) {
    throw new RangeError(`a request takes 1 to ${MAX_RETRIEVERS} retrievers`);
  }
  const text = tenantLine ? `${tenantLine}\n${question}` : question;
  const request: AgenticRetrieveStreamCommandInput = {
    messages: [{ role: 'user', content: { text } }],
    retrievers: retrievers.map(([knowledgeBaseId, tenantFilter]) => ({
      configuration: {
        knowledgeBase:
          tenantFilter === null
            ? { knowledgeBaseId }
            : { knowledgeBaseId, retrievalOverrides: { filter: tenantFilter } },
      },
    })),
    agenticRetrieveConfiguration: {
      foundationModelType: 'MANAGED',
      rerankingModelType: 'MANAGED',
    },
  };
  if (instructionId !== null) {
    request.retrievalInstructionConfiguration =
      version === null // omit version for DRAFT
        ? { retrievalInstructionId: instructionId }
        : { retrievalInstructionId: instructionId, version };
  }
  if (options.generateResponse === false) request.generateResponse = false;
  return request;
}

export async function sendRequest(
  runtime: BedrockAgentRuntimeClient,
  request: AgenticRetrieveStreamCommandInput,
): Promise<StreamResult> {
  const response = await runtime.send(new AgenticRetrieveStreamCommand(request));
  return readStream(response);
}

/** Answer as the tenant: its instruction at the pinned version, its tenant line, and its filter. */
export async function askAsTenant(
  runtime: BedrockAgentRuntimeClient,
  req: TenantRequest,
  knowledgeBaseId: string,
  question: string,
): Promise<StreamResult> {
  const { tenantFilter, tenantLine, instructionId, version } = req;
  if (tenantLine === null || version === null) {
    throw new RangeError(
      'askAsTenant needs a tenant line and a pinned version; use sendRequest(buildRequest())',
    );
  }
  const knowledgeBase = {
    knowledgeBaseId,
    retrievalOverrides: { filter: tenantFilter },
  };
  const response = await runtime.send(
    new AgenticRetrieveStreamCommand({
      messages: [{ role: 'user', content: { text: `${tenantLine}\n${question}` } }],
      retrievers: [{ configuration: { knowledgeBase } }],
      agenticRetrieveConfiguration: {
        foundationModelType: 'MANAGED',
        rerankingModelType: 'MANAGED',
      },
      // omit version for DRAFT
      retrievalInstructionConfiguration: {
        retrievalInstructionId: instructionId,
        version,
      },
    }),
  );
  return readStream(response);
}

type Attributes = Partial<AgenticRetrieveTraceEventAttributes>;

/** Record the documents a trace event or the result names, in stream order. */
function collect(
  out: StreamResult,
  event: AgenticRetrieveStreamResponseOutput,
  attrs: Attributes,
): void {
  const step = attrs.step;
  if (step) {
    for (const item of attrs.retrievalResponse ?? []) {
      out.documents.push({
        step,
        key: keyFromSourceUri(item.metadata?._source_uri),
        retriever: item.sourceRetriever?.identifier ?? null,
      });
    }
    if (step === 'FullDocumentExpansion' && attrs.status === 'IN_PROGRESS') {
      out.documents.push({
        step,
        key: keyFromExpansionMessage(attrs.message),
        retriever: attrs.retrievalMetadata?.[0]?.identifier ?? null,
      });
    }
  }
  for (const item of event.result?.results ?? []) {
    out.documents.push({
      step: 'result',
      key: keyFromSourceUri(item.metadata?._source_uri),
      retriever: item.sourceRetriever?.identifier ?? null,
    });
  }
}

/** Read the applied instruction, the answer, the documents, and any in-stream exception. */
export async function readStream(response: StreamResponse): Promise<StreamResult> {
  const out: StreamResult = {
    applied: null,
    answer: null,
    responseText: '',
    documents: [],
    error: null,
    planning: null,
  };
  let applied: StreamResult['applied'] = null;
  let answer: string | undefined;
  try {
    for await (const event of response.stream ?? []) {
      const attrs: Attributes = event.traceEvent?.attributes ?? {};
      if (attrs.step === 'Planning' && applied === null) {
        applied = attrs.appliedInstruction ?? null; // log with the tenant ID
      }
      if (event.result !== undefined) answer = event.result.generatedResponse?.answer;
      if (attrs.step === 'Planning' && out.planning === null)
        out.planning = { ...attrs };
      if (event.responseEvent !== undefined)
        out.responseText += event.responseEvent.text ?? '';
      collect(out, event, attrs);
    }
  } catch (err) {
    if (!(err instanceof BedrockAgentRuntimeServiceException)) throw err;
    out.error = { code: err.name, message: err.message };
  }
  out.applied = applied;
  out.answer = typeof answer === 'string' && answer.trim() ? answer : null;
  return out;
}

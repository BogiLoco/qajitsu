export type { AdapterDeps, Logger } from "./common.js";
export type { BugDraft, BugMatch, BugSearch, BugTracker } from "./bug-tracker.js";
export type {
  ChangeLocator,
  ChangeRef,
  ChangeRequest,
  ChangeTarget,
  CodeHost,
  CommitStatus,
  ReviewComment,
} from "./code-host.js";
export type { EnvProvider, EnvironmentHandle, EnvironmentHealth } from "./env-provider.js";
export type { EvidenceEntry, EvidenceStore } from "./evidence-store.js";
export type {
  DocumentSource,
  Embedder,
  KnowledgeChunk,
  KnowledgeFile,
  KnowledgeHit,
  KnowledgeQuery,
  RemoteDocument,
  StoredChunk,
  VectorStore,
} from "./knowledge-store.js";
export type { CapturedMessage, CaseMessages, MessageCapture, MessageInbox } from "./message-capture.js";
export type { ModelCapabilities, ModelProvider, ResolvedModelHandle } from "./model-provider.js";
export type { PublishAttachment, PublishInput, PublishResult, Publisher } from "./publisher.js";
export type {
  AssertionRecord,
  AttemptExecutor,
  AttemptRecord,
  AttemptRequest,
  CaseAttempt,
  CaseRunResult,
  EvidenceItem,
  ImageComparison,
  ManualAnswer,
  ManualPrompter,
  ManualStepRequest,
  VisualCheck,
} from "./runner.js";
export type { SecretProvider } from "./secret-provider.js";
export type { DevelopmentLink, ReleaseQuery, ReleaseTicket, Ticket, TicketSource } from "./ticket-source.js";

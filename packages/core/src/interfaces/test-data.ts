/** A record created for one attempt of a case (REQ-EXEC-53/AC1). */
export interface TestDataRecord {
  /** The name the plan gives it, e.g. `lamp`. */
  readonly name: string;
  readonly kind: string;
  /** The application's id of the record, used to remove it. */
  readonly id: string;
  /** What the application answered, for the spec's `data.get(name)`; masked before it becomes evidence. */
  readonly record: Readonly<Record<string, unknown>>;
}

/**
 * Creates and removes the records cases need (REQ-EXEC-53), through the application's API or the project's data hook.
 * Every record carries a marker naming the run, case and attempt, so parallel cases never share or delete each
 * other's records.
 */
export interface TestDataProvider {
  /**
   * Creates one record.
   *
   * @throws When the record cannot be created; the attempt then ends before any step (BLOCKED).
   */
  create(request: {
    readonly name: string;
    readonly kind: string;
    readonly with: Readonly<Record<string, unknown>>;
    readonly marker: string;
  }): Promise<TestDataRecord>;
  /**
   * Removes one record created by this provider.
   *
   * @throws When it cannot be removed; the runner records a warning, never a status.
   */
  remove(record: TestDataRecord, marker: string): Promise<void>;
  /** Removes every record whose marker starts with `prefix` (leftovers of crashed runs); how many, when known. */
  cleanup(prefix: string): Promise<number | undefined>;
}

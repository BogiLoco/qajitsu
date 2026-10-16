/**
 * Waits for a promise while keeping the process alive (REQ-GEN-05/AC2). Signal listeners alone do not keep Node
 * running: with the application in containers there is no child process either, so `env up` would exit right after
 * starting and leave the containers without anyone to stop them on Ctrl+C.
 *
 * @param pending - What to wait for, e.g. the Ctrl+C of the person.
 * @returns What the promise resolves to.
 */
export async function holdUntil<T>(pending: Promise<T>): Promise<T> {
  const alive = setInterval(() => undefined, 1 << 30);
  try {
    return await pending;
  } finally {
    clearInterval(alive);
  }
}

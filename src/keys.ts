/** Single-keystroke input from the console. */
export function readKey(): Promise<string | null> {
  return new Promise((resolve) => {
    const stop = listenKeys((key) => {
      stop();
      resolve(key);
    });
  });
}

/**
 * Calls onKey for each printable keypress (Ctrl+C is reported as "q").
 * Enter and escape sequences such as arrow keys are ignored.
 * Returns a function that stops listening and restores the terminal.
 */
export function listenKeys(onKey: (key: string) => void): () => void {
  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  const handler = (chunk: string) => {
    if (chunk === "\x03") return onKey("q");
    if (chunk.startsWith("\x1b") || chunk === "\r" || chunk === "\n") return;
    onKey(chunk[0]);
  };
  stdin.on("data", handler);

  return () => {
    stdin.off("data", handler);
    stdin.setRawMode(false);
    stdin.pause();
  };
}

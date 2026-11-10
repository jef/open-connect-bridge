export interface StatusFields {
  source: string;
  watching: string;
  note: string;
  gspro: string | null;
  openConnect: string;
  shots: number;
  lastShot: string;
  simReply: string;
  lastError: string;
}

const CLEAR = "\x1b[H\x1b[2J";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

function row(label: string, value: string): string {
  return `  ${label.padEnd(14)}${value}`;
}

function setupSteps(source: string): string[] {
  if (source === "GSPconnect") return ["Open GSPconnect.exe."];
  if (source === "Foresight Premier") {
    return [
      "Run Foresight Premier.",
      "Log in, connect to the launch monitor, and open a Shot Analysis session.",
    ];
  }
  return [];
}

export function renderMenu(complaint = ""): string {
  const lines = [
    "Open Connect bridge",
    "",
    "Which app is connected to the launch monitor?",
    "",
    "  1  GSPconnect",
    "  2  Foresight Premier",
    "  Q  Exit",
    "",
  ];
  if (complaint) lines.push(`  ${complaint}`, "");
  return lines.join("\n");
}

/** One console view of the bridge state; falls back to plain log lines when not a TTY. */
export class Status implements StatusFields {
  source = "";
  watching = "";
  note = "";
  gspro: string | null = null;
  openConnect = "";
  shots = 0;
  lastShot = "none yet";
  simReply = "none";
  lastError = "none";

  private drawn = false;
  private cursorHidden = false;

  constructor(
    readonly enabled: boolean,
    private readonly write: (text: string) => void = (t) => void process.stdout.write(t),
    private readonly log: (line: string) => void = (l) => console.log(l),
    private readonly onChange: (fields: StatusFields) => void = () => undefined,
  ) {}

  show(fields: Partial<StatusFields> = {}, log?: string): void {
    let changed = false;
    for (const [key, value] of Object.entries(fields)) {
      const k = key as keyof StatusFields;
      if (this[k] !== value) {
        (this as Record<keyof StatusFields, unknown>)[k] = value;
        changed = true;
      }
    }
    if (this.enabled) {
      if (changed || !this.drawn) this.paint();
    } else if (log) {
      this.log(log);
    }
    if (changed) this.onChange(this.snapshot());
  }

  snapshot(): StatusFields {
    return {
      source: this.source,
      watching: this.watching,
      note: this.note,
      gspro: this.gspro,
      openConnect: this.openConnect,
      shots: this.shots,
      lastShot: this.lastShot,
      simReply: this.simReply,
      lastError: this.lastError,
    };
  }

  render(): string {
    const lines = ["Open Connect bridge", ""];
    const steps = setupSteps(this.source);
    if (steps.length) lines.push(...steps.map((s) => `  ${s}`), "");
    lines.push(row("Source", this.source), row("Watching", this.watching));
    if (this.note) lines.push(row("", this.note));
    if (this.gspro !== null) lines.push(row("GSPconnect", this.gspro));
    lines.push(
      row("Open Connect", this.openConnect),
      row("Shots sent", String(this.shots)),
      row("Last shot", this.lastShot),
      row("Sim reply", this.simReply),
      row("Last error", this.lastError),
      "",
      "  Q  Exit",
    );
    return lines.join("\n");
  }

  close(): void {
    if (this.cursorHidden) {
      this.write(SHOW_CURSOR);
      this.cursorHidden = false;
    }
  }

  private paint(): void {
    let hide = "";
    if (!this.cursorHidden) {
      hide = HIDE_CURSOR;
      this.cursorHidden = true;
    }
    this.write(CLEAR + hide + this.render() + "\n");
    this.drawn = true;
  }
}

export function paintMenu(text: string): void {
  process.stdout.write(CLEAR + text + "\n");
}

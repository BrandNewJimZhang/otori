// Bottom status bar: one line of ambient background state (scan >
// sweep > library stats), lowest visual priority in the window. The
// scan progress strip lives here too, so all background activity has
// exactly one home. Must read as ambient state, not activity theater.

export function StatusBar({ line, scanning }: { line: string; scanning: boolean }) {
  return (
    <footer className="status-bar" role="status">
      {scanning && <div className="scan-progress" role="progressbar" aria-label="Scanning" />}
      <span className="status-line">{line}</span>
    </footer>
  );
}

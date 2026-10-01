/* eslint-disable @typescript-eslint/no-explicit-any */
import type { RobotModelState } from '../hooks/useRobotModel';
import type { Theme } from '../hooks/useTheme';

interface HeaderProps {
  state: RobotModelState;
  theme: Theme;
  onToggleTheme: () => void;
  onOpenFile: () => void;
  onSaveFile: () => void;
  onLoadSample: () => void;
  onVerify: () => void;
}

function ThemeIcon({ theme }: { theme: Theme }) {
  if (theme === 'light') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M6 1.5a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 6 1.5Zm0 10.5a.75.75 0 0 1 .75.75v1a.75.75 0 0 1-1.5 0v-1A.75.75 0 0 1 6 12Zm5.78-8.28a.75.75 0 0 1 0 1.06l-.7.7a.75.75 0 1 1-1.06-1.06l.7-.7a.75.75 0 0 1 1.06 0ZM3.98 9.48a.75.75 0 0 1 0 1.06l-.7.7A.75.75 0 1 1 2.22 10.18l.7-.7a.75.75 0 0 1 1.06 0ZM13.5 7.25a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 1 0-1.5h1ZM3.5 7.25a.75.75 0 0 1 0 1.5h-1a.75.75 0 0 1 0-1.5h1Zm8.28 3.53a.75.75 0 0 1 1.06 0l.7.7a.75.75 0 1 1-1.06 1.06l-.7-.7a.75.75 0 0 1 0-1.06ZM3.98 3.22a.75.75 0 0 1 1.06 0l.7.7A.75.75 0 1 1 4.68 5l-.7-.7a.75.75 0 0 1 0-1.06ZM8 4.5a3.5 3.5 0 1 1 0 7 3.5 3.5 0 0 1 0-7Z"
          transform="translate(1 0)"
        />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <path
        fill="currentColor"
        d="M6.05 1.1a.75.75 0 0 1 .84.16A6.5 6.5 0 1 0 13.9 9.7a.75.75 0 0 1 1.07.9A8 8 0 1 1 5.2 1.03a.75.75 0 0 1 .85.07Z"
      />
    </svg>
  );
}

export function Header({
  state,
  theme,
  onToggleTheme,
  onOpenFile,
  onSaveFile,
  onLoadSample,
  onVerify,
}: HeaderProps) {
  const { model, allDiagnostics, isVerifying } = state;
  const errorCount = allDiagnostics.filter((d: any) => d.severity === 2).length;
  const warningCount = allDiagnostics.filter((d: any) => d.severity === 1).length;

  return (
    <header className="app-header">
      <div className="app-brand">
        <div className="app-brand-mark" aria-hidden="true">
          <span />
        </div>
        <div className="app-brand-text">
          <h1>691SIM</h1>
          <span>Circuit Simulator</span>
        </div>
      </div>

      <div className="toolbar toolbar-actions">
        <button
          type="button"
          className="btn btn-theme"
          onClick={onToggleTheme}
          title={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
          aria-label={theme === 'light' ? 'Switch to dark mode' : 'Switch to light mode'}
        >
          <ThemeIcon theme={theme === 'light' ? 'dark' : 'light'} />
          <span>{theme === 'light' ? 'Dark' : 'Light'}</span>
        </button>
        <button type="button" className="btn" onClick={() => state.newProject()}>
          New
        </button>
        <button type="button" className="btn" onClick={onOpenFile}>
          Open
        </button>
        <button type="button" className="btn" onClick={onSaveFile}>
          Save
        </button>
        <button type="button" className="btn" onClick={onLoadSample}>
          Sample
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onVerify}
          disabled={isVerifying}
        >
          {isVerifying ? (
            <span className="btn-loading">
              <span className="loading-pulse-dot" />
              Verifying
            </span>
          ) : (
            'Verify'
          )}
        </button>
      </div>

      <div className="toolbar toolbar-status">
        <span className="badge badge-ok badge-project">{model.name}</span>
        {errorCount > 0 && <span className="badge badge-error">{errorCount} errors</span>}
        {warningCount > 0 && <span className="badge badge-warning">{warningCount} warnings</span>}
        {errorCount === 0 &&
          warningCount === 0 &&
          allDiagnostics.length === 0 &&
          !isVerifying && <span className="badge badge-ok">Clear</span>}
      </div>

      <a
        className="github-credit"
        href="https://github.com/team691/691SIM"
        target="_blank"
        rel="noopener noreferrer"
      >
        GitHub
      </a>
    </header>
  );
}

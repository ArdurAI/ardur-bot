type IntegrationWindow = {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
  webContents: { send(channel: string, value: unknown): void };
};

export function integrationReturnId(value: string): string | null {
  const route = /^ardurbot:\/\/integrations(?:\/([a-zA-Z0-9_-]{1,160}))?\/?$/.exec(value);
  return route ? (route[1] ?? "") : null;
}

export function focusIntegration(window: IntegrationWindow | null, id: string) {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send("desktop.integrations.return", id);
}

export function registerIntegrationProtocol(app: {
  isPackaged: boolean;
  setAsDefaultProtocolClient(protocol: string): boolean;
}) {
  if (app.isPackaged) app.setAsDefaultProtocolClient("ardurbot");
}

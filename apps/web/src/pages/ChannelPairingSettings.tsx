import type { ChatProvider } from "@ardurbot/contracts";
import { CHANNEL_SCOPES } from "@ardurbot/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, Switch } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

export function ChannelPairingSettings() {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState<ChatProvider>("telegram");
  const [installations, setInstallations] = useState<
    Array<{ id: string; provider: ChatProvider; workspaceId: string; botId: string }>
  >([]);
  const [bots, setBots] = useState<Array<{ id: string; name: string }>>([]);
  const [installationId, setInstallationId] = useState("");
  const [botId, setBotId] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  const [botToken, setBotToken] = useState("");
  const [appToken, setAppToken] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [approvals, setApprovals] = useState(true);
  const [code, setCode] = useState("");
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    void Promise.all([rpc.channelPairing.installations(), rpc.bots.list()])
      .then(([rows, list]) => {
        setInstallations(rows);
        setBots(list);
        setBotId(rows[0]?.botId ?? list[0]?.id ?? "");
        setInstallationId(rows[0]?.id ?? "");
      })
      .catch(() => setError(true));
  }, [open]);
  async function pair() {
    setBusy(true);
    setError(false);
    setCode("");
    try {
      let id = installationId;
      if (!id) {
        const saved = await rpc.channelPairing.configure({
          provider,
          botId,
          workspaceId: provider === "telegram" ? "telegram" : workspaceId,
          botToken,
          ...(provider === "slack" ? { appToken } : {}),
          ...(provider === "telegram" && webhookUrl ? { webhookUrl, webhookSecret } : {}),
        });
        id = saved.id;
        setBotToken("");
        setAppToken("");
        setWebhookSecret("");
        setInstallations(await rpc.channelPairing.installations());
        setInstallationId(id);
      }
      const pairing = await rpc.channelPairing.start({
        installationId: id,
        botId,
        ...(approvals ? {} : { scopes: CHANNEL_SCOPES.filter((scope) => scope !== "approve") }),
      });
      setCode(pairing.code);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-3">
      <Button variant="outline" onClick={() => setOpen(!open)}>{t`Pair a chat account`}</Button>
      {open ? (
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            void pair();
          }}
        >
          {error ? (
            <p
              role="alert"
              className="text-destructive"
            >{t`Could not pair this account. Check its settings and try again.`}</p>
          ) : null}
          {installations.length ? (
            <NativeSelect
              aria-label={t`Chat bot`}
              value={installationId}
              onChange={(event) => {
                setInstallationId(event.target.value);
                const installation = installations.find((row) => row.id === event.target.value);
                if (installation) setBotId(installation.botId);
              }}
            >
              {installations.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.provider} · {item.workspaceId}
                </NativeSelectOption>
              ))}
              <NativeSelectOption value="">{t`Connect a chat bot`}</NativeSelectOption>
            </NativeSelect>
          ) : null}
          <NativeSelect
            aria-label={t`Bot`}
            required
            value={botId}
            onChange={(event) => setBotId(event.target.value)}
          >
            {bots.map((bot) => (
              <NativeSelectOption key={bot.id} value={bot.id}>
                {bot.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
          {!installationId ? (
            <>
              <NativeSelect
                aria-label={t`Chat service`}
                value={provider}
                onChange={(event) => {
                  setProvider(event.target.value as ChatProvider);
                  setBotToken("");
                  setAppToken("");
                }}
              >
                <NativeSelectOption value="telegram">Telegram</NativeSelectOption>
                <NativeSelectOption value="discord">Discord</NativeSelectOption>
                <NativeSelectOption value="slack">Slack</NativeSelectOption>
              </NativeSelect>
              {provider !== "telegram" ? (
                <Input
                  aria-label={t`Workspace or server ID`}
                  placeholder={t`Workspace or server ID`}
                  required
                  value={workspaceId}
                  onChange={(event) => setWorkspaceId(event.target.value)}
                />
              ) : null}
              <Input
                aria-label={t`Bot token`}
                placeholder={t`Bot token`}
                type="password"
                autoComplete="off"
                required
                value={botToken}
                onChange={(event) => setBotToken(event.target.value)}
              />
              {provider === "slack" ? (
                <Input
                  aria-label={t`App token`}
                  placeholder={t`App token`}
                  type="password"
                  autoComplete="off"
                  required
                  value={appToken}
                  onChange={(event) => setAppToken(event.target.value)}
                />
              ) : null}
            </>
          ) : null}
          <details>
            <summary>{t`Chat permissions`}</summary>
            <label className="flex items-center justify-between gap-3" htmlFor="chat-approvals">
              {t`Allow approvals once`}
              <Switch id="chat-approvals" checked={approvals} onCheckedChange={setApprovals} />
            </label>
          </details>
          {!installationId && provider === "telegram" ? (
            <details>
              <summary>{t`Webhook`}</summary>
              <Input
                aria-label={t`Webhook URL`}
                type="url"
                value={webhookUrl}
                onChange={(event) => setWebhookUrl(event.target.value)}
              />
              {webhookUrl ? (
                <Input
                  aria-label={t`Webhook secret`}
                  type="password"
                  autoComplete="off"
                  required
                  value={webhookSecret}
                  onChange={(event) => setWebhookSecret(event.target.value)}
                />
              ) : null}
            </details>
          ) : null}
          <Button type="submit" disabled={busy}>{t`Get pairing code`}</Button>
          {code ? (
            <div role="status">
              <p className="font-mono">{code}</p>
              <p className="text-sm text-muted-foreground">{t`Send this code to the bot in a private message. Expires in five minutes.`}</p>
            </div>
          ) : null}
        </form>
      ) : null}
    </div>
  );
}

import type { ComposerCommand } from "@ardurbot/core";
import { t } from "@lingui/core/macro";

export function commandDescription(command: ComposerCommand): string {
  if (command.kind !== "action") return command.description;
  switch (command.action) {
    case "new":
      return t`Start a new chat`;
    case "stop":
      return t`Stop the current run`;
    case "compare":
      return t`Compare bots`;
    case "remember":
      return t`Save a memory note`;
    case "routine":
      return t`Open routines`;
    case "skills":
      return t`Choose a taught skill`;
    case "model":
      return t`Change this bot’s pin`;
    case "settings":
      return t`Open Settings`;
    case "help":
      return t`Show slash commands`;
    case "chat-settings":
      return t`Chat Settings`;
    case "settings-general":
      return t`Settings: General`;
    case "settings-usage":
      return t`Settings: Usage`;
  }
}

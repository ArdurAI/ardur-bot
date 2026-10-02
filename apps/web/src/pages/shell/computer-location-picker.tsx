import type { NewBotLocation, RuntimeKind } from "@ardurbot/contracts";
import { runtimeNames, runtimeSupportsLocation } from "@ardurbot/contracts";
import { Button } from "@ardurbot/ui-web";
import { useLingui } from "@lingui/react/macro";

export function ComputerLocationPicker({
  value,
  onChange,
  hostAvailable,
  sandboxAvailable,
  runtimeKind = "pi",
  teamLocation,
  disabled = false,
}: {
  value: NewBotLocation;
  onChange: (location: NewBotLocation) => void;
  hostAvailable: boolean;
  sandboxAvailable: boolean;
  runtimeKind?: RuntimeKind;
  teamLocation?: NewBotLocation;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  const runtime = runtimeNames[runtimeKind];
  const supportsSandbox = runtimeSupportsLocation(runtimeKind, { kind: "docker" });
  return (
    <div data-testid="computer-location-picker" className="grid grid-cols-2 gap-2">
      {(["host", "sandbox"] as const).map((location) => {
        const reason =
          teamLocation && location !== teamLocation
            ? t`Choose Only this bot to use a different location from the Team computer.`
            : location === "host"
              ? !hostAvailable
                ? t`Connect the host service to choose This computer.`
                : null
              : !supportsSandbox
                ? t`Other locations are unavailable for ${runtime}. Choose This computer.`
                : !sandboxAvailable
                  ? t`Set up a container for isolated work.`
                  : null;
        return (
          <div key={location} className="space-y-2">
            <Button
              variant="outline"
              className="h-auto w-full whitespace-normal p-3 text-start aria-pressed:border-foreground/40"
              aria-label={location === "host" ? t`This computer` : t`Sandbox`}
              aria-pressed={value === location}
              disabled={disabled || Boolean(reason)}
              onClick={() => onChange(location)}
            >
              <span className="block space-y-1 text-sm">
                <span className="block font-medium">
                  {location === "host" ? t`This computer` : t`Sandbox`}
                </span>
                <span className="block font-normal text-muted-foreground">
                  {location === "host"
                    ? t`Runs as you; can use your files and signed-in tools`
                    : t`Separate home; can reach allowed network services and granted credentials.`}
                </span>
              </span>
            </Button>
            {reason ? <p className="text-sm text-muted-foreground">{reason}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

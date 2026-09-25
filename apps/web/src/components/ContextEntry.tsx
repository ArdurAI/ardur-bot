import type { ComponentProps } from "react";
import { lazy, Suspense } from "react";
import type {
  BotContext as BotContextComponent,
  RunContext as RunContextComponent,
} from "./Context";

const LazyBotContext = lazy(() =>
  import("./Context").then((module) => ({ default: module.BotContext })),
);
const LazyRunContext = lazy(() =>
  import("./Context").then((module) => ({ default: module.RunContext })),
);

export function BotContext(props: ComponentProps<typeof BotContextComponent>) {
  return (
    <Suspense fallback={null}>
      <LazyBotContext {...props} />
    </Suspense>
  );
}

export function RunContext(props: ComponentProps<typeof RunContextComponent>) {
  if (!props.run?.contextSnapshot && props.run?.routingRule !== "default") return null;
  return (
    <Suspense fallback={null}>
      <LazyRunContext {...props} />
    </Suspense>
  );
}

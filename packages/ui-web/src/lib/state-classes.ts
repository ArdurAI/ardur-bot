import { cn } from "./utils";

export function selectableRowClasses(selected: boolean, className?: string) {
  return cn(
    "outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
    selected ? "bg-accent text-foreground font-medium" : "text-foreground hover:bg-accent/50",
    className,
  );
}
